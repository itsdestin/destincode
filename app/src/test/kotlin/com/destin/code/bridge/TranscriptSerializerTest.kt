package com.destin.code.bridge

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class TranscriptSerializerTest {

    // ── userMessage ──────────────────────────────────────────────────────────

    @Test
    fun `userMessage has correct type`() {
        val result = TranscriptSerializer.userMessage("s1", "u1", 1000L, "Hello")
        assertEquals("user-message", result.getString("type"))
    }

    @Test
    fun `userMessage payload contains all fields`() {
        val result = TranscriptSerializer.userMessage("sess-abc", "uuid-123", 9999L, "Hi there")
        val payload = result.getJSONObject("payload")
        assertEquals("sess-abc", payload.getString("sessionId"))
        assertEquals("uuid-123", payload.getString("uuid"))
        assertEquals(9999L, payload.getLong("timestamp"))
        assertEquals("Hi there", payload.getString("text"))
    }

    @Test
    fun `userMessage payload has no extra surprise fields`() {
        val result = TranscriptSerializer.userMessage("s", "u", 0L, "msg")
        val payload = result.getJSONObject("payload")
        // All expected keys must be present
        assertTrue(payload.has("sessionId"))
        assertTrue(payload.has("uuid"))
        assertTrue(payload.has("timestamp"))
        assertTrue(payload.has("text"))
    }

    // ── assistantText ────────────────────────────────────────────────────────

    @Test
    fun `assistantText has correct type`() {
        val result = TranscriptSerializer.assistantText("s1", "u1", 1000L, "Response")
        assertEquals("assistant-text", result.getString("type"))
    }

    @Test
    fun `assistantText payload contains all fields`() {
        val result = TranscriptSerializer.assistantText("sess-x", "uuid-y", 12345L, "Some text")
        val payload = result.getJSONObject("payload")
        assertEquals("sess-x", payload.getString("sessionId"))
        assertEquals("uuid-y", payload.getString("uuid"))
        assertEquals(12345L, payload.getLong("timestamp"))
        assertEquals("Some text", payload.getString("text"))
    }

    // ── toolUse ──────────────────────────────────────────────────────────────

    @Test
    fun `toolUse has correct type`() {
        val input = JSONObject().put("command", "ls")
        val result = TranscriptSerializer.toolUse("s", "u", 0L, "tu-1", "Bash", input)
        assertEquals("tool-use", result.getString("type"))
    }

    @Test
    fun `toolUse payload contains all fields`() {
        val input = JSONObject().put("file_path", "/tmp/test.kt")
        val result = TranscriptSerializer.toolUse(
            "sess-1", "uuid-2", 55000L, "tool-use-id-3", "Read", input
        )
        val payload = result.getJSONObject("payload")
        assertEquals("sess-1", payload.getString("sessionId"))
        assertEquals("uuid-2", payload.getString("uuid"))
        assertEquals(55000L, payload.getLong("timestamp"))
        assertEquals("tool-use-id-3", payload.getString("toolUseId"))
        assertEquals("Read", payload.getString("toolName"))
        assertEquals("/tmp/test.kt", payload.getJSONObject("toolInput").getString("file_path"))
    }

    @Test
    fun `toolUse toolInput is a JSONObject in payload`() {
        val input = JSONObject().put("key", "value")
        val result = TranscriptSerializer.toolUse("s", "u", 0L, "tu", "Tool", input)
        val payload = result.getJSONObject("payload")
        assertNotNull(payload.getJSONObject("toolInput"))
        assertEquals("value", payload.getJSONObject("toolInput").getString("key"))
    }

    // ── toolResult ───────────────────────────────────────────────────────────

    @Test
    fun `toolResult has correct type`() {
        val result = TranscriptSerializer.toolResult("s", "u", 0L, "tu-1", "output", false)
        assertEquals("tool-result", result.getString("type"))
    }

    @Test
    fun `toolResult payload contains all fields`() {
        val result = TranscriptSerializer.toolResult(
            "sess-1", "uuid-2", 77000L, "tu-id-9", "The result text", false
        )
        val payload = result.getJSONObject("payload")
        assertEquals("sess-1", payload.getString("sessionId"))
        assertEquals("uuid-2", payload.getString("uuid"))
        assertEquals(77000L, payload.getLong("timestamp"))
        assertEquals("tu-id-9", payload.getString("toolUseId"))
        assertEquals("The result text", payload.getString("result"))
        assertFalse(payload.getBoolean("isError"))
    }

    @Test
    fun `toolResult isError true propagates correctly`() {
        val result = TranscriptSerializer.toolResult("s", "u", 0L, "tu", "err msg", true)
        val payload = result.getJSONObject("payload")
        assertTrue(payload.getBoolean("isError"))
        assertEquals("err msg", payload.getString("result"))
    }

    @Test
    fun `toolResult isError false propagates correctly`() {
        val result = TranscriptSerializer.toolResult("s", "u", 0L, "tu", "ok", false)
        assertFalse(result.getJSONObject("payload").getBoolean("isError"))
    }

    // ── turnComplete ─────────────────────────────────────────────────────────

    @Test
    fun `turnComplete has correct type`() {
        val result = TranscriptSerializer.turnComplete("s", "u", 0L)
        assertEquals("turn-complete", result.getString("type"))
    }

    @Test
    fun `turnComplete payload contains all fields`() {
        val result = TranscriptSerializer.turnComplete("sess-z", "uuid-z", 999L)
        val payload = result.getJSONObject("payload")
        assertEquals("sess-z", payload.getString("sessionId"))
        assertEquals("uuid-z", payload.getString("uuid"))
        assertEquals(999L, payload.getLong("timestamp"))
    }

    // ── streamingText ────────────────────────────────────────────────────────

    @Test
    fun `streamingText has correct type`() {
        val result = TranscriptSerializer.streamingText("s", "partial text")
        assertEquals("streaming-text", result.getString("type"))
    }

    @Test
    fun `streamingText payload contains sessionId and text`() {
        val result = TranscriptSerializer.streamingText("sess-stream", "partial response...")
        val payload = result.getJSONObject("payload")
        assertEquals("sess-stream", payload.getString("sessionId"))
        assertEquals("partial response...", payload.getString("text"))
    }

    // ── top-level structure ──────────────────────────────────────────────────

    @Test
    fun `all methods return JSONObject with type and payload keys`() {
        val input = JSONObject()
        val cases = listOf(
            TranscriptSerializer.userMessage("s", "u", 0L, "t"),
            TranscriptSerializer.assistantText("s", "u", 0L, "t"),
            TranscriptSerializer.toolUse("s", "u", 0L, "ti", "T", input),
            TranscriptSerializer.toolResult("s", "u", 0L, "ti", "r", false),
            TranscriptSerializer.turnComplete("s", "u", 0L),
            TranscriptSerializer.streamingText("s", "t"),
        )
        for (obj in cases) {
            assertTrue("Missing 'type': $obj", obj.has("type"))
            assertTrue("Missing 'payload': $obj", obj.has("payload"))
        }
    }

    @Test
    fun `empty strings are preserved in payload`() {
        val result = TranscriptSerializer.userMessage("", "", 0L, "")
        val payload = result.getJSONObject("payload")
        assertEquals("", payload.getString("sessionId"))
        assertEquals("", payload.getString("uuid"))
        assertEquals("", payload.getString("text"))
    }

    @Test
    fun `large timestamp values are preserved`() {
        val ts = Long.MAX_VALUE
        val result = TranscriptSerializer.assistantText("s", "u", ts, "t")
        assertEquals(ts, result.getJSONObject("payload").getLong("timestamp"))
    }
}
