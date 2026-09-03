// Android mirror of desktop's presence-socket.ts: SessionService owns the
// socket + token; React only sees relayed social:presence-event pushes.
package com.youcoded.app.social

import okhttp3.*
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class PresenceClient(
    private val getToken: () -> String?,
    private val onEvent: (JSONObject) -> Unit,
) {
    // Dedicated client so pingInterval (WebSocket-protocol keepalive) is scoped
    // to presence and doesn't perturb the marketplace REST OkHttpClient.
    private val http = OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build()

    // THREADING MODEL: all state mutation (desired / ws / attempts) is serialized
    // on the main-looper handler — setDesired() and send() marshal their bodies
    // onto it, retry's delayed connect() already posts to it, and every OkHttp
    // callback re-posts before touching state. One thread owns the state machine,
    // mirroring desktop's Node event loop, so no @Volatile is needed on these and
    // the check-then-act sequences (e.g. `if (ws != null) return; ws = ...`)
    // can't interleave.
    private var ws: WebSocket? = null
    private var desired = false
    private var attempts = 0
    private val backoffMs = longArrayOf(1_000, 2_000, 5_000, 10_000, 30_000)
    // Desktop parity: reconnecting-ws.ts PING_INTERVAL_MS — the app-level ping
    // both platforms must send (see schedulePing below for why OkHttp's
    // protocol-level ping is not enough).
    private val pingIntervalMs = 30_000L
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    // Read by isConnected() from the SessionService bridge thread (the honest
    // presence-send receipt check) while writes happen on the main looper — so
    // this one flag stays @Volatile even though the rest of the state doesn't.
    @Volatile private var connected = false

    fun isConnected(): Boolean = connected

    fun setDesired(want: Boolean) {
        // Marshal onto the main looper: the caller runs on the bridge thread and
        // this compound check-then-act must not race a queued retry connect().
        handler.post {
            desired = want
            if (want) { connect(); return@post }
            val s = ws ?: return@post // want-off with no socket: any queued retry self-cancels via connect()'s desired guard
            // Capture-and-null FIRST so the socket's async onClosed/onFailure is
            // recognized as superseded (retry()'s `ws !== source` guard) and
            // doesn't double-emit or schedule a reconnect.
            ws = null
            connected = false
            s.close(1000, "incognito or sign-out")
            // reason:'local' marks an INTENTIONAL disconnect (desktop parity) —
            // Task 7 uses it to suppress "reconnecting" UI. Emitted synchronously
            // here rather than waiting for OkHttp's async close callback.
            onEvent(JSONObject().put("type", "disconnected").put("code", 1000).put("reason", "local"))
        }
    }

    fun send(message: JSONObject) {
        // Same looper as all other socket-state access — see THREADING MODEL.
        handler.post { ws?.send(message.toString()) }
    }

    private fun connect() {
        // No token: stay quiet. The renderer re-invokes presence-connect when
        // sign-in completes; do NOT turn this bail into an error — no-token is
        // the normal pre-sign-in state.
        val token = getToken() ?: return
        // Guard covers both a duplicate connect and the retry runnable firing
        // after desired flipped to false while it was queued.
        if (!desired || ws != null) return
        val req = Request.Builder()
            // WHY: Moved to its own domain so Cloudflare's cache and rate limiter apply; the old workers.dev address still answers for older app versions.
            .url("wss://api.youcoded.ai/social/presence")
            .header("Authorization", "Bearer $token")
            .build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                handler.post {
                    // Superseded before the handshake completed (disconnect during
                    // the connect window) — don't emit a spurious 'connected'.
                    if (ws !== webSocket) return@post
                    attempts = 0
                    connected = true
                    onEvent(JSONObject().put("type", "connected"))
                    schedulePing(webSocket)
                }
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                // Server protocol frames + pong are all JSON; ignore non-JSON.
                // Relay directly (no state touched) — onEvent is thread-safe.
                runCatching { onEvent(JSONObject(text)) }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                handler.post { retry(webSocket, code, reason) }
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // Desktop parity: emit {type:'error', message} BEFORE the
                // disconnected+retry so Task 7's error state also sets on Android.
                onEvent(JSONObject().put("type", "error").put("message", t.message ?: "failure"))
                handler.post { retry(webSocket, 1006, t.message ?: "failure") }
            }
        })
    }

    // App-level liveness ping — REQUIRED, not redundant with OkHttp's
    // pingInterval. OkHttp sends WebSocket *protocol* pings, which Cloudflare's
    // edge answers without the presence room ever observing them; the server's
    // liveness model (PresenceRoom stale-socket eviction, 2026-07-22) counts
    // only application frames and its auto-response JSON ping pair. Without
    // this loop, every Android socket looks permanently silent server-side and
    // gets evicted on the staleness timer. The string must stay byte-exact:
    // the server's WebSocketRequestResponsePair matches {"type":"ping"}
    // (identical to desktop's JSON.stringify({type:'ping'})).
    // OkHttp's protocol ping stays enabled too — it is what detects a dead
    // connection CLIENT-side and triggers the reconnect backoff.
    private fun schedulePing(socket: WebSocket) {
        handler.postDelayed({
            // Superseded or torn down — stop silently; a new socket's onOpen
            // starts its own loop. Same identity guard as retry().
            if (ws !== socket) return@postDelayed
            socket.send("""{"type":"ping"}""")
            schedulePing(socket)
        }, pingIntervalMs)
    }

    private fun retry(source: WebSocket, code: Int, reason: String) {
        // Superseded socket (intentional local disconnect already nulled ws and
        // emitted its own event) — its lifecycle no longer drives state.
        if (ws !== source) return
        ws = null
        connected = false
        onEvent(JSONObject().put("type", "disconnected").put("code", code).put("reason", reason))
        if (desired) {
            // Capped backoff so a Worker deploy doesn't kill presence for the
            // session. A dead-token loop is bounded by the account revalidation
            // path: dead token → 401 on any account call → signOut → the
            // sign-out case calls setDesired(false).
            val delay = backoffMs[minOf(attempts, backoffMs.size - 1)]
            attempts += 1
            handler.postDelayed({ connect() }, delay)
        }
    }
}
