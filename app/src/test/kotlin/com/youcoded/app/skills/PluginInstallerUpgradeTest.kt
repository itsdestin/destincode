package com.youcoded.app.skills

import com.youcoded.app.runtime.Bootstrap
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock
import java.io.File

/**
 * Task B5: Android port of desktop's plugin-installer upgrade path
 * (readPluginVersion, refreshLocalMarketplaceCache, upgradeFromLocal) plus
 * VersionCompare, the Kotlin port of shared/version-compare.ts's
 * isNewerVersion. See app/src/main/kotlin/com/youcoded/app/skills/PluginInstaller.kt
 * and VersionCompare.kt.
 *
 * No git in these tests: the marketplace cache clone is faked as a plain
 * directory tree under tmpHome, same as the real cache clone would look
 * once cloned — upgradeFromLocal never shells out to git itself, only
 * refreshLocalMarketplaceCache does (and that's not exercised here).
 */
class PluginInstallerUpgradeTest {
    private lateinit var tmpHome: File

    @Before
    fun setUp() {
        tmpHome = createTempDir(prefix = "youcoded-upgrade-")
    }

    @After
    fun tearDown() {
        tmpHome.deleteRecursively()
    }

    private fun write(path: String, content: String) {
        File(tmpHome, path).apply { parentFile?.mkdirs() }.writeText(content)
    }

    @Test
    fun `isNewer compares dotted versions`() {
        assertTrue(VersionCompare.isNewer("0.1.0", "0.2.0"))
        assertFalse(VersionCompare.isNewer("0.2.0", "0.1.0"))
        assertFalse(VersionCompare.isNewer("1.0.0", "1.0.0"))
        assertFalse(VersionCompare.isNewer(null, "1.0.0"))
        assertTrue(VersionCompare.isNewer("v1.2", "1.2.1"))
    }

    @Test
    fun `readPluginVersion reads root or dot-claude-plugin manifests`() {
        write("a/plugin.json", """{"version":"0.2.0"}""")
        write("b/.claude-plugin/plugin.json", """{"version":"3.0.0"}""")
        val installer = PluginInstaller(tmpHome, mock(Bootstrap::class.java), SkillConfigStore(tmpHome))
        assertEquals("0.2.0", installer.readPluginVersion(File(tmpHome, "a")))
        assertEquals("3.0.0", installer.readPluginVersion(File(tmpHome, "b")))
        assertNull(installer.readPluginVersion(File(tmpHome, "c")))
    }

    @Test
    fun `upgradeFromLocal swaps the tree and registers the real version`() = runTest {
        // Fake marketplace cache clone: a newer copy of the plugin sits under
        // .claude/youcoded-marketplace-cache/wecoded-marketplace/<sourceRef>/,
        // exactly where PluginInstaller.cacheSourceDir("youcoded", ...) resolves it.
        write(
            ".claude/youcoded-marketplace-cache/wecoded-marketplace/youcoded-chatsearch/plugin.json",
            """{"name":"youcoded-chatsearch","version":"0.2.0"}""",
        )
        write(
            ".claude/youcoded-marketplace-cache/wecoded-marketplace/youcoded-chatsearch/skills/x/SKILL.md",
            "new",
        )
        // Existing (stale) install at the live marketplace plugin path.
        write(
            ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/plugin.json",
            """{"name":"youcoded-chatsearch","version":"0.1.0"}""",
        )
        write(
            ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/stale.txt",
            "gone",
        )
        val installer = PluginInstaller(tmpHome, mock(Bootstrap::class.java), SkillConfigStore(tmpHome))
        val r = installer.upgradeFromLocal("youcoded-chatsearch", "youcoded-chatsearch", "youcoded")
        assertTrue(r is PluginInstaller.InstallResult.Success)
        assertFalse(
            File(tmpHome, ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/stale.txt").exists(),
        )
        assertEquals(
            "new",
            File(tmpHome, ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/skills/x/SKILL.md")
                .readText(),
        )
        val db = JSONObject(File(tmpHome, ".claude/plugins/installed_plugins.json").readText())
        assertEquals(
            "0.2.0",
            db.getJSONObject("plugins").getJSONArray("youcoded-chatsearch@youcoded").getJSONObject(0)
                .getString("version"),
        )
    }
}
