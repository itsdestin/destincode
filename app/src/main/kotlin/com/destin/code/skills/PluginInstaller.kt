package com.destin.code.skills

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * Installs Claude Code plugins by placing files at ~/.claude/plugins/<name>/.
 * Claude Code auto-discovers plugins via .claude-plugin/plugin.json at session start.
 *
 * Three source types are supported:
 * - "local": copy from a cached clone of the marketplace repo
 * - "url": git clone an external repository
 * - "git-subdir": git clone + sparse checkout a subdirectory
 */
class PluginInstaller(
    private val homeDir: File,
    private val bootstrap: Any, // Bootstrap instance — used for buildRuntimeEnv()
    private val configStore: SkillConfigStore,
) {
    private val pluginsDir = File(homeDir, ".claude/plugins")
    private val cacheDir = File(homeDir, ".claude/destincode-marketplace-cache")
    private val installsInProgress = mutableSetOf<String>()

    companion object {
        private const val TAG = "PluginInstaller"
        private const val GIT_TIMEOUT_SECONDS = 120L
        private const val MARKETPLACE_REPO = "https://github.com/anthropics/claude-plugins-official.git"
        private const val DESTINCODE_MARKETPLACE_REPO = "https://github.com/itsdestin/destincode-marketplace.git"

        /**
         * Phase 3a: Map sourceMarketplace to its git repo URL.
         * DestinCode/DestinClaude local entries live in itsdestin/destincode-marketplace
         * while Anthropic upstream entries live in anthropics/claude-plugins-official.
         */
        fun getMarketplaceRepo(sourceMarketplace: String?): String =
            if (sourceMarketplace == "destincode" || sourceMarketplace == "destinclaude")
                DESTINCODE_MARKETPLACE_REPO
            else MARKETPLACE_REPO

        private fun getCacheRepoName(sourceMarketplace: String?): String =
            if (sourceMarketplace == "destincode" || sourceMarketplace == "destinclaude")
                "destincode-marketplace"
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

            // Guard: already installed via DestinCode
            val targetDir = File(pluginsDir, id)
            if (targetDir.exists() && File(targetDir, ".claude-plugin/plugin.json").exists()) {
                return@withContext InstallResult.AlreadyInstalled("DestinCode")
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
            configStore.removePluginInstall(id)
            true
        } catch (e: Exception) {
            Log.e(TAG, "Uninstall failed for $id", e)
            false
        }
    }

    /** Check if a plugin is installed via DestinCode marketplace. */
    fun isInstalled(id: String): Boolean {
        val installed = configStore.getInstalledPlugins()
        return installed.has(id)
    }

    /**
     * Check if a plugin already exists in Claude Code's installed_plugins.json.
     * This would cause double-loading if we also install at ~/.claude/plugins/<id>/.
     */
    fun hasConflict(id: String): Boolean {
        try {
            val installedFile = File(pluginsDir, "installed_plugins.json")
            if (!installedFile.exists()) return false
            val json = JSONObject(installedFile.readText())
            val plugins = json.optJSONObject("plugins") ?: return false
            val keys = plugins.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                if (key.startsWith("$id@")) return true
            }
        } catch (_: Exception) {}
        return false
    }

    // ── Source-specific install strategies ──────────────────────────

    private suspend fun installFromLocal(id: String, sourceRef: String, sourceMarketplace: String? = null): InstallResult {
        // Phase 3a: source-aware repo — DestinCode local entries live in the
        // itsdestin/destincode-marketplace repo, not the Anthropic upstream repo
        val cacheRepo = File(cacheDir, getCacheRepoName(sourceMarketplace))
        val repoUrl = getMarketplaceRepo(sourceMarketplace)

        // Ensure the marketplace repo is cloned
        if (!cacheRepo.exists()) {
            Log.i(TAG, "Cloning marketplace repo: $repoUrl")
            cacheDir.mkdirs()
            val ok = runGit("clone", "--depth", "1", repoUrl, cacheRepo.absolutePath)
            if (!ok) return InstallResult.Failed("Failed to clone marketplace repo")
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
            val gitPath = File(homeDir, "usr/bin/git").absolutePath
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

    /** Build environment map for git execution via Bootstrap.buildRuntimeEnv(). */
    private fun buildEnv(): Map<String, String> {
        // Use reflection to call bootstrap.buildRuntimeEnv() since we take Any
        // to avoid a circular dependency on Bootstrap
        return try {
            val method = bootstrap.javaClass.getMethod("buildRuntimeEnv")
            @Suppress("UNCHECKED_CAST")
            method.invoke(bootstrap) as Map<String, String>
        } catch (_: Exception) {
            // Fallback: minimal env
            mapOf(
                "HOME" to homeDir.absolutePath,
                "PATH" to "${homeDir.absolutePath}/usr/bin:/system/bin",
                "LD_LIBRARY_PATH" to "${homeDir.absolutePath}/usr/lib",
            )
        }
    }
}
