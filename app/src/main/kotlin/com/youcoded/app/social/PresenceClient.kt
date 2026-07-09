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
    private var ws: WebSocket? = null
    @Volatile private var desired = false
    private var attempts = 0
    private val backoffMs = longArrayOf(1_000, 2_000, 5_000, 10_000, 30_000)
    private val handler = android.os.Handler(android.os.Looper.getMainLooper())

    fun setDesired(want: Boolean) {
        desired = want
        if (want) connect()
        else { ws?.close(1000, "incognito or sign-out"); ws = null }
    }

    fun send(message: JSONObject) { ws?.send(message.toString()) }

    private fun connect() {
        val token = getToken() ?: return
        // Guard covers both a duplicate connect and the retry runnable firing
        // after desired flipped to false while it was queued.
        if (!desired || ws != null) return
        val req = Request.Builder()
            .url("wss://wecoded-marketplace-api.destinj101.workers.dev/social/presence")
            .header("Authorization", "Bearer $token")
            .build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempts = 0
                onEvent(JSONObject().put("type", "connected"))
            }
            override fun onMessage(webSocket: WebSocket, text: String) {
                // Server protocol frames + pong are all JSON; ignore non-JSON.
                runCatching { onEvent(JSONObject(text)) }
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = retry(code, reason)
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = retry(1006, t.message ?: "failure")
        })
    }

    private fun retry(code: Int, reason: String) {
        ws = null
        onEvent(JSONObject().put("type", "disconnected").put("code", code).put("reason", reason))
        if (desired) {
            // Capped backoff so a Worker deploy doesn't kill presence for the session
            val delay = backoffMs[minOf(attempts, backoffMs.size - 1)]
            attempts += 1
            handler.postDelayed({ connect() }, delay)
        }
    }
}
