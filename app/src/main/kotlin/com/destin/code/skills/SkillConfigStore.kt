package com.destin.code.skills

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Reads/writes ~/.claude/destincode-skills.json.
 * Provides favorites, chips, overrides, and private prompt-skill storage.
 */
class SkillConfigStore(private val homeDir: File) {

    private val configFile: File get() = File(homeDir, ".claude/destincode-skills.json")
    private var config: JSONObject = JSONObject()

    companion object {
        private const val MAX_CHIPS = 10
        private const val MAX_PRIVATE_SKILLS = 100

        private val DEFAULT_CHIPS = listOf(
            "Journal", "Inbox", "Git Status", "Review PR",
            "Fix Tests", "Briefing", "Draft Text"
        )
    }

    fun configExists(): Boolean = configFile.exists()

    fun load() {
        if (!configFile.exists()) {
            migrate(JSONArray())
            return
        }
        try {
            val text = configFile.readText()
            config = JSONObject(text)
        } catch (_: Exception) {
            // Back up corrupt file
            val bak = File(configFile.absolutePath + ".bak")
            try { configFile.copyTo(bak, overwrite = true) } catch (_: Exception) {}
            migrate(JSONArray())
        }
    }

    fun reload() {
        load()
    }

    fun migrate(existingSkillIds: JSONArray) {
        config = JSONObject().apply {
            put("favorites", JSONArray())
            put("chips", JSONArray(DEFAULT_CHIPS))
            put("overrides", JSONObject())
            put("privateSkills", JSONArray())
        }
        save()
    }

    fun save() {
        configFile.parentFile?.mkdirs()
        val tmp = File(configFile.absolutePath + ".tmp")
        tmp.writeText(config.toString(2))
        tmp.renameTo(configFile)
    }

    // ── Favorites ──────────────────────────────────────────────────

    fun getFavorites(): JSONArray = config.optJSONArray("favorites") ?: JSONArray()

    fun setFavorite(skillId: String, favorite: Boolean) {
        val favs = getFavorites()
        val existing = mutableListOf<String>()
        for (i in 0 until favs.length()) {
            existing.add(favs.getString(i))
        }
        if (favorite && skillId !in existing) {
            existing.add(skillId)
        } else if (!favorite) {
            existing.remove(skillId)
        }
        config.put("favorites", JSONArray(existing))
        save()
    }

    // ── Chips ──────────────────────────────────────────────────────

    fun getChips(): JSONArray = config.optJSONArray("chips") ?: JSONArray(DEFAULT_CHIPS)

    fun setChips(chips: JSONArray) {
        val limited = JSONArray()
        val count = minOf(chips.length(), MAX_CHIPS)
        for (i in 0 until count) {
            limited.put(chips.get(i))
        }
        config.put("chips", limited)
        save()
    }

    // ── Overrides ──────────────────────────────────────────────────

    fun getOverrides(): JSONObject = config.optJSONObject("overrides") ?: JSONObject()

    fun getOverride(skillId: String): JSONObject? =
        getOverrides().optJSONObject(skillId)

    fun setOverride(skillId: String, overrideData: JSONObject) {
        val overrides = getOverrides()
        overrides.put(skillId, overrideData)
        config.put("overrides", overrides)
        save()
    }

    // ── Private / Prompt Skills ────────────────────────────────────

    fun getPrivateSkills(): JSONArray =
        config.optJSONArray("privateSkills") ?: JSONArray()

    fun createPromptSkill(skill: JSONObject): JSONObject? {
        val skills = getPrivateSkills()
        if (skills.length() >= MAX_PRIVATE_SKILLS) return null
        skills.put(skill)
        config.put("privateSkills", skills)
        save()
        return skill
    }

    fun deletePromptSkill(skillId: String) {
        // Remove from privateSkills
        val skills = getPrivateSkills()
        val filtered = JSONArray()
        for (i in 0 until skills.length()) {
            val s = skills.optJSONObject(i)
            if (s != null && s.optString("id") != skillId) {
                filtered.put(s)
            }
        }
        config.put("privateSkills", filtered)

        // Cascade: remove from favorites
        val favs = getFavorites()
        val filteredFavs = JSONArray()
        for (i in 0 until favs.length()) {
            val id = favs.optString(i)
            if (id != skillId) filteredFavs.put(id)
        }
        config.put("favorites", filteredFavs)

        // Cascade: remove from chips
        val chips = getChips()
        val filteredChips = JSONArray()
        for (i in 0 until chips.length()) {
            val chip = chips.optString(i)
            if (chip != skillId) filteredChips.put(chip)
        }
        config.put("chips", filteredChips)

        // Cascade: remove from overrides
        val overrides = getOverrides()
        overrides.remove(skillId)
        config.put("overrides", overrides)

        save()
    }
}
