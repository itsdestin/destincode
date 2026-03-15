package com.destins.claudemobile.parser

import org.json.JSONObject

sealed class ParsedEvent {
    data class ApprovalPrompt(val summary: String, val raw: String) : ParsedEvent()
    data class ToolCall(val tool: String, val raw: String) : ParsedEvent()
    data class Raw(val text: String) : ParsedEvent()

    companion object {
        fun fromJson(json: String): ParsedEvent? {
            return try {
                val obj = JSONObject(json)
                when (obj.getString("type")) {
                    "approval_prompt" -> ApprovalPrompt(
                        summary = obj.optString("summary", ""),
                        raw = obj.optString("raw", "")
                    )
                    "tool_call" -> ToolCall(
                        tool = obj.optString("tool", ""),
                        raw = obj.optString("raw", "")
                    )
                    "raw" -> Raw(text = obj.optString("text", ""))
                    else -> Raw(text = obj.optString("text", json))
                }
            } catch (e: Exception) {
                null
            }
        }
    }
}
