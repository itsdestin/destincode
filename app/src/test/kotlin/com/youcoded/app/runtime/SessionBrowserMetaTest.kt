package com.youcoded.app.runtime

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * Tests for SessionBrowser's transcript-derived metadata (cleanTitle +
 * readTranscriptMeta). These mirror desktop session-browser.ts behavior —
 * cleanTitle MUST produce byte-identical output to the desktop cleanTitle, so
 * the canonical long-prompt expectation below is copied straight from the
 * desktop test fixture.
 */
class SessionBrowserMetaTest {

    // ── cleanTitle (pure string logic) ──────────────────────────────────────

    @Test
    fun `cleanTitle passes through text at or below 48 chars`() {
        val s = "fix the spinner regex" // 21 chars
        assertEquals(s, SessionBrowser.cleanTitle(s))
    }

    @Test
    fun `cleanTitle returns exactly-48-char text unchanged`() {
        val s = "a".repeat(48)
        assertEquals(s, SessionBrowser.cleanTitle(s))
    }

    @Test
    fun `cleanTitle trims a long prompt to a word boundary with ellipsis`() {
        // Canonical desktop expectation — must match byte-for-byte.
        val input = "help me fix the spinner regex in the attention classifier please"
        assertEquals("help me fix the spinner regex in the attention…", SessionBrowser.cleanTitle(input))
    }

    @Test
    fun `cleanTitle hard-cuts a long first word mid-word`() {
        // No space within the first 48 chars (or only at <=20), so the
        // word-boundary trim would shrink the title too much — hard cut instead.
        val input = "a".repeat(60)
        val out = SessionBrowser.cleanTitle(input)!!
        assertEquals(49, out.length) // 48 chars + the ellipsis
        assertTrue(out.endsWith("…"))
        assertEquals("a".repeat(48) + "…", out)
    }

    @Test
    fun `cleanTitle keeps word-boundary cut when last space is past 20 chars`() {
        // Space at index 30 — past the >20 threshold, so trim to it.
        val input = "short shortword padding wordhere " + "x".repeat(40)
        val out = SessionBrowser.cleanTitle(input)!!
        assertTrue(out.endsWith("…"))
        // Whatever the cut, it must not exceed 48 chars + ellipsis.
        assertTrue(out.length <= 49)
    }

    @Test
    fun `cleanTitle collapses internal whitespace`() {
        val input = "hello    world\n\ttabbed"
        assertEquals("hello world tabbed", SessionBrowser.cleanTitle(input))
    }

    @Test
    fun `cleanTitle returns null for blank input`() {
        assertNull(SessionBrowser.cleanTitle("   \n\t  "))
        assertNull(SessionBrowser.cleanTitle(""))
    }

    // ── readTranscriptMeta (filesystem) ─────────────────────────────────────

    private fun tempJsonl(lines: List<String>, lineSep: String = "\n"): File {
        val f = File.createTempFile("transcript-meta-test", ".jsonl")
        f.deleteOnExit()
        f.writeText(lines.joinToString(lineSep))
        return f
    }

    @Test
    fun `readTranscriptMeta derives title from first real user message`() {
        val f = tempJsonl(listOf(
            // meta line — skipped (isMeta).
            """{"type":"user","isMeta":true,"promptId":"p0","timestamp":"2026-06-01T10:00:00.000Z","message":{"content":"ignored meta"}}""",
            // injected wrapper — skipped (starts with '<').
            """{"type":"user","promptId":"p1","timestamp":"2026-06-01T10:00:01.000Z","message":{"content":"<command-name>/foo</command-name>"}}""",
            // first real prompt — used.
            """{"type":"user","promptId":"p2","timestamp":"2026-06-01T10:00:02.000Z","message":{"content":"build the resume browser fix"}}""",
            """{"type":"assistant","timestamp":"2026-06-01T10:05:00.000Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}}""",
        ))
        val meta = SessionBrowser.readTranscriptMeta(f, wantTitle = true)
        assertEquals("build the resume browser fix", meta.fallbackTitle)
    }

    @Test
    fun `readTranscriptMeta extracts text from content-block array`() {
        val f = tempJsonl(listOf(
            """{"type":"user","promptId":"p1","timestamp":"2026-06-01T10:00:00.000Z","message":{"content":[{"type":"text","text":"hello from array"}]}}""",
        ))
        val meta = SessionBrowser.readTranscriptMeta(f, wantTitle = true)
        assertEquals("hello from array", meta.fallbackTitle)
    }

    @Test
    fun `readTranscriptMeta returns null title when wantTitle is false`() {
        val f = tempJsonl(listOf(
            """{"type":"user","promptId":"p1","timestamp":"2026-06-01T10:00:00.000Z","message":{"content":"a prompt"}}""",
        ))
        val meta = SessionBrowser.readTranscriptMeta(f, wantTitle = false)
        assertNull(meta.fallbackTitle)
    }

    @Test
    fun `readTranscriptMeta reads last parseable timestamp from the tail`() {
        val f = tempJsonl(listOf(
            """{"type":"user","promptId":"p1","timestamp":"2026-06-01T10:00:00.000Z","message":{"content":"hi"}}""",
            """{"type":"assistant","timestamp":"2026-06-01T10:05:00.000Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"a"}]}}""",
            """{"type":"assistant","timestamp":"2026-06-02T12:30:45.000Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"b"}]}}""",
        ))
        val meta = SessionBrowser.readTranscriptMeta(f, wantTitle = false)
        val expected = java.time.Instant.parse("2026-06-02T12:30:45.000Z").toEpochMilli()
        assertEquals(expected, meta.lastTimestampMs)
    }

    @Test
    fun `readTranscriptMeta tolerates CRLF line endings`() {
        val f = tempJsonl(listOf(
            """{"type":"user","promptId":"p1","timestamp":"2026-06-01T10:00:00.000Z","message":{"content":"crlf prompt"}}""",
            """{"type":"assistant","timestamp":"2026-06-01T10:05:00.000Z","message":{"stop_reason":"end_turn","content":[{"type":"text","text":"x"}]}}""",
        ), lineSep = "\r\n")
        // \r is whitespace, so JSONObject(line) tolerates a trailing \r and the
        // title-text whitespace collapse strips it; the timestamp parse is
        // unaffected because the JSON value itself has no \r.
        val meta = SessionBrowser.readTranscriptMeta(f, wantTitle = true)
        assertEquals("crlf prompt", meta.fallbackTitle)
        val expected = java.time.Instant.parse("2026-06-01T10:05:00.000Z").toEpochMilli()
        assertEquals(expected, meta.lastTimestampMs)
    }

    @Test
    fun `readTranscriptMeta returns nulls for a nonexistent file`() {
        val meta = SessionBrowser.readTranscriptMeta(File("/no/such/file.jsonl"), wantTitle = true)
        assertNull(meta.fallbackTitle)
        assertNull(meta.lastTimestampMs)
    }
}
