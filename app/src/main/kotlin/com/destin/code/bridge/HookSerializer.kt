package com.destin.code.bridge

import org.json.JSONArray
import org.json.JSONObject

/**
 * Converts HookEvent data into the JSON envelope format the desktop React app
 * expects on its `hook:event` WebSocket channel.
 *
 * Every method returns `{ type: "hook:event", payload: JSONObject }` where the
 * payload always includes a `hook_event_name` discriminator field.
 */
object HookSerializer {

    fun permissionRequest(
        sessionId: String,
        requestId: String,
        toolName: String,
        toolInput: JSONObject,
        suggestions: List<String>,
    ): JSONObject {
        val suggestionsArray = JSONArray().apply {
            suggestions.forEach { put(it) }
        }
        val payload = JSONObject().apply {
            put("hook_event_name", "PermissionRequest")
            put("sessionId", sessionId)
            put("requestId", requestId)
            put("toolName", toolName)
            put("toolInput", toolInput)
            put("suggestions", suggestionsArray)
        }
        return envelope(payload)
    }

    fun permissionExpired(sessionId: String, requestId: String): JSONObject {
        val payload = JSONObject().apply {
            put("hook_event_name", "PermissionExpired")
            put("sessionId", sessionId)
            put("requestId", requestId)
        }
        return envelope(payload)
    }

    fun notification(sessionId: String, message: String): JSONObject {
        val payload = JSONObject().apply {
            put("hook_event_name", "Notification")
            put("sessionId", sessionId)
            put("message", message)
        }
        return envelope(payload)
    }

    private fun envelope(payload: JSONObject): JSONObject =
        JSONObject().apply {
            put("type", "hook:event")
            put("payload", payload)
        }
}
