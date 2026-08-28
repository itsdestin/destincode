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
import kotlin.io.path.createTempDirectory

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
        // Fix (review round 1, Finding 4): createTempDir() is deprecated since
        // Kotlin 1.4 and prints a compiler warning on every build.
        tmpHome = createTempDirectory(prefix = "youcoded-upgrade-").toFile()
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

    // Fix (review round 1, Finding 4): the rollback paths were untested, which
    // is why the staging leak (Finding 2) shipped in the first place.
    //
    // upgradeFromLocal has two early returns that both leave a full staged
    // copy of the plugin at ".upgrade-<id>" unless it's explicitly deleted:
    //   1. target exists but can't be moved aside to ".old-<id>"
    //   2. the staged copy can't be moved into place at <id>
    // Branch 2 can only be reached, in the real code, once branch 1's own
    // rename has already SUCCEEDED (moved the old tree out of the way) — at
    // which point the destination is guaranteed empty again, so a plain JVM
    // test (no dependency injection around File I/O) cannot force branch 2's
    // rename to fail without also blocking branch 1's. This test instead
    // forces branch 1 to fail — by making ".old-<id>" itself a non-empty
    // directory that survives the function's own startup cleanup (its
    // permissions are set read-only, so `retired.deleteRecursively()` can't
    // clear its contents) — which is the same staging-leak defect, on the
    // other of the two early-return sites, and is deterministic to reproduce.
    @Test
    fun `upgradeFromLocal cleans up the staged copy when the old tree cannot be moved aside`() = runTest {
        write(
            ".claude/youcoded-marketplace-cache/wecoded-marketplace/youcoded-chatsearch/plugin.json",
            """{"name":"youcoded-chatsearch","version":"0.2.0"}""",
        )
        write(
            ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/plugin.json",
            """{"name":"youcoded-chatsearch","version":"0.1.0"}""",
        )
        write(
            ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/original.txt",
            "keep me",
        )
        // Block the "move old tree aside" rename: pre-seed ".old-<id>" as a
        // non-empty directory and strip its own write permission so the
        // function's unconditional startup cleanup (retired.deleteRecursively())
        // cannot empty it out. rename(2) refuses to replace a non-empty
        // directory, so target.renameTo(retired) will return false.
        val retiredDir = File(
            tmpHome,
            ".claude/plugins/marketplaces/youcoded/plugins/.old-youcoded-chatsearch",
        )
        write(".claude/plugins/marketplaces/youcoded/plugins/.old-youcoded-chatsearch/blocker.txt", "leftover")
        retiredDir.setWritable(false)

        val installer = PluginInstaller(tmpHome, mock(Bootstrap::class.java), SkillConfigStore(tmpHome))
        try {
            val r = installer.upgradeFromLocal("youcoded-chatsearch", "youcoded-chatsearch", "youcoded")
            assertTrue(r is PluginInstaller.InstallResult.Failed)
        } finally {
            // Restore permissions so tearDown()'s deleteRecursively can clean up.
            retiredDir.setWritable(true)
        }

        // The old tree was never moved — still at its original path with its
        // original contents.
        assertEquals(
            "keep me",
            File(tmpHome, ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/original.txt")
                .readText(),
        )
        // Finding 2 regression: the staged copy must not be left on disk.
        assertFalse(
            File(tmpHome, ".claude/plugins/marketplaces/youcoded/plugins/.upgrade-youcoded-chatsearch").exists(),
        )
    }

    // Fix (review round 2, Finding 2): the plan's binding promise is "if the
    // swap dies half-way the old tree must be put back" — that's the
    // `retired.renameTo(target)` rollback inside the `!staging.renameTo(target)`
    // branch, reached only once `target.renameTo(retired)` has ALREADY moved
    // the real old tree out of the way. Round 1's staging-leak test (above)
    // exercises the OTHER early return, where the old tree is never moved at
    // all — it doesn't touch this rollback. A real filesystem obstacle can't
    // reach this branch deterministically: by the time the second rename
    // runs, target's path is guaranteed empty (freed by the first rename,
    // same thread, no suspension point in between), so nothing plantable
    // ahead of time survives to block only the second rename without also
    // blocking the first. upgradeFromLocal's renameFn parameter is the
    // injectable seam that makes this branch reachable on demand: intercept
    // the SECOND rename call specifically (staging -> target) and force it
    // to fail, while every other rename call (including the rollback itself)
    // goes through untouched.
    @Test
    fun `upgradeFromLocal restores the old tree when the swap-in rename fails after the swap-aside succeeded`() = runTest {
        write(
            ".claude/youcoded-marketplace-cache/wecoded-marketplace/youcoded-chatsearch/plugin.json",
            """{"name":"youcoded-chatsearch","version":"0.2.0"}""",
        )
        write(
            ".claude/youcoded-marketplace-cache/wecoded-marketplace/youcoded-chatsearch/skills/x/SKILL.md",
            "new",
        )
        write(
            ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/plugin.json",
            """{"name":"youcoded-chatsearch","version":"0.1.0"}""",
        )
        write(
            ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/original.txt",
            "keep me",
        )

        val installer = PluginInstaller(tmpHome, mock(Bootstrap::class.java), SkillConfigStore(tmpHome))
        var callCount = 0
        // Call 1: target -> retired (swap-aside). Let it really happen.
        // Call 2: staging -> target (swap-in). Force it to fail WITHOUT
        // touching the filesystem, simulating a real rename failure (e.g. a
        // held-open file) — this is exactly the scenario the binding promise
        // covers.
        // Call 3+: the rollback (retired -> target) and anything else. Let
        // them really happen, so the rollback's own effect is what the
        // assertions below observe.
        val renameFn: (File, File) -> Boolean = { from, to ->
            callCount++
            if (callCount == 2) false else from.renameTo(to)
        }

        val r = installer.upgradeFromLocal("youcoded-chatsearch", "youcoded-chatsearch", "youcoded", renameFn)

        assertTrue(r is PluginInstaller.InstallResult.Failed)
        assertEquals(3, callCount) // swap-aside, failed swap-in, rollback — no extra calls
        // The old tree is back — not just "never moved" (round 1's test),
        // genuinely MOVED AWAY and then MOVED BACK by the rollback branch.
        assertEquals(
            "keep me",
            File(tmpHome, ".claude/plugins/marketplaces/youcoded/plugins/youcoded-chatsearch/original.txt")
                .readText(),
        )
        // The staged copy must not be left on disk.
        assertFalse(
            File(tmpHome, ".claude/plugins/marketplaces/youcoded/plugins/.upgrade-youcoded-chatsearch").exists(),
        )
        // The retired parking spot must not be left behind either — the
        // rollback's rename moved it back to `target`, it doesn't still
        // exist at `.old-<id>`.
        assertFalse(
            File(tmpHome, ".claude/plugins/marketplaces/youcoded/plugins/.old-youcoded-chatsearch").exists(),
        )
    }

    @Test
    fun `isInstalledOnDisk checks the real tree, not the config-store record`() {
        // Fix (review round 1, Finding 1): isInstalledOnDisk is what reconcile
        // now asks instead of the config-store record, so a config reset or a
        // crash mid-upgrade heals itself on the next launch instead of getting
        // stuck reporting the same wrong action forever. Resolves ids under the
        // real plugins dir: .claude/plugins/marketplaces/youcoded/plugins/<id>.
        write(
            ".claude/plugins/marketplaces/youcoded/plugins/root-manifest/plugin.json",
            """{"version":"1.0.0"}""",
        )
        write(
            ".claude/plugins/marketplaces/youcoded/plugins/nested-manifest/.claude-plugin/plugin.json",
            """{"version":"1.0.0"}""",
        )
        File(tmpHome, ".claude/plugins/marketplaces/youcoded/plugins/no-manifest").mkdirs()
        val installer = PluginInstaller(tmpHome, mock(Bootstrap::class.java), SkillConfigStore(tmpHome))
        assertTrue(installer.isInstalledOnDisk("root-manifest"))
        assertTrue(installer.isInstalledOnDisk("nested-manifest"))
        assertFalse(installer.isInstalledOnDisk("no-manifest"))
        assertFalse(installer.isInstalledOnDisk("does-not-exist"))
    }
}
