package com.youcoded.app.parser

import android.util.Log
import com.youcoded.app.runtime.Bootstrap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.io.IOException

/**
 * Spawns the desktop's transcript-watcher CLI as a Node subprocess and
 * forwards its NDJSON output as `TranscriptEvent`s. Drop-in alternative to
 * [TranscriptWatcher] — exposes the same public API (`events`,
 * `startWatching`, `stopWatching`) so [com.youcoded.app.runtime.ManagedSession]
 * doesn't need to know which implementation it has.
 *
 * Why a subprocess: the JSONL parser is the most CC-coupled, highest-drift
 * surface in the app. Running the same TS code on both platforms eliminates
 * the class of bug that produced the now-removed `streaming-text` event and
 * was contributing to inconsistent tool-call grouping (Bug 2 in
 * docs/plans/2026-04-23-android-desktop-parity.md).
 *
 * Per-session subprocess: each instance owns one Node process. Wasteful at
 * N sessions (~30-50 MB each) but simpler than a singleton supervisor. A
 * future optimization can fold all sessions into a single shared process —
 * the CLI protocol already supports multi-session via the `mobileSessionId`
 * field on watch/unwatch commands.
 *
 * Lifecycle: subprocess spawns lazily on the first `startWatching` call.
 * The Node CLI emits {"kind":"ready"} once stdin is wired up; we await it
 * before sending the first command. Death is logged to logcat; recovery
 * (respawn / fall back to Kotlin watcher) is the responsibility of the
 * caller.
 */
class TranscriptWatcherProcess(
    private val bootstrap: Bootstrap,
    private val scope: CoroutineScope,
) : TranscriptSource {
    companion object {
        private const val TAG = "TranscriptWatcherProc"
        // Time to wait for the CLI to emit {"kind":"ready"} after spawn before
        // giving up and surfacing the failure. Termux Node cold-starts in
        // 100-300ms typically; 5s is a generous ceiling.
        private const val READY_TIMEOUT_MS = 5_000L
    }

    private val _events = MutableSharedFlow<TranscriptEvent>(extraBufferCapacity = 1000)
    override val events: SharedFlow<TranscriptEvent> = _events

    private var process: Process? = null
    private var stdinWriter: BufferedWriter? = null
    private var stdoutJob: Job? = null
    private var stderrJob: Job? = null
    private var deathJob: Job? = null
    private val readyDeferred = CompletableDeferred<Unit>()
    private val activeMobileSessionIds = mutableSetOf<String>()
    private val lock = Any()

    /**
     * Begin watching the transcript file for a session. Spawns the Node CLI
     * on first call, then sends a `watch` command. ManagedSession passes
     * (mobileSessionId, claudeSessionId, cwd) — cwd is needed because the
     * CLI computes the JSONL path as `<projectsDir>/<slugifyCwd(cwd)>/<id>.jsonl`,
     * matching the desktop TranscriptWatcher's path derivation.
     *
     * [transcriptPath] is the absolute path to the JSONL file as seen by
     * Android. Unused by this implementation (the CLI re-derives the path
     * from claudeSessionId+cwd to stay byte-identical with desktop), but
     * accepted to satisfy the [TranscriptSource] interface contract.
     */
    override fun startWatching(
        mobileSessionId: String,
        claudeSessionId: String,
        cwd: String,
        transcriptPath: String,
    ) {
        synchronized(lock) {
            if (mobileSessionId in activeMobileSessionIds) return
            activeMobileSessionIds.add(mobileSessionId)
        }
        scope.launch(Dispatchers.IO) {
            try {
                ensureProcessSpawned()
                val ready = withTimeoutOrNull(READY_TIMEOUT_MS) { readyDeferred.await() }
                if (ready == null) {
                    throw IOException("Node CLI did not emit {\"kind\":\"ready\"} within ${READY_TIMEOUT_MS}ms")
                }
                sendCommand(JSONObject().apply {
                    put("command", "watch")
                    put("mobileSessionId", mobileSessionId)
                    put("claudeSessionId", claudeSessionId)
                    put("cwd", cwd)
                })
            } catch (e: Exception) {
                Log.e(TAG, "startWatching($mobileSessionId) failed", e)
            }
        }
    }

    /** Stop watching a session. Tears down the subprocess once no sessions remain. */
    override fun stopWatching(mobileSessionId: String) {
        val empty = synchronized(lock) {
            if (!activeMobileSessionIds.remove(mobileSessionId)) return
            activeMobileSessionIds.isEmpty()
        }
        try {
            sendCommand(JSONObject().apply {
                put("command", "unwatch")
                put("mobileSessionId", mobileSessionId)
            })
        } catch (e: Exception) {
            Log.w(TAG, "unwatch send failed for $mobileSessionId: ${e.message}")
        }
        if (empty) shutdown()
    }

    /** Force-stop the subprocess (used during ManagedSession teardown). */
    fun shutdown() {
        try { stdinWriter?.close() } catch (_: Exception) {}
        stdinWriter = null
        try { process?.destroy() } catch (_: Exception) {}
        process = null
        stdoutJob?.cancel()
        stderrJob?.cancel()
        deathJob?.cancel()
        synchronized(lock) { activeMobileSessionIds.clear() }
    }

    // -------------------------------------------------------------------------
    // Internal
    // -------------------------------------------------------------------------

    private fun ensureProcessSpawned() {
        synchronized(lock) {
            if (process?.isAlive == true) return
            val cliFile = File(bootstrap.homeDir, ".claude-mobile/transcript-watcher-cli.js")
            if (!cliFile.exists()) {
                throw IOException("transcript-watcher-cli.js not deployed at ${cliFile.absolutePath}")
            }
            val nodePath = File(bootstrap.usrDir, "bin/node").absolutePath
            // /system/bin/linker64 invocation matches the SELinux W^X bypass
            // pattern used by every other Node spawn in this app (see
            // Bootstrap.installClaudeCode + selfTest). Without it, exec from
            // the app sandbox onto a binary in app data fails with EACCES.
            val pb = ProcessBuilder("/system/bin/linker64", nodePath, cliFile.absolutePath)
                .directory(bootstrap.homeDir)
                // Don't merge stderr into stdout — we read them independently
                // so error diagnostics stay separable from event payloads.
                .redirectErrorStream(false)
            pb.environment().putAll(bootstrap.buildRuntimeEnv())
            val p = pb.start()
            process = p
            stdinWriter = p.outputStream.bufferedWriter()

            // Stdout reader: NDJSON in, TranscriptEvent out via _events.
            stdoutJob = scope.launch(Dispatchers.IO) {
                try {
                    p.inputStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) handleStdoutLine(line)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "stdout reader stopped: ${e.message}")
                }
            }

            // Stderr reader: forward CLI diagnostics to logcat for triage.
            stderrJob = scope.launch(Dispatchers.IO) {
                try {
                    p.errorStream.bufferedReader().forEachLine { line ->
                        if (line.isNotBlank()) Log.w(TAG, "[cli stderr] $line")
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "stderr reader stopped: ${e.message}")
                }
            }

            // Death watcher: surface unexpected exits. ManagedSession can
            // observe via process == null after this runs; restart logic is
            // intentionally deferred to a future iteration so the first
            // version of this class stays small and testable.
            deathJob = scope.launch(Dispatchers.IO) {
                try {
                    val exit = p.waitFor()
                    Log.w(TAG, "Node CLI exited with code $exit")
                    synchronized(lock) {
                        process = null
                        stdinWriter = null
                    }
                    if (!readyDeferred.isCompleted) {
                        readyDeferred.completeExceptionally(IOException("CLI exited before ready (code $exit)"))
                    }
                } catch (_: Exception) {}
            }
        }
    }

    private fun handleStdoutLine(line: String) {
        val obj = try { JSONObject(line) } catch (_: Exception) {
            Log.w(TAG, "Bad NDJSON line from CLI: $line")
            return
        }
        when (obj.optString("kind")) {
            "ready" -> {
                if (!readyDeferred.isCompleted) readyDeferred.complete(Unit)
            }
            "event" -> {
                val payload = obj.optJSONObject("payload") ?: return
                val event = parseEvent(payload) ?: return
                _events.tryEmit(event)
            }
            "history" -> { /* not yet wired into the Android side */ }
            else -> Log.w(TAG, "Unknown CLI message kind: $line")
        }
    }

    /**
     * Convert the desktop's TranscriptEvent JSON shape (emitted by parse-
     * TranscriptLine) into the Kotlin sealed-class equivalent. Field names
     * mirror the desktop emission shape — see desktop/src/main/transcript-
     * watcher.ts for the canonical contract. New event types (UserInterrupt,
     * AssistantThinking) were added to TranscriptEvent.kt for this path.
     */
    private fun parseEvent(payload: JSONObject): TranscriptEvent? {
        val type = payload.optString("type")
        val sessionId = payload.optString("sessionId")
        val uuid = payload.optString("uuid")
        val timestamp = payload.optLong("timestamp", System.currentTimeMillis())
        val data = payload.optJSONObject("data") ?: JSONObject()
        return try {
            when (type) {
                "user-message" -> TranscriptEvent.UserMessage(sessionId, uuid, timestamp, data.optString("text"))
                "user-interrupt" -> TranscriptEvent.UserInterrupt(
                    sessionId, uuid, timestamp,
                    kind = data.optString("kind", "plain"),
                )
                "assistant-text" -> TranscriptEvent.AssistantText(
                    sessionId, uuid, timestamp,
                    text = data.optString("text"),
                    model = data.optString("model").takeIf { it.isNotEmpty() },
                    parentAgentToolUseId = data.optString("parentAgentToolUseId").takeIf { it.isNotEmpty() },
                    agentId = data.optString("agentId").takeIf { it.isNotEmpty() },
                )
                "assistant-thinking" -> TranscriptEvent.AssistantThinking(sessionId, uuid, timestamp)
                "tool-use" -> TranscriptEvent.ToolUse(
                    sessionId, uuid, timestamp,
                    toolUseId = data.optString("toolUseId"),
                    toolName = data.optString("toolName"),
                    toolInput = data.optJSONObject("toolInput") ?: JSONObject(),
                    parentAgentToolUseId = data.optString("parentAgentToolUseId").takeIf { it.isNotEmpty() },
                    agentId = data.optString("agentId").takeIf { it.isNotEmpty() },
                )
                "tool-result" -> TranscriptEvent.ToolResult(
                    sessionId, uuid, timestamp,
                    toolUseId = data.optString("toolUseId"),
                    result = data.optString("toolResult"),
                    isError = data.optBoolean("isError", false),
                    parentAgentToolUseId = data.optString("parentAgentToolUseId").takeIf { it.isNotEmpty() },
                    agentId = data.optString("agentId").takeIf { it.isNotEmpty() },
                )
                "turn-complete" -> {
                    val usage = data.optJSONObject("usage")?.let {
                        TranscriptEvent.TurnUsage(
                            inputTokens = it.optInt("inputTokens", 0),
                            outputTokens = it.optInt("outputTokens", 0),
                            cacheReadTokens = it.optInt("cacheReadTokens", 0),
                            cacheCreationTokens = it.optInt("cacheCreationTokens", 0),
                        )
                    }
                    TranscriptEvent.TurnComplete(
                        sessionId, uuid, timestamp,
                        stopReason = data.optString("stopReason").takeIf { it.isNotEmpty() },
                        model = data.optString("model").takeIf { it.isNotEmpty() },
                        usage = usage,
                        anthropicRequestId = data.optString("anthropicRequestId").takeIf { it.isNotEmpty() },
                    )
                }
                "compact-summary" -> TranscriptEvent.CompactSummary(sessionId, uuid, timestamp)
                else -> {
                    Log.w(TAG, "Unhandled event type from CLI: $type")
                    null
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse CLI event payload", e)
            null
        }
    }

    @Synchronized
    private fun sendCommand(cmd: JSONObject) {
        val w = stdinWriter ?: throw IOException("CLI stdin not open")
        w.write(cmd.toString())
        w.newLine()
        w.flush()
    }
}
