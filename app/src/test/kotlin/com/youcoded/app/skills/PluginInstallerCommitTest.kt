package com.youcoded.app.skills

import com.youcoded.app.runtime.Bootstrap
import kotlinx.coroutines.test.runTest
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * Marketplace overhaul parity: desktop records the sha `git rev-parse HEAD`
 * reports after pinning, and the renderer treats "recorded commit differs from
 * the catalog's sourceCommit" as an update being available. Android's runGit
 * returned a bare Boolean and surfaced no output at all, so nothing was ever
 * recorded and that half of the Update badge never fired on a phone.
 *
 * The load-bearing assertion is the NEGATIVE one: recording the CATALOG's
 * sourceCommit would be worse than recording nothing, because it always
 * compares equal and the badge would silently never fire again.
 *
 * `gitRunner` is a test seam (same shape as upgradeFromLocal's `renameFn`):
 * there is no Termux git in a JVM unit test.
 */
class PluginInstallerCommitTest {

    private lateinit var tmpHome: File

    @Before
    fun setUp() { tmpHome = createTempDirectory(prefix = "youcoded-commit-").toFile() }

    @After
    fun tearDown() { tmpHome.deleteRecursively() }

    private val listedCommit = "1111111111111111111111111111111111111111"
    private val landedCommit = "abcdef0123456789abcdef0123456789abcdef01"

    /** Records every git invocation and fakes clone / fetch / checkout / rev-parse. */
    private class FakeGit(private val head: String) : (List<String>) -> PluginInstaller.GitResult {
        val calls = mutableListOf<List<String>>()
        override fun invoke(args: List<String>): PluginInstaller.GitResult {
            calls.add(args)
            if (args.firstOrNull() == "clone") {
                // Last arg is the destination — make it look like a real clone.
                val dest = File(args.last())
                dest.mkdirs()
                File(dest, "plugin.json").writeText("""{"name":"demo","version":"1.0.0"}""")
                return PluginInstaller.GitResult(true, "")
            }
            if (args.contains("rev-parse")) return PluginInstaller.GitResult(true, "$head\n")
            return PluginInstaller.GitResult(true, "")
        }
    }

    private fun entry() = JSONObject().apply {
        put("id", "demo")
        put("sourceType", "url")
        put("sourceRef", "https://github.com/o/demo.git")
        put("version", "1.0.0")
        put("catalog", JSONObject().put("sourceCommit", listedCommit))
    }

    @Test
    fun `records the sha git actually checked out, not the one the catalog listed`() = runTest {
        val git = FakeGit(landedCommit)
        val store = SkillConfigStore(tmpHome)
        store.load()
        val installer = PluginInstaller(tmpHome, mock(Bootstrap::class.java), store, gitRunner = git)

        val result = installer.install(entry())
        assertTrue("install should succeed: $result", result is PluginInstaller.InstallResult.Success)

        val pkg = store.getPackages().optJSONObject("demo")
        assertNotNull("install must record a package", pkg)
        assertEquals(landedCommit, pkg!!.optString("commit"))
        assertNotEquals(
            "recording the catalog's own sourceCommit would make the badge never fire",
            listedCommit,
            pkg.optString("commit"),
        )
        // It has to ASK git where it landed — that is the only honest source.
        assertTrue(
            "expected a rev-parse HEAD call, got ${git.calls}",
            git.calls.any { it.contains("rev-parse") && it.contains("HEAD") },
        )
    }

    @Test
    fun `a git failure surfaces git's own output instead of a guess`() = runTest {
        val store = SkillConfigStore(tmpHome)
        store.load()
        val failingCheckout = object : (List<String>) -> PluginInstaller.GitResult {
            override fun invoke(args: List<String>): PluginInstaller.GitResult {
                if (args.firstOrNull() == "clone") {
                    File(args.last()).mkdirs()
                    return PluginInstaller.GitResult(true, "")
                }
                if (args.contains("checkout")) {
                    return PluginInstaller.GitResult(false, "fatal: reference is not a tree: $listedCommit")
                }
                return PluginInstaller.GitResult(true, "")
            }
        }
        val installer = PluginInstaller(tmpHome, mock(Bootstrap::class.java), store, gitRunner = failingCheckout)

        val result = installer.install(entry())
        val error = (result as? PluginInstaller.InstallResult.Failed)?.error ?: ""
        assertTrue("expected git's own words in: $error", error.contains("reference is not a tree"))
    }
}
