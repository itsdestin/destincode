package com.destin.code.bridge

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class HookSerializerTest {

    // ── permissionRequest ────────────────────────────────────────────────────

    @Test
    fun `permissionRequest has correct type`() {
        val input = JSONObject().put("command", "ls")
        val result = HookSerializer.permissionRequest("s", "r", "Bash", input, emptyList())
        assertEquals("hook:event", result.getString("type"))
    }

    @Test
    fun `permissionRequest payload has correct hook_event_name`() {
        val result = HookSerializer.permissionRequest("s", "r", "Bash", JSONObject(), emptyList())
        val payload = result.getJSONObject("payload")
        assertEquals("PermissionRequest", payload.getString("hook_event_name"))
    }

    @Test
    fun `permissionRequest payload contains all fields`() {
        val input = JSONObject().put("file_path", "/tmp/x")
        val result = HookSerializer.permissionRequest(
            "sess-1", "req-42", "Read", input, listOf("allow", "deny")
        )
        val payload = result.getJSONObject("payload")
        assertEquals("sess-1", payload.getString("sessionId"))
        assertEquals("req-42", payload.getString("requestId"))
        assertEquals("Read", payload.getString("toolName"))
        assertEquals("/tmp/x", payload.getJSONObject("toolInput").getString("file_path"))
    }

    @Test
    fun `permissionRequest suggestions is a JSONArray with correct values`() {
        val result = HookSerializer.permissionRequest(
            "s", "r", "T", JSONObject(), listOf("allow", "deny", "ask")
        )
        val suggestions = result.getJSONObject("payload").getJSONArray("suggestions")
        assertEquals(3, suggestions.length())
        assertEquals("allow", suggestions.getString(0))
        assertEquals("deny", suggestions.getString(1))
        assertEquals("ask", suggestions.getString(2))
    }

    @Test
    fun `permissionRequest with empty suggestions list produces empty JSONArray`() {
        val result = HookSerializer.permissionRequest("s", "r", "T", JSONObject(), emptyList())
        val suggestions = result.getJSONObject("payload").getJSONArray("suggestions")
        assertEquals(0, suggestions.length())
    }

    @Test
    fun `permissionRequest with single suggestion`() {
        val result = HookSerializer.permissionRequest("s", "r", "T", JSONObject(), listOf("only"))
        val suggestions = result.getJSONObject("payload").getJSONArray("suggestions")
        assertEquals(1, suggestions.length())
        assertEquals("only", suggestions.getString(0))
    }

    @Test
    fun `permissionRequest toolInput is JSONObject in payload`() {
        val input = JSONObject().put("nested", JSONObject().put("k", "v"))
        val result = HookSerializer.permissionRequest("s", "r", "T", input, emptyList())
        val toolInput = result.getJSONObject("payload").getJSONObject("toolInput")
        assertEquals("v", toolInput.getJSONObject("nested").getString("k"))
    }

    // ── permissionExpired ────────────────────────────────────────────────────

    @Test
    fun `permissionExpired has correct type`() {
        val result = HookSerializer.permissionExpired("s", "r")
        assertEquals("hook:event", result.getString("type"))
    }

    @Test
    fun `permissionExpired payload has correct hook_event_name`() {
        val result = HookSerializer.permissionExpired("s", "r")
        assertEquals("PermissionExpired", result.getJSONObject("payload").getString("hook_event_name"))
    }

    @Test
    fun `permissionExpired payload contains sessionId and requestId`() {
        val result = HookSerializer.permissionExpired("sess-exp", "req-exp")
        val payload = result.getJSONObject("payload")
        assertEquals("sess-exp", payload.getString("sessionId"))
        assertEquals("req-exp", payload.getString("requestId"))
    }

    // ── notification ─────────────────────────────────────────────────────────

    @Test
    fun `notification has correct type`() {
        val result = HookSerializer.notification("s", "msg")
        assertEquals("hook:event", result.getString("type"))
    }

    @Test
    fun `notification payload has correct hook_event_name`() {
        val result = HookSerializer.notification("s", "msg")
        assertEquals("Notification", result.getJSONObject("payload").getString("hook_event_name"))
    }

    @Test
    fun `notification payload contains sessionId and message`() {
        val result = HookSerializer.notification("sess-notif", "Tool completed successfully")
        val payload = result.getJSONObject("payload")
        assertEquals("sess-notif", payload.getString("sessionId"))
        assertEquals("Tool completed successfully", payload.getString("message"))
    }

    @Test
    fun `notification with empty message`() {
        val result = HookSerializer.notification("s", "")
        assertEquals("", result.getJSONObject("payload").getString("message"))
    }

    // ── top-level structure ──────────────────────────────────────────────────

    @Test
    fun `all hook methods return JSONObject with type and payload`() {
        val cases = listOf(
            HookSerializer.permissionRequest("s", "r", "T", JSONObject(), emptyList()),
            HookSerializer.permissionExpired("s", "r"),
            HookSerializer.notification("s", "m"),
        )
        for (obj in cases) {
            assertTrue("Missing 'type': $obj", obj.has("type"))
            assertTrue("Missing 'payload': $obj", obj.has("payload"))
        }
    }

    @Test
    fun `all hook methods emit type hook-event`() {
        val cases = listOf(
            HookSerializer.permissionRequest("s", "r", "T", JSONObject(), emptyList()),
            HookSerializer.permissionExpired("s", "r"),
            HookSerializer.notification("s", "m"),
        )
        for (obj in cases) {
            assertEquals("hook:event", obj.getString("type"))
        }
    }

    @Test
    fun `all hook payloads have hook_event_name field`() {
        val cases = listOf(
            HookSerializer.permissionRequest("s", "r", "T", JSONObject(), emptyList()),
            HookSerializer.permissionExpired("s", "r"),
            HookSerializer.notification("s", "m"),
        )
        for (obj in cases) {
            val payload = obj.getJSONObject("payload")
            assertTrue("Missing 'hook_event_name': $payload", payload.has("hook_event_name"))
        }
    }

    @Test
    fun `empty strings are preserved in hook payloads`() {
        val result = HookSerializer.permissionExpired("", "")
        val payload = result.getJSONObject("payload")
        assertEquals("", payload.getString("sessionId"))
        assertEquals("", payload.getString("requestId"))
    }
}
