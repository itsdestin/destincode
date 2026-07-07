package com.youcoded.app.runtime

import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Force `promptSuggestionEnabled: false` in ~/.claude/settings.json on every
 * launch. Mirror of desktop/src/main/disable-prompt-suggestion.ts.
 *
 * Claude Code 2.1.x ships an opt-out next-prompt suggestion feature that
 * pre-fills ghost text into the input bar. The interaction is buggy in
 * YouCoded — our chat→PTY write path streams body bytes + `\r` directly
 * without clearing CC's input buffer, so suggestion ghost text gets
 * concatenated with the user's chat send and submitted as one combined
 * user prompt. Re-enable here only if/when the underlying interaction is
 * fixed.
 */
class PromptSuggestionDisabler(private val homeDir: File) {

    data class Result(val changed: Boolean, val priorWasEnabled: Boolean?)

    private val settingsFile = File(homeDir, ".claude/settings.json")

    private fun readSettings(): JSONObject =
        try { if (settingsFile.exists()) JSONObject(settingsFile.readText()) else JSONObject() }
        catch (_: Exception) { JSONObject() }

    private fun writeSettingsAtomic(settings: JSONObject) {
        settingsFile.parentFile?.mkdirs()
        val tmp = File(settingsFile.parentFile, "${settingsFile.name}.${android.os.Process.myPid()}.tmp")
        tmp.writeText(settings.toString(2))
        if (!tmp.renameTo(settingsFile)) {
            settingsFile.writeText(settings.toString(2))
            tmp.delete()
        }
    }

    fun enforce(): Result {
        val settings = readSettings()
        // CC's default is "enabled when absent or true". Convert that to a
        // tri-state so callers can log "was enabled" vs "was already false".
        val prior: Boolean? = if (settings.has("promptSuggestionEnabled")) {
            settings.optBoolean("promptSuggestionEnabled", true)
        } else null

        if (prior == false) return Result(changed = false, priorWasEnabled = false)

        settings.put("promptSuggestionEnabled", false)
        writeSettingsAtomic(settings)
        return Result(changed = true, priorWasEnabled = prior)
    }

    companion object {
        private const val TAG = "PromptSuggestionDisabler"
    }
}
