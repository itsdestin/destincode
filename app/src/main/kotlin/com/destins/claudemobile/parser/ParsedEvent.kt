package com.destins.claudemobile.parser

import org.json.JSONArray
import org.json.JSONObject

sealed class ParsedEvent {
    data class Text(val text: String) : ParsedEvent()
    data class ApprovalPrompt(val tool: String, val summary: String) : ParsedEvent()
    data class ToolStart(val tool: String, val args: String) : ParsedEvent()
    data class ToolEnd(val tool: String, val duration: Long?) : ParsedEvent()
    data class DiffBlock(val filename: String, val hunks: List<DiffHunk>) : ParsedEvent()
    data class CodeBlock(val language: String, val code: String) : ParsedEvent()
    data class Error(val message: String, val details: String) : ParsedEvent()
    data class Progress(val message: String) : ParsedEvent()
    data class InteractiveMenu(val raw: String) : ParsedEvent()
    data class Confirmation(val question: String) : ParsedEvent()
    data class TextPrompt(val prompt: String) : ParsedEvent()
    data class OAuthRedirect(val url: String) : ParsedEvent()

    companion object {
        fun fromJson(json: String): ParsedEvent? {
            return try {
                val obj = JSONObject(json)
                when (obj.getString("type")) {
                    "text" -> Text(text = obj.optString("text", ""))
                    "approval_prompt" -> ApprovalPrompt(
                        tool = obj.optString("tool", ""),
                        summary = obj.optString("summary", "")
                    )
                    "tool_start" -> ToolStart(
                        tool = obj.optString("tool", ""),
                        args = obj.optString("args", "")
                    )
                    "tool_end" -> ToolEnd(
                        tool = obj.optString("tool", ""),
                        duration = if (obj.has("duration")) obj.getLong("duration") else null
                    )
                    "diff_block" -> DiffBlock(
                        filename = obj.optString("filename", ""),
                        hunks = parseDiffHunks(obj.optJSONArray("hunks"))
                    )
                    "code_block" -> CodeBlock(
                        language = obj.optString("language", ""),
                        code = obj.optString("code", "")
                    )
                    "error" -> Error(
                        message = obj.optString("message", ""),
                        details = obj.optString("details", "")
                    )
                    "progress" -> Progress(message = obj.optString("message", ""))
                    "interactive_menu" -> InteractiveMenu(raw = obj.optString("raw", ""))
                    "confirmation" -> Confirmation(question = obj.optString("question", ""))
                    "text_prompt" -> TextPrompt(prompt = obj.optString("prompt", ""))
                    "oauth_redirect" -> OAuthRedirect(url = obj.optString("url", ""))
                    // Backward compat with Phase 1 events
                    "raw" -> Text(text = obj.optString("text", ""))
                    "tool_call" -> ToolStart(
                        tool = obj.optString("tool", ""),
                        args = obj.optString("raw", "")
                    )
                    else -> Text(text = obj.optString("text", json))
                }
            } catch (e: Exception) {
                null
            }
        }

        private fun parseDiffHunks(arr: JSONArray?): List<DiffHunk> {
            if (arr == null) return emptyList()
            return (0 until arr.length()).map { i ->
                val h = arr.getJSONObject(i)
                DiffHunk(
                    header = h.optString("header", ""),
                    lines = h.optString("lines", "")
                )
            }
        }
    }
}

data class DiffHunk(val header: String, val lines: String)
