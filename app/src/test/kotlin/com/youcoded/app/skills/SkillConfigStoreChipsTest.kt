package com.youcoded.app.skills

import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.io.File

/**
 * Regression coverage for the Android-only "uninstalling a plugin wipes every
 * quick-chip prompt" bug, found 2026-08-28 while adding the chip edit surface.
 *
 * Chips are `{label, prompt, skillId?}` objects, but removePackage()'s cascade
 * read them with JSONArray.optString(i) — copied from the favorites loop above
 * it, where the elements really are bare strings. On an object that returns the
 * object's toString(), so:
 *   - the comparison never matched the uninstalled id (nothing was cascaded);
 *   - the JSON blob STRING was written back in place of the object;
 *   - migrateLegacyStringChips() then saw a string-shaped array on the next
 *     load and promoted each blob to `{label: "<blob>", prompt: ""}`.
 * Net effect: uninstall anything, lose every chip's prompt. Desktop's
 * skill-config-store.ts has always filtered on `c.skillId !== id` correctly.
 */
class SkillConfigStoreChipsTest {

    private lateinit var tmpHome: File

    private fun chip(label: String, prompt: String, skillId: String? = null) =
        JSONObject().put("label", label).put("prompt", prompt).apply {
            if (skillId != null) put("skillId", skillId)
        }

    private fun seed(vararg chips: JSONObject) {
        val cfg = JSONObject()
            .put("version", 2)
            .put("favorites", JSONArray())
            .put("chips", JSONArray().apply { chips.forEach { put(it) } })
            .put("overrides", JSONObject())
            .put("packages", JSONObject().put("journaling-assistant", JSONObject()))
        File(tmpHome, ".claude").mkdirs()
        File(tmpHome, ".claude/youcoded-skills.json").writeText(cfg.toString())
    }

    @Before
    fun setUp() { tmpHome = createTempDir(prefix = "youcoded-chips-") }

    @After
    fun tearDown() { tmpHome.deleteRecursively() }

    @Test
    fun `uninstalling a plugin drops only its own chip`() {
        seed(
            chip("Journal", "let's journal", "journaling-assistant"),
            chip("Git Status", "run git status"),
        )
        SkillConfigStore(tmpHome).removePackage("journaling-assistant")

        val chips = SkillConfigStore(tmpHome).getChips()
        assertEquals(1, chips.length())
        assertEquals("Git Status", chips.getJSONObject(0).getString("label"))
        assertEquals("run git status", chips.getJSONObject(0).getString("prompt"))
    }

    @Test
    fun `uninstalling a plugin leaves unrelated chips as objects with their prompts`() {
        seed(
            chip("Git Status", "run git status and summarize"),
            chip("Review PR", "review the latest PR"),
        )
        SkillConfigStore(tmpHome).removePackage("journaling-assistant")

        val chips = SkillConfigStore(tmpHome).getChips()
        assertEquals(2, chips.length())
        // The bug turned each element into a stringified blob here, which the
        // migration then flattened into an empty prompt.
        for (i in 0 until chips.length()) {
            assertTrue("chip $i is no longer an object", chips.opt(i) is JSONObject)
            assertTrue("chip $i lost its prompt", chips.getJSONObject(i).getString("prompt").isNotEmpty())
        }
        assertEquals("run git status and summarize", chips.getJSONObject(0).getString("prompt"))
    }

    @Test
    fun `a chip with no skillId is never cascaded away`() {
        seed(chip("Draft Text", "help me draft a text to "))
        SkillConfigStore(tmpHome).removePackage("journaling-assistant")

        val chips = SkillConfigStore(tmpHome).getChips()
        assertEquals(1, chips.length())
        assertEquals("Draft Text", chips.getJSONObject(0).getString("label"))
    }
}
