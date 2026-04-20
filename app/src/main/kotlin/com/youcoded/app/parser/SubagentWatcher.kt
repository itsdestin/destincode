package com.youcoded.app.parser

import android.os.FileObserver
import android.util.Log
import kotlinx.coroutines.*
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.RandomAccessFile

/**
 * Per-parent-session watcher for `<parent>/subagents/`. When an
 * agent-<id>.jsonl appears, reads the sibling .meta.json, binds via
 * SubagentIndex, then streams the file — stamping parentAgentToolUseId
 * and agentId on each emitted TranscriptEvent.
 *
 * Uses FileObserver on the directory (when a Looper is available) plus a
 * polling coroutine. Tests drive scanDirectoryForTest() / readNewLinesForTest()
 * directly so they don't depend on FileObserver delivery.
 */
class SubagentWatcher(
    private val sessionId: String,
    private val subagentsDir: File,
    private val index: SubagentIndex,
    private val emit: (TranscriptEvent) -> Unit,
    private val scope: CoroutineScope? = null,
) {
    companion object { private const val TAG = "SubagentWatcher" }

    private data class PerFileState(
        val agentId: String,
        val jsonlFile: File,
        var offset: Long = 0L,
        val seenUuids: MutableSet<String> = mutableSetOf(),
        var bound: Boolean = false,
    )

    private val perFile = mutableMapOf<String, PerFileState>()
    private var dirObserver: FileObserver? = null
    private var pollJob: Job? = null
    private var pruneJob: Job? = null

    fun start() {
        scanDirectoryForTest() // initial replay
        if (scope != null) {
            pollJob = scope.launch(Dispatchers.IO) {
                while (isActive) {
                    delay(1000)
                    scanDirectoryForTest()
                    for (agentId in perFile.keys.toList()) readNewLinesForTest(agentId)
                }
            }
            pruneJob = scope.launch(Dispatchers.IO) {
                while (isActive) { delay(5000); index.pruneExpired() }
            }
        }
    }

    fun stop() {
        pollJob?.cancel(); pollJob = null
        pruneJob?.cancel(); pruneJob = null
        dirObserver?.stopWatching(); dirObserver = null
        perFile.clear()
    }

    /** Public for tests: scan subagents dir, pick up new files. */
    fun scanDirectoryForTest() {
        if (!subagentsDir.exists()) return
        for (name in subagentsDir.list().orEmpty()) {
            if (!name.endsWith(".jsonl") || !name.startsWith("agent-")) continue
            val agentId = name.substring("agent-".length, name.length - ".jsonl".length)
            trackSubagent(agentId)
        }
    }

    /** Public for tests: force a re-read of one file. */
    fun readNewLinesForTest(agentId: String) {
        val state = perFile[agentId] ?: return
        readNewLines(state)
    }

    /** Public for tests: re-read from offset 0, exercising the dedup. */
    fun forceRereadForTest(agentId: String) {
        val state = perFile[agentId] ?: return
        state.offset = 0L
        readNewLines(state)
    }

    fun flushAllPending() {
        for (agentId in perFile.keys.toList()) {
            val res = index.tryFlushPending(agentId) ?: continue
            for (ev in res.events) if (ev is TranscriptEvent) emit(stamp(ev, res.parentToolUseId, agentId))
            perFile[agentId]?.bound = true
        }
    }

    fun getHistory(): List<TranscriptEvent> {
        if (!subagentsDir.exists()) return emptyList()
        val out = mutableListOf<TranscriptEvent>()
        for (name in subagentsDir.list().orEmpty().sorted()) {
            if (!name.endsWith(".jsonl") || !name.startsWith("agent-")) continue
            val agentId = name.substring("agent-".length, name.length - ".jsonl".length)
            val meta = readMeta(agentId) ?: continue
            val parentToolUseId = index.bindSubagent(agentId, meta.first, meta.second) ?: continue
            val jsonlFile = File(subagentsDir, name)
            if (!jsonlFile.exists()) continue
            for (line in jsonlFile.readLines()) {
                if (line.isBlank()) continue
                parseLine(line)?.let { out.add(stamp(it, parentToolUseId, agentId)) }
            }
        }
        return out
    }

    // ---- internals ----

    private fun readMeta(agentId: String): Pair<String, String>? {
        val metaFile = File(subagentsDir, "agent-$agentId.meta.json")
        if (!metaFile.exists()) return null
        return try {
            val obj = JSONObject(metaFile.readText())
            val description = obj.optString("description", "")
            val agentType = obj.optString("agentType", "")
            if (description.isEmpty() || agentType.isEmpty()) null else description to agentType
        } catch (_: Exception) { null }
    }

    private fun trackSubagent(agentId: String) {
        if (perFile.containsKey(agentId)) return
        val meta = readMeta(agentId) ?: return
        val jsonlFile = File(subagentsDir, "agent-$agentId.jsonl")
        val state = PerFileState(agentId = agentId, jsonlFile = jsonlFile)
        perFile[agentId] = state
        val parentToolUseId = index.bindSubagent(agentId, meta.first, meta.second)
        state.bound = parentToolUseId != null
        readNewLines(state)
    }

    private fun readNewLines(state: PerFileState) {
        val file = state.jsonlFile
        if (!file.exists()) return
        val fileLength = file.length()
        if (fileLength < state.offset) { state.offset = 0L }
        if (fileLength <= state.offset) return
        try {
            RandomAccessFile(file, "r").use { raf ->
                raf.seek(state.offset)
                val newBytes = ByteArray((fileLength - state.offset).toInt())
                raf.readFully(newBytes)
                val lastNewline = newBytes.lastIndexOf(0x0A.toByte())
                if (lastNewline < 0) return
                state.offset += lastNewline + 1
                val text = String(newBytes, 0, lastNewline + 1, Charsets.UTF_8)
                for (line in text.lineSequence()) {
                    if (line.isBlank()) continue
                    val ev = parseLine(line) ?: continue
                    if (state.seenUuids.contains(ev.uuid)) continue
                    state.seenUuids.add(ev.uuid)
                    if (state.seenUuids.size > 500) {
                        val trimmed = state.seenUuids.toList().takeLast(500)
                        state.seenUuids.clear(); state.seenUuids.addAll(trimmed)
                    }
                    deliver(state, ev)
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Error reading subagent", e)
        }
    }

    private fun deliver(state: PerFileState, ev: TranscriptEvent) {
        if (state.bound) {
            val parentToolUseId = index.lookup(state.agentId)
            if (parentToolUseId != null) { emit(stamp(ev, parentToolUseId, state.agentId)); return }
        }
        val meta = readMeta(state.agentId) ?: return
        index.bufferPendingEvent(state.agentId, meta.first, meta.second, ev)
    }

    private fun stamp(ev: TranscriptEvent, parentToolUseId: String, agentId: String): TranscriptEvent = when (ev) {
        is TranscriptEvent.ToolUse -> ev.copy(parentAgentToolUseId = parentToolUseId, agentId = agentId)
        is TranscriptEvent.ToolResult -> ev.copy(parentAgentToolUseId = parentToolUseId, agentId = agentId)
        is TranscriptEvent.AssistantText -> ev.copy(parentAgentToolUseId = parentToolUseId, agentId = agentId)
        else -> ev
    }

    /**
     * Minimal line parser: subagent JSONL lines reuse Claude Code's
     * on-disk format, but the existing Android parser is per-session and
     * tightly coupled to TranscriptWatcher internals. For now we parse
     * only tool_use, tool_result, and assistant-text blocks here — the
     * surface we actually surface in subagent timelines.
     */
    private fun parseLine(line: String): TranscriptEvent? {
        val obj = try { JSONObject(line) } catch (_: Exception) { return null }
        val uuid = obj.optString("uuid", "").ifBlank { return null }
        val type = obj.optString("type", "")
        val timestamp = 0L
        val message = obj.optJSONObject("message") ?: return null

        if (type == "assistant") {
            val content = message.optJSONArray("content") ?: return null
            for (i in 0 until content.length()) {
                val block = content.optJSONObject(i) ?: continue
                when (block.optString("type", "")) {
                    "text" -> {
                        val text = TranscriptWatcher.stripSystemTags(block.optString("text", ""))
                        if (text.isNotEmpty()) return TranscriptEvent.AssistantText(
                            sessionId = sessionId, uuid = uuid, timestamp = timestamp,
                            text = text, model = message.optString("model", null),
                        )
                    }
                    "tool_use" -> {
                        return TranscriptEvent.ToolUse(
                            sessionId = sessionId, uuid = uuid, timestamp = timestamp,
                            toolUseId = block.optString("id", ""),
                            toolName = block.optString("name", ""),
                            toolInput = block.optJSONObject("input") ?: JSONObject(),
                        )
                    }
                }
            }
        } else if (type == "user") {
            val content = message.optJSONArray("content") ?: return null
            for (i in 0 until content.length()) {
                val block = content.optJSONObject(i) ?: continue
                if (block.optString("type", "") == "tool_result") {
                    val resultContent = block.opt("content")
                    val text = when (resultContent) {
                        is String -> resultContent
                        is JSONArray -> {
                            val sb = StringBuilder()
                            for (j in 0 until resultContent.length()) {
                                val b = resultContent.optJSONObject(j) ?: continue
                                if (b.optString("type", "") == "text") sb.appendLine(b.optString("text", ""))
                            }
                            sb.toString().trim()
                        }
                        else -> ""
                    }
                    return TranscriptEvent.ToolResult(
                        sessionId = sessionId, uuid = uuid, timestamp = timestamp,
                        toolUseId = block.optString("tool_use_id", ""),
                        result = text,
                        isError = block.optBoolean("is_error", false),
                    )
                }
            }
        }
        return null
    }
}
