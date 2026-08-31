package com.youcoded.app.skills

import android.content.Context
import android.content.res.AssetManager
import kotlinx.coroutines.test.runTest
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import java.io.ByteArrayInputStream
import java.io.File
import kotlin.io.path.createTempDirectory

/**
 * Android port of desktop's prompt install / update semantics
 * (desktop/src/main/skill-provider.ts `entry.type === 'prompt'` branches and
 * desktop/tests/prompt-install-update.test.ts).
 *
 * Bug this pins: Android's update() called updatePackageVersion() and returned
 * `ok: true` WITHOUT ever rewriting the prompt's text, and install() recorded no
 * package at all. So "Update" reported success it had not performed, and the
 * Update badge could never light for a prompt because packages[id] was absent.
 * The live catalog now carries 444 prompt listings, so this is the common path.
 *
 * No network: fetchIndex()'s first source is a FRESH catalog.json cache file,
 * which these tests write directly.
 */
class LocalSkillProviderPromptTest {

    private lateinit var tmpHome: File
    private lateinit var context: Context

    @Before
    fun setUp() {
        tmpHome = createTempDirectory(prefix = "youcoded-prompt-").toFile()
        context = mock(Context::class.java)
        val assets = mock(AssetManager::class.java)
        `when`(context.assets).thenReturn(assets)
        `when`(assets.open("web/data/skill-registry.json"))
            .thenReturn(ByteArrayInputStream("{}".toByteArray()))
    }

    @After
    fun tearDown() { tmpHome.deleteRecursively() }

    /** Seed the marketplace catalog cache so fetchIndex() returns these entries offline. */
    private fun seedCatalog(vararg entries: JSONObject) {
        val arr = JSONArray()
        entries.forEach { arr.put(it) }
        val cache = File(tmpHome, ".claude/youcoded-marketplace-cache/catalog.json")
        cache.parentFile?.mkdirs()
        cache.writeText(
            JSONObject()
                .put("fetchedAt", System.currentTimeMillis())
                .put("data", arr.toString())
                .toString(),
        )
    }

    private fun promptEntry(id: String, version: String, body: String) = JSONObject().apply {
        put("id", id)
        put("type", "prompt")
        put("displayName", "Standup Notes")
        put("description", "A prompt")
        put("category", "work")
        put("prompt", body)
        put("version", version)
    }

    private fun newProvider(): LocalSkillProvider {
        val p = LocalSkillProvider(tmpHome, context)
        p.configStore.load()
        return p
    }

    private fun privateSkill(provider: LocalSkillProvider, id: String): JSONObject? {
        val skills = provider.configStore.getPrivateSkills()
        for (i in 0 until skills.length()) {
            val s = skills.optJSONObject(i) ?: continue
            if (s.optString("id") == id) return s
        }
        return null
    }

    @Test
    fun `installing a prompt keeps the marketplace id and records a package`() = runTest {
        seedCatalog(promptEntry("standup-notes", "1.0.0", "write my standup"))
        val provider = newProvider()

        val res = provider.install("standup-notes")

        assertEquals("installed", res.optString("status"))
        assertEquals("prompt", res.optString("type"))

        val row = privateSkill(provider, "standup-notes")
        assertNotNull("the prompt must be stored under its MARKETPLACE id", row)
        assertEquals("write my standup", row!!.optString("prompt"))
        assertEquals("marketplace", row.optString("source"))

        // Without a package record the renderer's update check hits `if (!pkg) continue`
        // and an installed prompt could NEVER be flagged out of date.
        val pkg = provider.configStore.getPackages().optJSONObject("standup-notes")
        assertNotNull("install must record a package", pkg)
        assertEquals("1.0.0", pkg!!.optString("version"))
        assertEquals("marketplace", pkg.optString("source"))
    }

    @Test
    fun `updating a prompt rewrites its text and moves the recorded version`() = runTest {
        seedCatalog(promptEntry("standup-notes", "1.0.0", "write my standup"))
        val provider = newProvider()
        provider.install("standup-notes")

        // The catalog now lists newer text under a newer version.
        seedCatalog(promptEntry("standup-notes", "1.1.0", "write my standup, with blockers"))
        val res = provider.update("standup-notes")

        assertTrue(res.optBoolean("ok"))
        assertEquals("1.1.0", res.optString("newVersion"))
        assertEquals(
            "the stored prompt text must actually be rewritten",
            "write my standup, with blockers",
            privateSkill(provider, "standup-notes")!!.optString("prompt"),
        )
        assertEquals(
            "1.1.0",
            provider.configStore.getPackages().optJSONObject("standup-notes")!!.optString("version"),
        )
    }

    @Test
    fun `updating a prompt that is not installed reports failure, not success`() = runTest {
        seedCatalog(promptEntry("standup-notes", "1.1.0", "write my standup, with blockers"))
        val provider = newProvider()

        val res = provider.update("standup-notes")

        assertFalse("nothing was rewritten, so this must not claim success", res.optBoolean("ok"))
        assertTrue(
            "the error must name what actually went wrong: ${res.optString("error")}",
            res.optString("error").contains("standup-notes"),
        )
        assertNull(privateSkill(provider, "standup-notes"))
    }

    @Test
    fun `uninstalling a prompt clears its package record too`() = runTest {
        seedCatalog(promptEntry("standup-notes", "1.0.0", "write my standup"))
        val provider = newProvider()
        provider.install("standup-notes")

        provider.uninstall("standup-notes")

        assertNull(privateSkill(provider, "standup-notes"))
        // A leftover package record would keep counting a ghost item in the
        // Library's "Updates" tab forever.
        assertFalse(provider.configStore.getPackages().has("standup-notes"))
    }

    @Test
    fun `a hand-made prompt with no id still gets one`() {
        val store = SkillConfigStore(tmpHome)
        store.load()
        // Share-link imports and Settings-created prompts arrive with no id.
        // Without a minted one the row is unaddressable — it can never be
        // updated, favorited or deleted (all of those look it up by id).
        val created = store.createPromptSkill(
            JSONObject().put("displayName", "Imported").put("prompt", "hi").put("type", "prompt"),
        )
        assertNotNull(created)
        assertTrue(
            "expected a minted user: id, got '${created!!.optString("id")}'",
            created.optString("id").startsWith("user:"),
        )
    }
}
