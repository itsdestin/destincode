package com.youcoded.app.parser

import android.net.LocalServerSocket
import android.net.LocalSocket
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import org.json.JSONObject
import java.io.BufferedReader
import java.io.InputStreamReader
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Listens on an Android abstract-namespace Unix socket for hook-relay connections.
 * Each connection delivers one JSON line (a Claude Code hook event).
 *
 * For PermissionRequest events, the socket is held open so we can send a
 * structured decision back through it (blocking relay protocol).
 */
class EventBridge(private val socketName: String) {
    companion object {
        /** §1 tier-1 hold (2h). Must stay UNDER the relay asset's 2h30m and
         *  Bootstrap's 3h CC hook timeout — margins are load-bearing (the
         *  losing order kills the hook with no decision and AskUserQuestion
         *  wedges forever). Pinned by desktop/tests/permission-timeout-margins. */
        const val PERMISSION_HOLD_MS = 7_200_000L
    }

    private val _events = MutableSharedFlow<HookEvent>(extraBufferCapacity = 1000)
    val events: SharedFlow<HookEvent> = _events

    /** Sockets held open for blocking PermissionRequest responses. */
    private val pendingSockets = ConcurrentHashMap<String, LocalSocket>()

    /** Tier-1 hold timers, keyed by requestId. Cancelled on every path that
     *  ends a request (respond, closeSocket, closure monitor, stop) so a
     *  2h coroutine never outlives the socket it was guarding. */
    private val holdJobs = ConcurrentHashMap<String, Job>()

    /** Maps mobile session IDs to Claude Code session IDs. */
    private val sessionIdMap = ConcurrentHashMap<String, String>()

    /** Maps mobile session IDs to transcript file paths (extracted from hook events). */
    private val transcriptPathMap = ConcurrentHashMap<String, String>()

    /** Stored scope for launching socket-closure monitor coroutines. */
    private var monitorScope: CoroutineScope? = null

    fun getClaudeSessionId(mobileSessionId: String): String? = sessionIdMap[mobileSessionId]

    /** Get the transcript JSONL path for a session, as reported by Claude Code. */
    fun getTranscriptPath(mobileSessionId: String): String? = transcriptPathMap[mobileSessionId]

    @Volatile private var serverSocket: LocalServerSocket? = null
    private var listenJob: Job? = null

    fun startServer(scope: CoroutineScope) {
        monitorScope = scope
        listenJob = scope.launch(Dispatchers.IO) {
            // Retry binding — socket may linger briefly after a previous session
            var retries = 3
            while (retries > 0) {
                try {
                    serverSocket = LocalServerSocket(socketName)
                    if (com.youcoded.app.BuildConfig.DEBUG) android.util.Log.d("EventBridge", "Listening on abstract socket: $socketName")
                    break
                } catch (e: java.io.IOException) {
                    retries--
                    if (retries > 0) {
                        android.util.Log.w("EventBridge", "Socket bind failed, retrying in 500ms ($retries left)")
                        delay(500)
                    } else {
                        android.util.Log.e("EventBridge", "Socket bind failed after retries", e)
                        return@launch
                    }
                }
            }

            try {
                while (isActive) {
                    val client: LocalSocket = serverSocket!!.accept()
                    launch {
                        handleClient(client)
                    }
                }
            } catch (e: Exception) {
                if (isActive) {
                    android.util.Log.e("EventBridge", "Server error", e)
                }
            }
        }
    }

    // Non-suspend (master fix) — uses tryEmit to avoid blocking the coroutine.
    private fun handleClient(client: LocalSocket) {
        try {
            val reader = BufferedReader(InputStreamReader(client.inputStream))
            val line = reader.readLine() ?: run { client.close(); return }
            if (com.youcoded.app.BuildConfig.DEBUG) android.util.Log.d("EventBridge", "Received: ${line.take(300)}")

            // Peek at event type to decide whether to hold the socket
            val json = try { JSONObject(line) } catch (_: Exception) { client.close(); return }
            val eventName = json.optString("hook_event_name", "")

            // Extract session ID mapping if present
            val mobileSessionId = json.optString("mobileSessionId", "")
            val claudeSessionId = json.optString("session_id", "")
            if (mobileSessionId.isNotBlank() && claudeSessionId.isNotBlank()) {
                sessionIdMap[mobileSessionId] = claudeSessionId
            }

            // Extract transcript path if present (Claude Code includes this on every hook event)
            val transcriptPath = json.optString("transcript_path", "")
            if (mobileSessionId.isNotBlank() && transcriptPath.isNotBlank()) {
                transcriptPathMap[mobileSessionId] = transcriptPath
            }

            if (eventName == "PermissionRequest") {
                // Hold socket open for blocking response
                val requestId = UUID.randomUUID().toString()
                pendingSockets[requestId] = client
                // Inject requestId into the JSON so downstream can reference it
                json.put("_requestId", requestId)
                val sessionId = json.optString("session_id", "")
                val event = HookEvent.fromJson(json.toString())
                if (event != null) {
                    if (!_events.tryEmit(event)) {
                        android.util.Log.e("EventBridge", "Event buffer full, dropped: ${event::class.simpleName}")
                    }
                    // Monitor for remote closure — emits PermissionExpired when
                    // hook-relay-blocking.js times out or Claude Code kills the hook.
                    // Desktop equivalent: hook-relay.ts socket.on('close') handler.
                    monitorSocketClosure(requestId, sessionId, client)

                    // §1 tier-1: the app ends the wait with a labeled deny.
                    // Must emit explicitly — respond() removes the pending
                    // entry BEFORE closing, so the closure monitor stays
                    // silent for app-initiated endings (its own comment).
                    monitorScope?.launch(Dispatchers.IO) {
                        delay(PERMISSION_HOLD_MS)
                        holdJobs.remove(requestId)
                        if (pendingSockets.containsKey(requestId)) {
                            // Nested decision shape is load-bearing: the relay
                            // reads appDecision.decision. Message lands in the
                            // tool result the model reads.
                            val deny = JSONObject().put("decision", JSONObject()
                                .put("behavior", "deny")
                                .put("message", "YouCoded auto-denied this request after 2 hours with no user response — ask again if still needed."))
                            // Only emit "app-timeout" if the deny actually went out. If
                            // the write failed, respond() already emitted its own
                            // "delivery-failed" PermissionExpired — emitting again here
                            // would violate "at most one expiry per request".
                            if (respond(requestId, deny)) {
                                _events.tryEmit(HookEvent.PermissionExpired(
                                    sessionId = sessionId,
                                    hookEventName = "PermissionExpired",
                                    requestId = requestId,
                                    reason = "app-timeout",
                                ))
                            }
                        }
                    }?.also { holdJobs[requestId] = it }
                } else {
                    pendingSockets.remove(requestId)
                    client.close()
                }
            } else {
                // Fire-and-forget — parse, emit, close
                val event = HookEvent.fromJson(line)
                if (event != null) {
                    if (!_events.tryEmit(event)) {
                        android.util.Log.e("EventBridge", "Event buffer full, dropped: ${event::class.simpleName}")
                    }
                } else {
                    android.util.Log.w("EventBridge", "Failed to parse hook event")
                }
                client.close()
            }
        } catch (e: Exception) {
            android.util.Log.w("EventBridge", "Client error", e)
            try { client.close() } catch (_: Exception) {}
        }
    }

    /**
     * Monitor a held PermissionRequest socket for remote closure.
     * When hook-relay-blocking.js times out (its 2h30m tier-2 backstop) or Claude Code kills the hook
     * process, the socket closes. We detect this and emit PermissionExpired so
     * the React UI can clear the stale approval card.
     *
     * Race safety: if respond() successfully delivers a decision, it removes the
     * requestId from pendingSockets before closing the socket. The monitor detects
     * the closure but finds the requestId already gone — no false PermissionExpired.
     */
    private fun monitorSocketClosure(requestId: String, sessionId: String, client: LocalSocket) {
        monitorScope?.launch(Dispatchers.IO) {
            try {
                // After the initial JSON line, the relay waits for our response.
                // read() blocks until the relay process exits (returns -1) or errors.
                @Suppress("ControlFlowWithEmptyBody")
                while (client.inputStream.read() >= 0) { /* drain unexpected data */ }
            } catch (_: Exception) {
                // Socket error — relay process exited or was killed
            }
            // If socket is still in pendingSockets, the permission was never
            // responded to — emit PermissionExpired to clean up the React UI.
            if (pendingSockets.remove(requestId) != null) {
                try { client.close() } catch (_: Exception) {}
                // Far-end death (relay backstop or CC killing the hook), not our
                // own hold firing — cancel the hold job so it doesn't also emit.
                holdJobs.remove(requestId)?.cancel()
                if (!_events.tryEmit(HookEvent.PermissionExpired(
                        sessionId = sessionId,
                        hookEventName = "PermissionExpired",
                        requestId = requestId,
                        reason = "hook-closed",
                    ))) {
                    android.util.Log.e("EventBridge", "Event buffer full, dropped PermissionExpired")
                }
            }
        }
    }

    /**
     * Send a decision back through a held PermissionRequest socket.
     * Returns true if the write succeeded, false if it failed (in which case
     * this method has ALREADY emitted a "delivery-failed" PermissionExpired
     * itself — callers must not emit a second one for the same requestId, or
     * "at most one expiry per request" breaks for the hold-timeout path).
     */
    fun respond(requestId: String, decision: JSONObject): Boolean {
        // A decision is about to be delivered (or attempted) — the tier-1
        // hold is no longer needed. Cancel first so it can never race a
        // second emit for the same request.
        holdJobs.remove(requestId)?.cancel()
        val socket = pendingSockets.remove(requestId)
        if (socket == null) {
            android.util.Log.e("EventBridge", "No pending socket for requestId=$requestId")
            return false
        }
        try {
            val payload = decision.toString() + "\n"
            socket.outputStream.write(payload.toByteArray())
            socket.outputStream.flush()
            socket.close()
            return true
        } catch (e: Exception) {
            // Response couldn't be delivered — permission effectively expired.
            // Emit PermissionExpired so React UI clears the stale approval card.
            android.util.Log.e("EventBridge", "respond() write failed — emitting PermissionExpired", e)
            try { socket.close() } catch (_: Exception) {}
            _events.tryEmit(HookEvent.PermissionExpired(
                sessionId = "",  // ManagedSession uses its own ID for broadcast
                hookEventName = "PermissionExpired",
                requestId = requestId,
                reason = "delivery-failed",
            ))
            return false
        }
    }

    /** Close a held socket without sending a response (cross-path cleanup). */
    fun closeSocket(requestId: String) {
        holdJobs.remove(requestId)?.cancel()
        val socket = pendingSockets.remove(requestId) ?: return
        try { socket.close() } catch (_: Exception) {}
    }

    /**
     * True while any PermissionRequest socket is held open. In that window
     * Claude Code's TUI is showing a live Ink select menu (permission prompt /
     * AskUserQuestion / plan approval) — automated PTY writers must not send
     * bytes to this session or they act as menu keystrokes (a trailing `\r`
     * selects the highlighted option, silently answering the prompt).
     * EventBridge is per-session (one per PtyBridge), so no session filter is
     * needed. Desktop equivalent: HookRelay.hasPendingPermission (youcoded#110).
     */
    fun hasPendingPermission(): Boolean = pendingSockets.isNotEmpty()

    fun stop() {
        // Cancel any outstanding tier-1 hold timers so they don't fire (and
        // try to write to a socket we're about to close) after teardown.
        holdJobs.values.forEach { it.cancel() }
        holdJobs.clear()
        // Close all pending sockets
        for ((_, socket) in pendingSockets) {
            try { socket.close() } catch (_: Exception) {}
        }
        pendingSockets.clear()
        sessionIdMap.clear()
        transcriptPathMap.clear()
        listenJob?.cancel()
        try { serverSocket?.close() } catch (_: Exception) {}
        serverSocket = null
    }
}
