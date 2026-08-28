package com.youcoded.app.skills

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * Task B5 review round 2, Finding 1a: listInstalledPluginDirs() used to add
 * EVERY child directory of the marketplace plugins subtree unconditionally —
 * no manifest check, no dot-prefix skip. PluginInstaller.upgradeFromLocal()
 * stages an upgrade at ".upgrade-<id>" and parks the retired tree at
 * ".old-<id>" inside that same subtree, so a process kill mid-swap left a
 * directory that got scanned here as a second installed plugin and could
 * register duplicate hooks/MCP servers (via HookReconciler/McpReconciler,
 * both of which walk this list). See ClaudeCodeRegistry.kt for the fix.
 */
class ClaudeCodeRegistryTest {
    private lateinit var tmpHome: File

    @Before
    fun setUp() {
        tmpHome = createTempDirectory(prefix = "youcoded-registry-").toFile()
    }

    @After
    fun tearDown() {
        tmpHome.deleteRecursively()
    }

    private fun write(path: String, content: String) {
        File(tmpHome, path).apply { parentFile?.mkdirs() }.writeText(content)
    }

    @Test
    fun `listInstalledPluginDirs ignores a dot-prefixed directory and a manifest-less directory`() {
        val base = ".claude/plugins/marketplaces/youcoded/plugins"
        // Real plugin: has a manifest, no dot prefix — must be listed.
        write("$base/youcoded-chatsearch/plugin.json", """{"version":"1.0.0"}""")
        // Stale upgrade leftover: dot-prefixed AND (deliberately) carries a
        // real manifest, since upgradeFromLocal's staged copy is a full copy
        // of the plugin tree. The dot-prefix skip must win regardless.
        write("$base/.upgrade-youcoded-chatsearch/plugin.json", """{"version":"1.1.0"}""")
        // Stale retired-tree leftover: same shape.
        write("$base/.old-youcoded-chatsearch/plugin.json", """{"version":"0.9.0"}""")
        // Manifest-less directory (e.g. a half-finished copy, or junk): no
        // dot prefix, but also no plugin.json anywhere — must be filtered by
        // the manifest check alone, independent of the dot-prefix skip.
        File(tmpHome, "$base/no-manifest-dir").mkdirs()

        val dirs = ClaudeCodeRegistry.listInstalledPluginDirs(tmpHome)
        val names = dirs.map { it.name }

        assertTrue(names.contains("youcoded-chatsearch"))
        assertFalse(names.contains(".upgrade-youcoded-chatsearch"))
        assertFalse(names.contains(".old-youcoded-chatsearch"))
        assertFalse(names.contains("no-manifest-dir"))
        assertEquals(1, names.size)
    }

    @Test
    fun `hasPluginManifest checks both accepted manifest locations`() {
        write("root/plugin.json", """{"version":"1.0.0"}""")
        write("nested/.claude-plugin/plugin.json", """{"version":"1.0.0"}""")
        File(tmpHome, "neither").mkdirs()

        assertTrue(ClaudeCodeRegistry.hasPluginManifest(File(tmpHome, "root")))
        assertTrue(ClaudeCodeRegistry.hasPluginManifest(File(tmpHome, "nested")))
        assertFalse(ClaudeCodeRegistry.hasPluginManifest(File(tmpHome, "neither")))
    }
}
