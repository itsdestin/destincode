package com.youcoded.app.skills

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Claude Code Registry Integration (Kotlin port of desktop/src/main/claude-code-registry.ts).
 *
 * Claude Code (v2.1+) does NOT filesystem-scan ~/.claude/plugins/ to find
 * plugins. Its plugin loader iterates `enabledPlugins` from
 * ~/.claude/settings.json and resolves each entry through four on-disk
 * registries:
 *
 *   1. ~/.claude/settings.json           → enabledPlugins: { "id@marketplace": true }
 *   2. ~/.claude/plugins/installed_plugins.json
 *                                         → { version: 2, plugins: { "id@marketplace": [{ installPath, ... }] } }
 *   3. ~/.claude/plugins/known_marketplaces.json
 *                                         → { "marketplace": { source, installLocation, ... } }
 *   4. <installLocation>/.claude-plugin/marketplace.json
 *                                         → { name, owner, plugins: [{ name, source, ... }] }
 *
 * If any of these are missing, /reload-plugins silently reports "0 new
 * plugins" and the plugin is invisible to the CLI. Keep this in sync with
 * the desktop implementation.
 *
 * The non-cache code path Claude Code uses requires the actual plugin
 * directory to live at <marketplaceInstallLocation>/<source>, so plugins
 * install under the marketplace subtree — NOT the legacy ~/.claude/plugins/<id>/.
 */
object ClaudeCodeRegistry {

    const val YOUCODED_MARKETPLACE_ID = "youcoded"

    fun claudeDir(homeDir: File): File = File(homeDir, ".claude")
    fun pluginCacheDir(homeDir: File): File = File(claudeDir(homeDir), "plugins")
    fun youcodedMarketplaceRoot(homeDir: File): File =
        File(pluginCacheDir(homeDir), "marketplaces/$YOUCODED_MARKETPLACE_ID")
    fun youcodedPluginsDir(homeDir: File): File =
        File(youcodedMarketplaceRoot(homeDir), "plugins")

    /** The @-qualified key Claude Code uses in enabledPlugins and installed_plugins.json. */
    fun pluginKey(id: String): String = "$id@$YOUCODED_MARKETPLACE_ID"

    /**
     * True for a directory that looks like a real, installed plugin: has a
     * manifest at either accepted location. Used both to filter
     * listInstalledPluginDirs() below and (as PluginInstaller.isInstalledOnDisk)
     * to decide install-vs-upgrade — kept as one predicate so the two answers
     * can't drift apart.
     */
    fun hasPluginManifest(dir: File): Boolean =
        File(dir, "plugin.json").exists() || File(dir, ".claude-plugin/plugin.json").exists()

    /**
     * Enumerate every directory that should be treated as an installed
     * plugin by reconcilers and skill-provider introspection. Two sources:
     *   1. The core toolkit clone at ~/.claude/plugins/<id>/ (top-level
     *      children with a plugin.json) — installed by bootstrap/install.sh,
     *      not via the marketplace.
     *   2. Marketplace-installed packages at
     *      ~/.claude/plugins/marketplaces/youcoded/plugins/<id>/.
     *
     * Top-level non-plugin entries (installed_plugins.json,
     * known_marketplaces.json, the `marketplaces` subtree) are filtered
     * out by the plugin.json check.
     *
     * Fix (review round 2, Finding 1a): the marketplace-subtree loop used to
     * add EVERY child directory unconditionally, no manifest check, no
     * dot-prefix skip. PluginInstaller.upgradeFromLocal() stages an upgrade
     * at `.upgrade-<id>` and parks the retired tree at `.old-<id>`, both
     * inside this same marketplace subtree — if the process dies mid-swap,
     * that leftover directory (a full copy of the plugin, complete with its
     * own plugin.json) got scanned here as a SECOND installed plugin and fed
     * into HookReconciler/McpReconciler, registering duplicate hooks/MCP
     * servers. A plugin id can never start with "." (PluginInstaller.SAFE_ID_RE
     * forbids it), so the dot-skip can never hide a real plugin. Matches the
     * manifest predicate PluginInstaller.isInstalledOnDisk() already used.
     * NOTE: desktop's listInstalledPluginDirs() (claude-code-registry.ts) has
     * this identical gap in its marketplace-subtree loop — unfixed there as
     * of this change since this task is scoped to Android; flagged for a
     * follow-up.
     */
    fun listInstalledPluginDirs(homeDir: File): List<File> {
        val dirs = mutableListOf<File>()
        val cache = pluginCacheDir(homeDir)
        if (cache.exists()) {
            cache.listFiles { f -> f.isDirectory }?.forEach { child ->
                if (child.name == "marketplaces") return@forEach
                if (hasPluginManifest(child)) {
                    dirs.add(child)
                }
            }
        }
        val marketplaceRoot = youcodedPluginsDir(homeDir)
        if (marketplaceRoot.exists()) {
            marketplaceRoot.listFiles { f -> f.isDirectory }?.forEach { child ->
                if (child.name.startsWith(".")) return@forEach
                if (hasPluginManifest(child)) {
                    dirs.add(child)
                }
            }
        }
        return dirs
    }

    // ── JSON file helpers (tolerant, atomic-ish) ─────────────────────

    private fun readJson(file: File): JSONObject? = try {
        if (file.exists()) JSONObject(file.readText()) else null
    } catch (_: Exception) { null }

    private fun writeJsonAtomic(file: File, data: JSONObject) {
        file.parentFile?.mkdirs()
        val tmp = File(file.absolutePath + ".tmp")
        tmp.writeText(data.toString(2))
        tmp.renameTo(file)
    }

    private fun nowIso(): String =
        java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", java.util.Locale.US)
            .apply { timeZone = java.util.TimeZone.getTimeZone("UTC") }
            .format(java.util.Date())

    // ── known_marketplaces.json ──────────────────────────────────────

    private fun ensureMarketplaceRegistered(homeDir: File) {
        val file = File(pluginCacheDir(homeDir), "known_marketplaces.json")
        val existing = readJson(file) ?: JSONObject()
        val expectedLoc = youcodedMarketplaceRoot(homeDir).absolutePath
        val current = existing.optJSONObject(YOUCODED_MARKETPLACE_ID)
        if (current != null && current.optString("installLocation") == expectedLoc) return

        existing.put(YOUCODED_MARKETPLACE_ID, JSONObject().apply {
            put("source", JSONObject().apply {
                put("source", "github")
                put("repo", "itsdestin/wecoded-marketplace")
            })
            put("installLocation", expectedLoc)
            put("lastUpdated", nowIso())
            // autoUpdate:false — YouCoded manages marketplace.json itself;
            // don't let Claude Code try to refetch it over the network.
            put("autoUpdate", false)
        })
        writeJsonAtomic(file, existing)
    }

    // ── marketplace.json (YouCoded marketplace's own manifest) ───────

    private fun marketplaceManifestFile(homeDir: File): File =
        File(youcodedMarketplaceRoot(homeDir), ".claude-plugin/marketplace.json")

    private fun readMarketplaceManifest(homeDir: File): JSONObject {
        val existing = readJson(marketplaceManifestFile(homeDir))
        if (existing != null && existing.optJSONArray("plugins") != null) return existing
        return JSONObject().apply {
            put("name", YOUCODED_MARKETPLACE_ID)
            put("owner", JSONObject().apply {
                put("name", "YouCoded")
                put("url", "https://github.com/itsdestin/youcoded")
            })
            put("plugins", JSONArray())
        }
    }

    private fun upsertPluginInManifest(homeDir: File, entry: JSONObject) {
        val manifest = readMarketplaceManifest(homeDir)
        val plugins = manifest.optJSONArray("plugins") ?: JSONArray()
        val name = entry.optString("name")
        var replaced = false
        val next = JSONArray()
        for (i in 0 until plugins.length()) {
            val p = plugins.optJSONObject(i) ?: continue
            if (p.optString("name") == name) {
                next.put(entry)
                replaced = true
            } else {
                next.put(p)
            }
        }
        if (!replaced) next.put(entry)
        manifest.put("plugins", next)
        writeJsonAtomic(marketplaceManifestFile(homeDir), manifest)
    }

    private fun removePluginFromManifest(homeDir: File, id: String) {
        val manifest = readMarketplaceManifest(homeDir)
        val plugins = manifest.optJSONArray("plugins") ?: return
        val next = JSONArray()
        var removed = false
        for (i in 0 until plugins.length()) {
            val p = plugins.optJSONObject(i) ?: continue
            if (p.optString("name") == id) { removed = true; continue }
            next.put(p)
        }
        if (!removed) return
        manifest.put("plugins", next)
        writeJsonAtomic(marketplaceManifestFile(homeDir), manifest)
    }

    // ── installed_plugins.json (under plugin cache dir, not ~/.claude) ──

    private fun installedPluginsFile(homeDir: File): File =
        File(pluginCacheDir(homeDir), "installed_plugins.json")

    private fun readInstalledPlugins(homeDir: File): JSONObject {
        val existing = readJson(installedPluginsFile(homeDir))
        if (existing != null && existing.optInt("version") == 2 && existing.has("plugins")) return existing
        return JSONObject().apply {
            put("version", 2)
            put("plugins", JSONObject())
        }
    }

    private fun writeInstalledPlugin(homeDir: File, id: String, installPath: String, version: String) {
        val db = readInstalledPlugins(homeDir)
        val plugins = db.optJSONObject("plugins") ?: JSONObject().also { db.put("plugins", it) }
        val now = nowIso()
        val arr = JSONArray().put(JSONObject().apply {
            put("scope", "user")
            put("installPath", installPath)
            put("version", version)
            put("installedAt", now)
            put("lastUpdated", now)
        })
        plugins.put(pluginKey(id), arr)
        writeJsonAtomic(installedPluginsFile(homeDir), db)
    }

    private fun removeInstalledPlugin(homeDir: File, id: String) {
        val db = readInstalledPlugins(homeDir)
        val plugins = db.optJSONObject("plugins") ?: return
        val key = pluginKey(id)
        if (!plugins.has(key)) return
        plugins.remove(key)
        writeJsonAtomic(installedPluginsFile(homeDir), db)
    }

    // ── settings.json enabledPlugins ─────────────────────────────────

    private fun settingsFile(homeDir: File): File = File(claudeDir(homeDir), "settings.json")

    private fun readSettings(homeDir: File): JSONObject = readJson(settingsFile(homeDir)) ?: JSONObject()
    private fun writeSettings(homeDir: File, data: JSONObject) = writeJsonAtomic(settingsFile(homeDir), data)

    private fun enablePluginInSettings(homeDir: File, id: String) {
        val settings = readSettings(homeDir)
        val enabled = settings.optJSONObject("enabledPlugins") ?: JSONObject().also {
            settings.put("enabledPlugins", it)
        }
        val key = pluginKey(id)
        if (enabled.optBoolean(key, false)) return
        enabled.put(key, true)
        writeSettings(homeDir, settings)
    }

    private fun disablePluginInSettings(homeDir: File, id: String) {
        val settings = readSettings(homeDir)
        val enabled = settings.optJSONObject("enabledPlugins") ?: return
        val key = pluginKey(id)
        if (!enabled.has(key)) return
        enabled.remove(key)
        writeSettings(homeDir, settings)
    }

    // ── Public API ───────────────────────────────────────────────────

    data class RegisterInput(
        val id: String,
        val installPath: String,
        val version: String? = null,
        val description: String? = null,
        val author: String? = null,
        val category: String? = null,
    )

    /**
     * Wire a YouCoded-installed plugin into all four Claude Code registries
     * so /reload-plugins loads it as a first-class plugin.
     */
    fun registerPluginInstall(homeDir: File, input: RegisterInput) {
        ensureMarketplaceRegistered(homeDir)
        upsertPluginInManifest(homeDir, JSONObject().apply {
            put("name", input.id)
            // Source is relative to marketplace root; the CLI computes
            // <installLocation>/<source> when loading without the cache.
            put("source", "./plugins/${input.id}")
            if (input.description != null) put("description", input.description)
            if (input.version != null) put("version", input.version)
            if (input.category != null) put("category", input.category)
            if (input.author != null) put("author", JSONObject().put("name", input.author))
            put("strict", true)
        })
        writeInstalledPlugin(homeDir, input.id, input.installPath, input.version ?: "1.0.0")
        enablePluginInSettings(homeDir, input.id)
    }

    /**
     * Remove the plugin from all four registries. Does NOT delete the
     * plugin directory — that's the caller's job.
     */
    fun unregisterPluginInstall(homeDir: File, id: String) {
        removePluginFromManifest(homeDir, id)
        removeInstalledPlugin(homeDir, id)
        disablePluginInSettings(homeDir, id)
    }
}
