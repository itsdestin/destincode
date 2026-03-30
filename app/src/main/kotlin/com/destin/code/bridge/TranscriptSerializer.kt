package com.destin.code.bridge

import org.json.JSONObject

/**
 * Converts TranscriptEvent data into the JSON envelope format the desktop
 * React app expects on its `transcript:event` WebSocket channel.
 *
 * Every method returns `{ type: String, payload: JSONObject }`.
 */
object TranscriptSerializer {

    fun userMessage(sessionId: String, uuid: String, timestamp: Long, text: String): JSONObject {
        val payload = JSONObject().apply {
            put("sessionId", sessionId)
            put("uuid", uuid)
            put("timestamp", timestamp)
            put("text", text)
        }
        return envelope("user-message", payload)
    }

    fun assistantText(sessionId: String, uuid: String, timestamp: Long, text: String): JSONObject {
        val payload = JSONObject().apply {
            put("sessionId", sessionId)
            put("uuid", uuid)
            put("timestamp", timestamp)
            put("text", text)
        }
        return envelope("assistant-text", payload)
    }

    fun toolUse(
        sessionId: String,
        uuid: String,
        timestamp: Long,
        toolUseId: String,
        toolName: String,
        toolInput: JSONObject,
    ): JSONObject {
        val payload = JSONObject().apply {
            put("sessionId", sessionId)
            put("uuid", uuid)
            put("timestamp", timestamp)
            put("toolUseId", toolUseId)
            put("toolName", toolName)
            put("toolInput", toolInput)
        }
        return envelope("tool-use", payload)
    }

    fun toolResult(
        sessionId: String,
        uuid: String,
        timestamp: Long,
        toolUseId: String,
        result: String,
        isError: Boolean,
    ): JSONObject {
        val payload = JSONObject().apply {
            put("sessionId", sessionId)
            put("uuid", uuid)
            put("timestamp", timestamp)
            put("toolUseId", toolUseId)
            put("result", result)
            put("isError", isError)
        }
        return envelope("tool-result", payload)
    }

    fun turnComplete(sessionId: String, uuid: String, timestamp: Long): JSONObject {
        val payload = JSONObject().apply {
            put("sessionId", sessionId)
            put("uuid", uuid)
            put("timestamp", timestamp)
        }
        return envelope("turn-complete", payload)
    }

    fun streamingText(sessionId: String, text: String): JSONObject {
        val payload = JSONObject().apply {
            put("sessionId", sessionId)
            put("text", text)
        }
        return envelope("streaming-text", payload)
    }

    private fun envelope(type: String, payload: JSONObject): JSONObject =
        JSONObject().apply {
            put("type", type)
            put("payload", payload)
        }
}
