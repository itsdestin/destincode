package com.youcoded.app.skills

import android.util.Log
import com.youcoded.app.runtime.Bootstrap
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Installs Claude Code plugins to
 * ~/.claude/plugins/marketplaces/youcoded/plugins/<id>/ and wires them into
 * the four registries Claude Code v2.1+ reads (settings.json enabledPlugins,
 * installed_plugins.json, known_marketplaces.json, marketplace.json).
 *
 * Dropping files at ~/.claude/plugins/<id>/ is not enough — the CLI's
 * plugin loader iterates enabledPlugins from settings.json, not the
 * filesystem. See ClaudeCodeRegistry.kt for the full registry contract.
 *
 * Three source types are supported:
 * - "local": copy from a cached clone of the marketplace repo
 * - "url": git clone an external repository
 * - "git-subdir": git clone + sparse checkout a subdirectory
 */
class PluginInstaller(
    private val homeDir: File,
    private val bootstrap: Bootstrap,
    private val configStore: SkillConfigStore,
) {
    // Marketplace-installed plugins live at
    // ~/.claude/plugins/marketplaces/youcoded/plugins/<id>/, NOT the legacy
    // ~/.claude/plugins/<id>/. Claude Code's non-cache loader computes the
    // plugin path as <marketplaceInstallLocation>/<source> and errors if
    // that directory doesn't exist.
    private val pluginsDir = ClaudeCodeRegistry.youcodedPluginsDir(homeDir)
    private val pluginCacheDir = ClaudeCodeRegistry.pluginCacheDir(homeDir)
    private val cacheDir = File(homeDir, ".claude/youcoded-marketplace-cache")
    private val installsInProgress = mutableSetOf<String>()

    companion object {
        private const val TAG = "PluginInstaller"
        private const val GIT_TIMEOUT_SECONDS = 120L
        private const val MARKETPLACE_REPO = "https://github.com/anthropics/claude-plugins-official.git"
        private const val WECODED_MARKETPLACE_REPO = "https://github.com/itsdestin/wecoded-marketplace.git"

        // Decomposition v3 §9.4: rate-limit marketplace cache refreshes so
        // installs don't hammer GitHub but local-source packages still get
        // updates without requiring a YouCoded release.
        private const val CACHE_REFRESH_MS = 60L * 60L * 1000L // 1 hour

        // Decomposition v3 §9.5: postInstall runs arbitrary shell — only allow
        // it for entries whose sourceRef points to an org we control. `sourceMarketplace`
        // is NOT a trust boundary (comes from fetchable JSON, can be spoofed).
        private val TRUSTED_POSTINSTALL_ORGS = listOf("itsdestin/", "destinationunknown/")

        // Task B5 (Android port of upgradeFromLocal): plugin ids ultimately come
        // from BundledPlugins.IDS (fixed) or a marketplace index entry (external
        // JSON) — reject anything that isn't a safe path segment before it's used
        // to build a filesystem path.
        private val SAFE_ID_RE = Regex("^[a-zA-Z0-9_-]+$")

        /**
         * Phase 3a: Map sourceMarketplace to its git repo URL.
         * YouCoded/YouCoded local entries live in itsdestin/wecoded-marketplace
         * while Anthropic upstream entries live in anthropics/claude-plugins-official.
         */
        fun getMarketplaceRepo(sourceMarketplace: String?): String =
            if (sourceMarketplace == "youcoded" || sourceMarketplace == "youcoded-core")
                WECODED_MARKETPLACE_REPO
            else MARKETPLACE_REPO

        private fun getCacheRepoName(sourceMarketplace: String?): String =
            if (sourceMarketplace == "youcoded" || sourceMarketplace == "youcoded-core")
                "wecoded-marketplace"
            else "claude-plugins-official"
    }

    sealed class InstallResult {
        object Success : InstallResult()
        data class AlreadyInstalled(val via: String) : InstallResult()
        data class Failed(val error: String) : InstallResult()
        object InProgress : InstallResult()
    }

    /**
     * Install a plugin from a marketplace entry.
     * The entry must have: id, sourceType, sourceRef, and optionally sourceSubdir.
     */
    suspend fun install(entry: JSONObject): InstallResult = withContext(Dispatchers.IO) {
        val id = entry.optString("id")
        if (id.isEmpty()) return@withContext InstallResult.Failed("Missing plugin id")

        // Guard: already in progress
        synchronized(installsInProgress) {
            if (installsInProgress.contains(id)) return@withContext InstallResult.InProgress
            installsInProgress.add(id)
        }

        try {
            // Guard: already installed via Claude Code's /plugin install
            if (hasConflict(id)) {
                return@withContext InstallResult.AlreadyInstalled("Claude Code")
            }

            // Guard: already installed via YouCoded
            // Fix: accept the manifest at either ".claude-plugin/plugin.json" OR root
            // "plugin.json". Some plugins (incl. our bundled wecoded-themes-plugin and
            // wecoded-marketplace-publisher) ship the manifest at the root, and
            // ensurePluginJson() does NOT normalize when a root manifest exists ("Claude
            // Code will find it at root"). Without this dual-path check, every launch
            // missed the guard, re-ran installFromLocal, returned Success, fired
            // onPluginsChanged, and typed /reload-plugins into the active session.
            val targetDir = File(pluginsDir, id)
            if (isInstalledOnDisk(id)) {
                return@withContext InstallResult.AlreadyInstalled("YouCoded")
            }

            val sourceType = entry.optString("sourceType")
            val sourceRef = entry.optString("sourceRef")
            val sourceMarketplace = entry.optString("sourceMarketplace").takeIf { it.isNotEmpty() }

            val result = when (sourceType) {
                // Phase 3a: pass sourceMarketplace so the installer clones the right repo
                "local" -> installFromLocal(id, sourceRef, sourceMarketplace)
                "url" -> installFromUrl(id, sourceRef)
                "git-subdir" -> installFromGitSubdir(id, sourceRef, entry.optString("sourceSubdir"))
                else -> InstallResult.Failed("Unknown source type: $sourceType")
            }

            if (result is InstallResult.Success) {
                // Ensure .claude-plugin/plugin.json exists (some plugins use root plugin.json)
                ensurePluginJson(id, entry)
                // Decomposition v3 §9.5: run postInstall only if trusted. Failures
                // are logged but don't fail the install — files are already in place.
                if (isPostInstallTrusted(entry)) {
                    val cmd = entry.optString("postInstall")
                    val ok = runShell(cmd, targetDir)
                    if (!ok) Log.w(TAG, "postInstall failed for $id")
                }
                // Wire into the four Claude Code registries. Without this,
                // /reload-plugins ignores the plugin even though its files
                // are on disk. Matches desktop's PluginInstaller flow.
                try {
                    ClaudeCodeRegistry.registerPluginInstall(homeDir, ClaudeCodeRegistry.RegisterInput(
                        id = id,
                        installPath = targetDir.absolutePath,
                        version = entry.optString("version", "1.0.0"),
                        description = entry.optString("description").takeIf { it.isNotEmpty() },
                        author = entry.optJSONObject("author")?.optString("name")?.takeIf { it.isNotEmpty() },
                        category = entry.optString("category").takeIf { it.isNotEmpty() },
                    ))
                } catch (e: Exception) {
                    Log.w(TAG, "Claude Code registry write failed for $id — plugin may be invisible to /reload-plugins", e)
                }
                // Phase 3a: record as a PackageInfo carrying the marketplace version
                // so update detection can compare against the latest index.
                configStore.recordPackageInstall(id, JSONObject().apply {
                    put("version", entry.optString("version", "1.0.0"))
                    put("source", "marketplace")
                    put("installedAt", java.time.Instant.now().toString())
                    put("removable", true)
                    put("components", org.json.JSONArray().put(JSONObject().apply {
                        put("type", "plugin")
                        put("path", targetDir.absolutePath)
                    }))
                })
            }

            result
        } catch (e: Exception) {
            Log.e(TAG, "Install failed for $id", e)
            InstallResult.Failed(e.message ?: "Unknown error")
        } finally {
            synchronized(installsInProgress) {
                installsInProgress.remove(id)
            }
        }
    }

    /** Uninstall a marketplace-installed plugin. */
    suspend fun uninstall(id: String): Boolean = withContext(Dispatchers.IO) {
        try {
            val targetDir = File(pluginsDir, id)
            if (targetDir.exists()) {
                targetDir.deleteRecursively()
            }
            // Drop the plugin from the four Claude Code registries so
            // /reload-plugins stops trying to load a now-missing path.
            try { ClaudeCodeRegistry.unregisterPluginInstall(homeDir, id) } catch (e: Exception) {
                Log.w(TAG, "Claude Code registry unregister failed for $id", e)
            }
            configStore.removePluginInstall(id)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Uninstall failed for $id", e)
            false
        }
    }

    /** Check if a plugin is installed via YouCoded marketplace. */
    fun isInstalled(id: String): Boolean {
        val installed = configStore.getInstalledPlugins()
        return installed.has(id)
    }

    // Fix (review round 1, Finding 1): "is it installed?" must be answered from
    // disk, not the config-store record, wherever the answer feeds a decision
    // to install vs. upgrade. isInstalled() above trusts configStore, which can
    // drift from disk in both directions — a reset/restored config with a real
    // tree already present, or a crash mid-upgradeFromLocal leaving the record
    // present but the tree gone (parked at .old-<id> instead). Either drift was
    // previously PERMANENT: the install-missing branch re-hit this class's own
    // on-disk AlreadyInstalled guard and reported "failed" forever, or the
    // upgrade-compare branch read a null version and reported "unchanged"
    // forever. Asking the disk directly lets a half-finished swap heal itself
    // on the very next launch. Do not use this to replace isInstalled() — that
    // has other callers that intentionally want the config-store's record.
    fun isInstalledOnDisk(id: String): Boolean {
        val dir = File(pluginsDir, id)
        // Fix (review round 2): route through the same manifest predicate
        // listInstalledPluginDirs() now uses, so "installed" can't mean two
        // different things depending on which code path asks.
        return dir.exists() && ClaudeCodeRegistry.hasPluginManifest(dir)
    }

    /**
     * Check if a plugin already exists in Claude Code's installed_plugins.json
     * under a different `id@marketplace` key than ours. YouCoded-installed
     * plugins register themselves there too, so ignore our own key.
     */
    fun hasConflict(id: String): Boolean {
        try {
            // installed_plugins.json lives under the plugin cache dir
            val installedFile = File(pluginCacheDir, "installed_plugins.json")
            if (!installedFile.exists()) return false
            val json = JSONObject(installedFile.readText())
            val plugins = json.optJSONObject("plugins") ?: return false
            val ourKey = ClaudeCodeRegistry.pluginKey(id)
            val keys = plugins.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (key == ourKey) continue
                if (key.startsWith("$id@")) return true
            }
        } catch (_: Exception) {}
        return false
    }

    // ── Source-specific install strategies ──────────────────────────

    private suspend fun installFromLocal(id: String, sourceRef: String, sourceMarketplace: String? = null): InstallResult {
        // Phase 3a: source-aware repo — YouCoded local entries live in the
        // itsdestin/wecoded-marketplace repo, not the Anthropic upstream repo
        val cacheRepo = File(cacheDir, getCacheRepoName(sourceMarketplace))
        val repoUrl = getMarketplaceRepo(sourceMarketplace)

        // Ensure the marketplace repo is cloned, or refresh it if it's been >1h
        // since the last pull. Pull failures fall back to the cached copy
        // (offline-safe) and skip updating the timestamp so next install retries.
        if (!cacheRepo.exists()) {
            Log.i(TAG, "Cloning marketplace repo: $repoUrl")
            cacheDir.mkdirs()
            val ok = runGit("clone", "--depth", "1", repoUrl, cacheRepo.absolutePath)
            if (!ok) return InstallResult.Failed("Failed to clone marketplace repo")
            setCacheTimestamp(cacheRepo)
        } else if (System.currentTimeMillis() - getCacheTimestamp(cacheRepo) > CACHE_REFRESH_MS) {
            val fetchOk = runGit("-C", cacheRepo.absolutePath, "fetch", "origin")
            if (fetchOk) {
                // Default branch: master per workspace convention
                val resetOk = runGit("-C", cacheRepo.absolutePath, "reset", "--hard", "origin/master")
                if (resetOk) setCacheTimestamp(cacheRepo)
                // reset failure → proceed with cached copy, don't bump stamp
            }
            // fetch failure (offline) → proceed with cached copy
        }

        val sourceDir = File(cacheRepo, sourceRef)
        if (!sourceDir.exists() || !sourceDir.isDirectory) {
            return InstallResult.Failed("Source not found in marketplace cache: $sourceRef")
        }

        val targetDir = File(pluginsDir, id)
        targetDir.mkdirs()
        sourceDir.copyRecursively(targetDir, overwrite = true)
        return InstallResult.Success
    }

    // ── Task B5: bundled-plugin upgrade (port of desktop's readPluginVersion /
    // refreshLocalMarketplaceCache / upgradePluginFromLocal in plugin-installer.ts) ──

    /**
     * Read the "version" field out of a plugin's manifest, checking both
     * layouts Claude Code accepts (root plugin.json, then .claude-plugin/plugin.json).
     * Used both to read the REAL on-disk version of an install (not the
     * marketplace index's claimed version) and to read the cached copy's
     * version to decide whether an upgrade is available.
     */
    fun readPluginVersion(dir: File): String? {
        for (candidate in listOf(File(dir, "plugin.json"), File(dir, ".claude-plugin/plugin.json"))) {
            if (!candidate.exists()) continue
            val v = try { JSONObject(candidate.readText()).optString("version") } catch (_: Exception) { null }
            if (!v.isNullOrEmpty()) return v
        }
        return null
    }

    /** Where a source ref resolves to inside the local marketplace cache clone. */
    fun cacheSourceDir(sourceRef: String, sourceMarketplace: String?): File =
        File(File(cacheDir, getCacheRepoName(sourceMarketplace)), sourceRef)

    /**
     * Refresh the marketplace cache clone on its own, independent of an
     * install — the launch-time reconciler calls this before comparing
     * versions, so an already-installed bundled plugin's upgrade can be
     * detected without the user re-running the install flow. Clones if the
     * cache is missing; otherwise only fetches/resets once the 1 h gate
     * (CACHE_REFRESH_MS — same constant installFromLocal already uses) has
     * elapsed, since reconcile runs on EVERY launch and without the gate
     * that's a GitHub round-trip on every app start, on a phone.
     */
    suspend fun refreshLocalMarketplaceCache(sourceMarketplace: String?): Boolean = withContext(Dispatchers.IO) {
        val cacheRepo = File(cacheDir, getCacheRepoName(sourceMarketplace))
        val repoUrl = getMarketplaceRepo(sourceMarketplace)
        if (!cacheRepo.exists()) {
            cacheDir.mkdirs()
            val ok = runGit("clone", "--depth", "1", repoUrl, cacheRepo.absolutePath)
            if (ok) setCacheTimestamp(cacheRepo)
            return@withContext ok
        }
        if (System.currentTimeMillis() - getCacheTimestamp(cacheRepo) < CACHE_REFRESH_MS) return@withContext true
        if (!runGit("-C", cacheRepo.absolutePath, "fetch", "origin")) return@withContext false
        val resetOk = runGit("-C", cacheRepo.absolutePath, "reset", "--hard", "origin/master")
        if (resetOk) setCacheTimestamp(cacheRepo)
        resetOk
    }

    /**
     * Replace an already-installed plugin's tree with the cache clone's copy,
     * in place. Never deletes the live install directory before the new copy
     * is staged — a crash mid-copy must not leave the user with no plugin at
     * all. The old tree is parked at `.old-<id>` until the swap fully
     * succeeds, and is put BACK if anything throws in between (matches
     * desktop's upgradePluginFromLocal in plugin-installer.ts).
     *
     * [renameFn] defaults to the real `File.renameTo` and exists ONLY as a
     * test seam (review round 2, Finding 2). The plan's binding promise —
     * "if the swap dies half-way the old tree must be put back" — covers the
     * `!staging.renameTo(target)` branch below, which fires only once
     * `target.renameTo(retired)` has ALREADY succeeded. By the time that
     * second rename runs, target's path is guaranteed empty (freed by the
     * first rename moments earlier, same thread, no suspension point in
     * between), so nothing a test does with real files can plant an obstacle
     * there deterministically — any filesystem-permission trick broad enough
     * to block the second rename blocks the first one too, since both write
     * into the same parent (pluginsDir). Injecting the rename operation is
     * the only way to force that specific failure on demand and prove the
     * rollback actually restores the old tree, not just skip the branch.
     */
    suspend fun upgradeFromLocal(
        id: String,
        sourceRef: String,
        sourceMarketplace: String?,
        renameFn: (File, File) -> Boolean = { from, to -> from.renameTo(to) },
    ): InstallResult = withContext(Dispatchers.IO) {
        if (!SAFE_ID_RE.matches(id)) return@withContext InstallResult.Failed("Invalid plugin id")
        val cacheRepo = File(cacheDir, getCacheRepoName(sourceMarketplace))
        val sourceDir = cacheSourceDir(sourceRef, sourceMarketplace)
        // Security: prevent sourceRef from escaping the cache directory (e.g. "../../.ssh").
        if (!isContainedIn(sourceDir, cacheRepo)) return@withContext InstallResult.Failed("Invalid source ref (path traversal blocked)")
        if (!sourceDir.isDirectory) return@withContext InstallResult.Failed("Source not found in marketplace cache: $sourceRef")
        pluginsDir.mkdirs()
        val target = File(pluginsDir, id)
        val staging = File(pluginsDir, ".upgrade-$id")
        val retired = File(pluginsDir, ".old-$id")
        // Stale leftovers from a killed prior attempt must not make copyRecursively
        // merge into a half-written staging dir.
        staging.deleteRecursively()
        retired.deleteRecursively()
        try {
            sourceDir.copyRecursively(staging, overwrite = true)
            if (target.exists() && !renameFn(target, retired)) {
                // Fix (review round 1, Finding 2): the copy above already staged a
                // full second copy of the plugin at `.upgrade-<id>` — returning
                // without deleting it left that copy on disk forever. Not just
                // clutter: ClaudeCodeRegistry.listInstalledPluginDirs() adds EVERY
                // subdirectory of pluginsDir with no manifest check and no
                // dot-prefix skip, so a stranded ".upgrade-<id>" gets scanned as a
                // second installed copy of the plugin and can register duplicate
                // hooks/MCP servers. Clean up on every exit, not just the
                // exception path below.
                // Fix (review round 2, Minor): deleteRecursively() swallows
                // per-file failures instead of throwing — log when it can't
                // fully clean up so a partial ".upgrade-<id>" leftover isn't
                // silent (same failure class as the leak this branch fixes).
                if (!staging.deleteRecursively()) Log.w(TAG, "could not fully remove staged copy for $id at $staging")
                return@withContext InstallResult.Failed("could not move the old plugin aside")
            }
            if (!renameFn(staging, target)) {
                // WHY: put the old tree back immediately — a user must never end
                // up with the plugin directory entirely gone.
                if (!renameFn(retired, target)) Log.e(TAG, "upgrade rollback failed for $id: could not restore $retired")
                // Fix (review round 1, Finding 2): same staging leak as above —
                // the rename failed but the staged copy is still sitting on disk.
                // Fix (review round 2, Minor): log a failed cleanup instead of
                // swallowing it silently — see the WHY on the branch above.
                if (!staging.deleteRecursively()) Log.w(TAG, "could not fully remove staged copy for $id at $staging")
                return@withContext InstallResult.Failed("could not move the new plugin into place")
            }
        } catch (e: Exception) {
            // WHY: same rollback as above — the swap died mid-copy/rename.
            if (!target.exists() && retired.exists()) {
                try { renameFn(retired, target) } catch (_: Exception) { /* nothing better to do */ }
            }
            // Fix (Track B final review, "Also" minor finding): this was a bare
            // `staging.deleteRecursively()` — the only one of the three staging
            // cleanup sites in this function that still swallowed its boolean
            // return silently. A partial leftover here (e.g. a file the OS is
            // still holding open) would be just as silent as the two early-return
            // sites this same fix already covers above.
            if (!staging.deleteRecursively()) Log.w(TAG, "could not fully remove staged copy for $id at $staging")
            return@withContext InstallResult.Failed("upgrade copy failed: ${e.message}")
        }
        // WHY: deleting the retired tree is cleanup AFTER the swap already
        // succeeded — the new files are live at `target` at this point. A
        // failure here must not be reported as an upgrade failure (matches
        // desktop's WHY at upgradePluginFromLocal): the upgrade DID work, and
        // reporting failure would skip the registerPluginInstall call below,
        // leaving installed_plugins.json stuck on the old version forever.
        try { retired.deleteRecursively() } catch (_: Exception) { /* best-effort cleanup only */ }
        // Register with the REAL version read off the newly-swapped-in disk
        // copy, not a hardcoded default — this is the whole point of the upgrade.
        val version = readPluginVersion(target) ?: "1.0.0"
        try {
            ClaudeCodeRegistry.registerPluginInstall(homeDir, ClaudeCodeRegistry.RegisterInput(
                id = id,
                installPath = target.absolutePath,
                version = version,
            ))
        } catch (e: Exception) {
            return@withContext InstallResult.Failed("Registry write failed: ${e.message}")
        }
        InstallResult.Success
    }

    private suspend fun installFromUrl(id: String, url: String): InstallResult {
        val targetDir = File(pluginsDir, id)
        if (targetDir.exists()) targetDir.deleteRecursively()

        val ok = runGit("clone", "--depth", "1", url, targetDir.absolutePath)
        return if (ok) InstallResult.Success
        else InstallResult.Failed("git clone failed for $url")
    }

    private suspend fun installFromGitSubdir(id: String, repoUrl: String, subdir: String): InstallResult {
        if (subdir.isEmpty()) return InstallResult.Failed("Missing sourceSubdir for git-subdir source")

        val tmpDir = File(homeDir, "tmp/plugin-staging-$id")
        try {
            if (tmpDir.exists()) tmpDir.deleteRecursively()

            // Sparse clone: only fetch the subdirectory we need
            val cloneOk = runGit("clone", "--depth", "1", "--filter=blob:none", "--sparse", repoUrl, tmpDir.absolutePath)
            if (!cloneOk) return InstallResult.Failed("git clone failed for $repoUrl")

            val sparseOk = runGit("-C", tmpDir.absolutePath, "sparse-checkout", "set", subdir)
            if (!sparseOk) return InstallResult.Failed("sparse-checkout failed for $subdir")

            val sourceDir = File(tmpDir, subdir)
            if (!sourceDir.exists() || !sourceDir.isDirectory) {
                return InstallResult.Failed("Subdirectory not found after checkout: $subdir")
            }

            val targetDir = File(pluginsDir, id)
            if (targetDir.exists()) targetDir.deleteRecursively()
            targetDir.mkdirs()
            sourceDir.copyRecursively(targetDir, overwrite = true)

            return InstallResult.Success
        } finally {
            tmpDir.deleteRecursively()
        }
    }

    // ── Cache refresh + postInstall helpers (decomposition v3) ─────

    private fun getCacheTimestamp(cacheRepo: File): Long = try {
        val stamp = File(cacheRepo, ".youcoded-last-pull")
        if (stamp.exists()) stamp.readText().trim().toLongOrNull() ?: 0L else 0L
    } catch (_: Exception) { 0L }

    private fun setCacheTimestamp(cacheRepo: File) {
        try {
            File(cacheRepo, ".youcoded-last-pull").writeText(System.currentTimeMillis().toString())
        } catch (_: Exception) { /* non-fatal — retry next install */ }
    }

    /** Security: resolved `child` must stay inside `parent` (blocks a spoofed sourceRef like "../../.ssh"). */
    private fun isContainedIn(child: File, parent: File): Boolean {
        val c = child.canonicalFile
        val p = parent.canonicalFile
        return c == p || c.path.startsWith(p.path + File.separator)
    }

    private fun isPostInstallTrusted(entry: JSONObject): Boolean {
        val cmd = entry.optString("postInstall")
        val sourceRef = entry.optString("sourceRef")
        if (cmd.isEmpty() || sourceRef.isEmpty()) return false
        return TRUSTED_POSTINSTALL_ORGS.any { org -> sourceRef.contains("github.com/$org") }
    }

    /** Run a shell command via the embedded bash. Returns true on exit 0. */
    private suspend fun runShell(command: String, cwd: File): Boolean = withContext(Dispatchers.IO) {
        try {
            val bashPath = File(homeDir, "usr/bin/bash").absolutePath
            val pb = ProcessBuilder("/system/bin/linker64", bashPath, "-c", command)
                .directory(cwd)
                .redirectErrorStream(true)
            pb.environment().clear()
            pb.environment().putAll(buildEnv())
            val process = pb.start()
            val output = process.inputStream.bufferedReader().readText()
            val exited = process.waitFor(GIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)
            if (!exited) { process.destroyForcibly(); return@withContext false }
            val code = process.exitValue()
            if (code != 0) Log.w(TAG, "postInstall exit $code: ${output.take(500)}")
            code == 0
        } catch (e: Exception) {
            Log.e(TAG, "postInstall execution error", e)
            false
        }
    }

    // ── Helpers ────────────────────────────────────────────────────

    /**
     * Ensure the plugin has a .claude-plugin/plugin.json file.
     * Some upstream plugins only have a root plugin.json; Claude Code accepts both,
     * but we normalize to .claude-plugin/plugin.json for consistency.
     */
    private fun ensurePluginJson(id: String, entry: JSONObject) {
        val targetDir = File(pluginsDir, id)
        val dotDir = File(targetDir, ".claude-plugin")
        val dotJson = File(dotDir, "plugin.json")
        if (dotJson.exists()) return

        // Check for root plugin.json
        val rootJson = File(targetDir, "plugin.json")
        if (rootJson.exists()) return // Claude Code will find it at root

        // Neither exists — create one from the marketplace entry
        dotDir.mkdirs()
        val meta = JSONObject().apply {
            put("name", id)
            put("description", entry.optString("description", ""))
            val author = entry.optString("author", "")
            if (author.isNotEmpty()) put("author", JSONObject().put("name", author))
        }
        dotJson.writeText(meta.toString(2))
    }

    /**
     * Run a git command using the embedded runtime (linker64 + env).
     * Returns true on exit code 0, false otherwise.
     */
    private suspend fun runGit(vararg args: String): Boolean = withContext(Dispatchers.IO) {
        try {
            // Fix: Termux binaries live at <filesDir>/usr/bin/, NOT <filesDir>/home/usr/bin/.
            // homeDir is filesDir/home (Bootstrap.homeDir); usrDir is filesDir/usr (Bootstrap.usrDir).
            // Building the git path from homeDir instead of homeDir.parentFile resolved to
            // a nonexistent path and every `git clone` failed with "unable to open file".
            val gitPath = File(homeDir.parentFile ?: homeDir, "usr/bin/git").absolutePath
            val cmdList = mutableListOf("/system/bin/linker64", gitPath)
            cmdList.addAll(args)

            val env = buildEnv()
            val pb = ProcessBuilder(cmdList)
                .directory(homeDir)
                .redirectErrorStream(true)
            pb.environment().clear()
            pb.environment().putAll(env)

            val process = pb.start()
            // Read output to prevent pipe buffer blocking
            val output = process.inputStream.bufferedReader().readText()
            val exited = process.waitFor(GIT_TIMEOUT_SECONDS, TimeUnit.SECONDS)

            if (!exited) {
                process.destroyForcibly()
                Log.e(TAG, "git timed out: ${args.joinToString(" ")}")
                return@withContext false
            }

            val exitCode = process.exitValue()
            if (exitCode != 0) {
                Log.w(TAG, "git ${args.firstOrNull()} failed (exit $exitCode): ${output.take(500)}")
            }
            exitCode == 0
        } catch (e: Exception) {
            Log.e(TAG, "git execution error: ${args.joinToString(" ")}", e)
            false
        }
    }

    /** Build environment map for git execution via Bootstrap.buildRuntimeEnv().
     *
     *  Direct call — NOT reflection. Earlier versions took `bootstrap: Any` and
     *  used `bootstrap.javaClass.getMethod("buildRuntimeEnv").invoke(...)`,
     *  motivated by an alleged circular-dep that never actually existed
     *  (runtime/ does not import skills/). In release builds R8 minification
     *  obfuscates `buildRuntimeEnv` to a one-letter name, the reflection
     *  lookup throws NoSuchMethodException, the silent catch falls back to a
     *  stripped-down env with NO LD_PRELOAD / TERMUX_APP__LEGACY_DATA_DIR /
     *  GIT_EXEC_PATH, and every git clone — the only marketplace install
     *  path on Android — fails with `cannot exec 'remote-https': Permission
     *  denied` because git's HTTPS helper exec isn't routed through linker64.
     *  The bug shipped silently from 2026-03-25 (e18ab861, R8 enabled) until
     *  2026-04-30 when a user finally reported "click Install does nothing".
     *
     *  Do NOT reintroduce the reflection. */
    private fun buildEnv(): Map<String, String> = bootstrap.buildRuntimeEnv()
}
