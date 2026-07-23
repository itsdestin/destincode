package com.youcoded.app.runtime

import android.util.Log
import org.json.JSONObject
import java.io.File

/**
 * Scans Claude Code's project directories for past session JSONL files
 * and loads conversation history for resume. Mirrors the desktop's
 * session-browser.ts module.
 */
object SessionBrowser {
    private const val TAG = "SessionBrowser"
    /** Minimum file size to consider a session (skip empty/aborted). Desktop uses 500. */
    private const val MIN_SESSION_SIZE = 500L
    /** Regex for safe session/slug IDs — prevents path traversal. */
    /** Allow dots for Android package names in slugs (e.g., com.youcoded.app). */
    private val SAFE_ID_RE = Regex("^[a-zA-Z0-9._-]+$")

    // Bounded reads so a 100MB transcript doesn't blow up the browse call.
    // Mirrors desktop session-browser.ts constants exactly.
    private const val HEAD_CHUNK = 256 * 1024
    private const val TAIL_CHUNK = 64 * 1024
    private const val FALLBACK_TITLE_MAX = 48
    private val WHITESPACE_RE = Regex("\\s+")

    data class PastSession(
        val sessionId: String,
        val projectSlug: String,
        val name: String,
        val lastModified: Long,
        val projectPath: String,
        val size: Long,
        /**
         * Title derived from the transcript's first real user message.
         * Used ONLY by SessionService as the last fallback when both the
         * topic file and the conversation-index topic miss ("Untitled").
         * SessionService owns name precedence, so this is carried separately
         * from `name` rather than baked into it.
         */
        val derivedTitle: String? = null,
    )

    data class HistoryMessage(
        val role: String, // "user" or "assistant"
        val content: String,
        val timestamp: Long,
    )

    /**
     * List all past sessions from ~/.claude/projects/ grouped by project.
     * Excludes currently active session IDs and sessions < 500 bytes.
     * Mirrors the desktop's listPastSessions() — no per-call limit (the UI
     * does its own client-side filtering / search / grouping). A previous
     * hardcoded 30-session cap here silently truncated restore results to
     * the 30 most-recent conversations across ALL projects, so a user who
     * just pulled hundreds of JSONLs from Drive saw "about 30" in the
     * Resume Browser regardless of how many actually synced.
     */
    fun listPastSessions(
        projectsDir: File,
        topicsDir: File,
        activeIds: Set<String> = emptySet(),
    ): List<PastSession> {
        if (!projectsDir.exists()) return emptyList()

        val sessions = mutableListOf<PastSession>()

        val projectDirs = projectsDir.listFiles { f -> f.isDirectory } ?: return emptyList()
        for (projectDir in projectDirs) {
            val slug = projectDir.name
            val jsonlFiles = projectDir.listFiles { f ->
                f.extension == "jsonl" && f.length() >= MIN_SESSION_SIZE
            } ?: continue

            for (jsonlFile in jsonlFiles) {
                val sessionId = jsonlFile.nameWithoutExtension
                if (sessionId in activeIds) continue

                // Read the topic name from the topic file if present.
                // "New Session" is the placeholder the auto-title hook writes
                // before the model fills in a real title — normalize it (and a
                // blank/missing file) to "Untitled" so SessionService can apply
                // the conversation-index fallback (the topic file is pruned
                // after 30 days and never syncs across devices).
                val topicFile = File(topicsDir, "topic-$sessionId")
                val rawName = if (topicFile.exists()) topicFile.readText().trim() else ""
                // Literal "Untitled" content is a placeholder too (older clients
                // synced such files) — normalize it explicitly so the index/derived
                // fallback chain applies, matching desktop readTopic.
                val name = if (rawName.isBlank() || rawName == "New Session" || rawName == "Untitled") "Untitled" else rawName

                // Transcript-derived metadata: the content timestamp beats the
                // file mtime (sync restores clobber mtimes), and the first user
                // message names sessions the title pipeline missed. Only ask for
                // a title when the topic file gave us nothing — saves the head
                // read for already-named sessions. Returns nulls on any failure,
                // so this can only improve on the defaults.
                val meta = readTranscriptMeta(jsonlFile, wantTitle = name == "Untitled")

                sessions.add(PastSession(
                    sessionId = sessionId,
                    projectSlug = slug,
                    name = name,
                    lastModified = meta.lastTimestampMs ?: jsonlFile.lastModified(),
                    projectPath = slugToPath(slug),
                    size = jsonlFile.length(),
                    derivedTitle = meta.fallbackTitle,
                ))
            }
        }

        // Dedup on sessionId (parity with desktop session-browser.ts:181).
        // The sync aggregator symlinks/copies project-specific JSONLs into
        // the home-slug project dir, so the same sessionId can appear under
        // two slugs. Prefer the entry with the longest slug — that's the
        // real project dir, so Resume opens with the correct cwd instead
        // of defaulting to $HOME.
        val deduped = HashMap<String, PastSession>()
        for (s in sessions) {
            val existing = deduped[s.sessionId]
            if (existing == null || s.projectSlug.length > existing.projectSlug.length) {
                deduped[s.sessionId] = s
            }
        }
        return deduped.values.sortedByDescending { it.lastModified }
    }

    data class HistoryResult(
        val messages: List<HistoryMessage>,
    )

    /**
     * Load the last N conversational messages from a session's JSONL file.
     * Only includes user prompts (with promptId, not isMeta) and assistant
     * end_turn messages (text blocks only, no tool calls).
     * Single parse, no double read. Mirrors the desktop's loadHistory().
     */
    fun loadHistory(
        projectsDir: File,
        projectSlug: String,
        sessionId: String,
        count: Int = 10,
        all: Boolean = false,
    ): HistoryResult {
        if (!SAFE_ID_RE.matches(projectSlug) || !SAFE_ID_RE.matches(sessionId)) {
            Log.w(TAG, "Invalid slug or sessionId")
            return HistoryResult(emptyList())
        }

        val jsonlFile = File(projectsDir, "$projectSlug/$sessionId.jsonl")
        if (!jsonlFile.exists()) return HistoryResult(emptyList())

        val allMessages = parseConversationalMessages(jsonlFile)
        return if (all) {
            HistoryResult(allMessages)
        } else {
            HistoryResult(allMessages.takeLast(count))
        }
    }

    private fun parseConversationalMessages(jsonlFile: File): List<HistoryMessage> {
        val messages = mutableListOf<HistoryMessage>()
        // Track UUIDs — take last occurrence (handles incremental writes)
        val seenUuids = mutableMapOf<String, Int>()

        try {
            val lines = jsonlFile.readLines()
            for (line in lines) {
                if (line.isBlank()) continue
                val obj = try { JSONObject(line) } catch (_: Exception) { continue }

                val uuid = obj.optString("uuid", "")
                val type = obj.optString("type", "")
                val timestamp = parseTimestamp(obj.optString("timestamp", ""))

                when (type) {
                    "user" -> {
                        if (!obj.has("promptId")) continue
                        if (obj.optBoolean("isMeta", false)) continue
                        val message = obj.optJSONObject("message") ?: continue
                        val content = message.opt("content")
                        val text = when (content) {
                            is String -> content
                            is org.json.JSONArray -> extractTextFromContent(content)
                            else -> continue
                        }
                        if (text.isNotBlank()) {
                            if (uuid.isNotBlank() && seenUuids.containsKey(uuid)) {
                                messages[seenUuids[uuid]!!] = HistoryMessage("user", text, timestamp)
                            } else {
                                if (uuid.isNotBlank()) seenUuids[uuid] = messages.size
                                messages.add(HistoryMessage("user", text, timestamp))
                            }
                        }
                    }
                    "assistant" -> {
                        val message = obj.optJSONObject("message") ?: continue
                        val stopReason = message.optString("stop_reason", "")
                        if (stopReason != "end_turn") continue

                        val contentArr = message.optJSONArray("content") ?: continue
                        val text = extractTextFromContent(contentArr)
                        if (text.isNotBlank()) {
                            if (uuid.isNotBlank() && seenUuids.containsKey(uuid)) {
                                messages[seenUuids[uuid]!!] = HistoryMessage("assistant", text, timestamp)
                            } else {
                                if (uuid.isNotBlank()) seenUuids[uuid] = messages.size
                                messages.add(HistoryMessage("assistant", text, timestamp))
                            }
                        }
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error loading history", e)
        }

        return messages
    }

    /**
     * Display metadata derived straight from the transcript JSONL.
     * Mirrors desktop session-browser.ts TranscriptMeta.
     */
    data class TranscriptMeta(
        /** Title from the first real user prompt, or null. */
        val fallbackTitle: String?,
        /** Timestamp (ms) of the last parseable transcript line, or null. */
        val lastTimestampMs: Long?,
    )

    /**
     * Collapse whitespace and trim a derived title to a word boundary.
     * Pure + public so it's unit-testable without filesystem I/O. MUST produce
     * byte-identical output to desktop session-browser.ts cleanTitle (same
     * constants, same >20-char word-boundary rule).
     */
    fun cleanTitle(text: String): String? {
        val collapsed = text.replace(WHITESPACE_RE, " ").trim()
        if (collapsed.isEmpty()) return null
        if (collapsed.length <= FALLBACK_TITLE_MAX) return collapsed
        val cut = collapsed.substring(0, FALLBACK_TITLE_MAX)
        val lastSpace = cut.lastIndexOf(' ')
        // Trim back to the last word boundary, but only when that leaves a
        // reasonable stub (>20 chars) — otherwise a long first word would
        // shrink the title to almost nothing, so we hard-cut mid-word instead.
        val body = if (lastSpace > 20) cut.substring(0, lastSpace) else cut
        return "$body…"
    }

    /**
     * Derive display metadata straight from the transcript JSONL. Mirrors
     * desktop readTranscriptMeta.
     *
     * WHY: the topic/index naming pipeline has gaps (the auto-title hook only
     * fires on PostToolUse, so chat-only sessions are never titled), and file
     * mtimes are clobbered by sync restores. The transcript content itself is
     * the only source of truth that survives both. Returns nulls on any
     * failure, so it can only ever improve on the caller's defaults. Does NOT
     * log (kept unit-testable on plain JVM).
     *
     * CC-coupled: relies on the transcript JSONL line shape (`type`, `isMeta`,
     * `promptId`, `timestamp`, `message.content`) — same contract the
     * transcript-watcher parses. See youcoded/docs/cc-dependencies.md.
     */
    fun readTranscriptMeta(jsonlFile: File, wantTitle: Boolean): TranscriptMeta {
        var fallbackTitle: String? = null
        var lastTimestampMs: Long? = null
        try {
            java.io.RandomAccessFile(jsonlFile, "r").use { raf ->
                val size = raf.length()

                // --- Tail: last parseable line's timestamp ---
                val tailLen = minOf(TAIL_CHUNK.toLong(), size).toInt()
                if (tailLen > 0) {
                    val tailBuf = ByteArray(tailLen)
                    raf.seek(size - tailLen)
                    raf.readFully(tailBuf)
                    // First "line" of the chunk is usually a partial JSON line —
                    // the backwards scan just skips anything that doesn't parse.
                    val tailLines = String(tailBuf, Charsets.UTF_8).split('\n')
                    for (i in tailLines.indices.reversed()) {
                        val line = tailLines[i]
                        if (line.isBlank() || line.contains('\u0000')) continue
                        try {
                            val ts = JSONObject(line).optString("timestamp")
                            val ms = java.time.Instant.parse(ts).toEpochMilli()
                            lastTimestampMs = ms
                            break
                        } catch (_: Exception) { /* partial/corrupt — keep scanning back */ }
                    }
                }

                // --- Head: first real user prompt → fallback title ---
                if (wantTitle) {
                    val headLen = minOf(HEAD_CHUNK.toLong(), size).toInt()
                    if (headLen > 0) {
                        val headBuf = ByteArray(headLen)
                        raf.seek(0)
                        raf.readFully(headBuf)
                        for (line in String(headBuf, Charsets.UTF_8).split('\n')) {
                            if (line.isBlank() || line.contains('\u0000')) continue
                            val parsed = try { JSONObject(line) } catch (_: Exception) { continue }
                            // Same "real conversational prompt" gate as loadHistory:
                            // user-type, has promptId, not meta, has a message object.
                            if (parsed.optString("type") != "user") continue
                            if (parsed.optBoolean("isMeta", false)) continue
                            if (!parsed.has("promptId")) continue
                            val message = parsed.optJSONObject("message") ?: continue
                            val content = message.opt("content")
                            val text = when (content) {
                                is String -> content
                                is org.json.JSONArray -> extractTextFromContent(content)
                                else -> continue
                            }
                            // Skip injected wrappers (<command-name>…, <system-reminder>…)
                            // — they're plumbing, not what the user said. Deliberately
                            // lossy: a real prompt starting with '<' is also skipped.
                            if (text.isBlank() || text.trim().startsWith("<")) continue
                            val cleaned = cleanTitle(text)
                            if (cleaned != null) { fallbackTitle = cleaned; break }
                        }
                    }
                }
            }
        } catch (_: Exception) {
            // Any failure → return whatever was gathered so far (nulls are fine).
        }
        return TranscriptMeta(fallbackTitle, lastTimestampMs)
    }

    /**
     * Convert project slug back to a display path.
     * Desktop format: C--Users-alice → C:/Users/alice
     * Android format: -data-data-com.youcoded.app-files-home-youcoded-dev
     *                  → /data/data/com.youcoded.app/files/home/youcoded-dev
     *
     * Fix: the naive "replace all dashes with /" broke when directory names
     * themselves contain hyphens (e.g. "youcoded-dev" collapsed to "youcoded/dev",
     * so the Resume Browser showed project "dev" and resume() fell back to $HOME
     * because the bogus path didn't exist). Mirrors desktop's
     * resolveSlugToPath/walkSlugParts in session-browser.ts: greedy-match each
     * segment against the real filesystem, extending with hyphens when a single
     * part doesn't resolve to a real directory.
     */
    fun slugToPath(slug: String): String {
        // Check for Windows-style slugs (start with drive letter and double dash)
        val windowsDriveMatch = Regex("^([A-Z])--(.*)")
            .matchEntire(slug)
        val root: String
        val parts: List<String>
        if (windowsDriveMatch != null) {
            // Windows: C--Users-alice-project → root=C:\, parts=[Users, alice, project]
            root = "${windowsDriveMatch.groupValues[1]}:\\"
            parts = windowsDriveMatch.groupValues[2].split('-').filter { it.isNotEmpty() }
        } else {
            // Unix: -home-user-project → root=/, parts=[home, user, project]
            root = "/"
            parts = slug.removePrefix("-").split('-').filter { it.isNotEmpty() }
        }
        if (parts.isEmpty()) return root
        return walkSlugParts(root, parts)
    }

    /**
     * Recursively resolve slug dash-segments against the filesystem. For each
     * position try the shortest group first (1 part); if it doesn't exist on
     * disk as a directory, extend by joining the next dash-part, up to the
     * whole remainder. Longest-matching real directory wins; naive join is
     * the fallback when nothing exists.
     */
    private fun walkSlugParts(base: String, parts: List<String>): String {
        for (len in 1..parts.size) {
            val segment = parts.subList(0, len).joinToString("-")
            val candidate = File(base, segment)
            if (len == parts.size) {
                // Last possible grouping — accept whether or not it exists on disk
                return candidate.path
            }
            try {
                if (candidate.isDirectory) {
                    return walkSlugParts(candidate.path, parts.subList(len, parts.size))
                }
            } catch (_: Exception) {
                // Keep trying longer groupings
            }
        }
        // Unreachable (len == parts.size branch always returns) but keep as a safety net
        return File(base, parts.joinToString("-")).path
    }

    /** Convert project slug to a File, falling back to homeDir if path doesn't exist. */
    fun slugToCwd(slug: String, homeDir: File): File {
        val path = slugToPath(slug)
        val file = File(path)
        return if (file.exists()) file else homeDir
    }

    /** Extract only text content from a JSONArray of content blocks (no tool calls). */
    private fun extractTextFromContent(content: org.json.JSONArray): String {
        val parts = mutableListOf<String>()
        for (i in 0 until content.length()) {
            val item = content.opt(i)
            when {
                item is String -> parts.add(item)
                item is JSONObject && item.optString("type") == "text" ->
                    parts.add(item.optString("text", ""))
            }
        }
        return parts.joinToString("\n")
    }

    private fun parseTimestamp(iso: String): Long {
        return try {
            java.time.Instant.parse(iso).toEpochMilli()
        } catch (_: Exception) {
            System.currentTimeMillis()
        }
    }
}
