package com.youcoded.app.runtime

import org.json.JSONObject
import java.io.File

/**
 * Seed `cleanupPeriodDays` into ~/.claude/settings.json when the key is
 * absent. Claude Code deletes transcripts older than this (its default is 30
 * days when unset), which silently destroys Resume Browser history. Mirrors
 * desktop retention-default.ts — only writes when absent, so an explicit user
 * value is respected. Never rewrites a corrupt settings.json (it carries
 * hooks + enabledPlugins; wiping them is worse than skipping the seed).
 */
class RetentionDefault(homeDir: File) {
    private val settingsFile = File(homeDir, ".claude/settings.json")

    companion object {
        const val DEFAULT_DAYS = 365
    }

    /** @return true iff settings.json was rewritten with the seeded default. */
    fun seedIfAbsent(): Boolean {
        return try {
            // Read existing settings, or start fresh only when the file is
            // genuinely missing. A parse failure below throws into the catch,
            // which deliberately does NOT rewrite — we must not clobber hooks.
            val root = if (settingsFile.exists()) JSONObject(settingsFile.readText()) else JSONObject()
            if (root.has("cleanupPeriodDays")) return false
            root.put("cleanupPeriodDays", DEFAULT_DAYS)
            settingsFile.parentFile?.mkdirs()
            // Atomic write (tmp + rename) — same convention as PromptSuggestionDisabler.
            val tmp = File(settingsFile.parentFile, settingsFile.name + ".tmp")
            tmp.writeText(root.toString(2))
            if (!tmp.renameTo(settingsFile)) settingsFile.writeText(root.toString(2))
            true
        } catch (_: Throwable) {
            false // corrupt/unreadable settings — skip rather than risk wiping hooks
        }
    }
}
