package com.destin.code.bridge

import org.json.JSONObject

/** Minimal stub — full implementation in Task 3 */
object MessageRouter {
    data class ParsedMessage(
        val type: String,
        val id: String?,
        val payload: JSONObject
    )

    fun parseMessage(raw: String): ParsedMessage? {
        return try {
            val json = JSONObject(raw)
            ParsedMessage(
                type = json.getString("type"),
                id = json.optString("id", null),
                payload = json.optJSONObject("payload") ?: JSONObject()
            )
        } catch (e: Exception) {
            null
        }
    }

    fun buildAuthOkResponse(platform: String): JSONObject {
        return JSONObject().apply {
            put("type", "auth:ok")
            put("token", java.util.UUID.randomUUID().toString())
            put("platform", platform)
        }
    }
}
