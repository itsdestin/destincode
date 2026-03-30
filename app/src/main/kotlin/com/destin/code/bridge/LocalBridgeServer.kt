package com.destin.code.bridge

import android.util.Log
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import org.json.JSONObject
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * WebSocket server on localhost:9901 that speaks the same protocol
 * as the desktop's remote-server.ts. The React UI connects via
 * remote-shim.ts and sees the same API regardless of platform.
 */
class LocalBridgeServer(
    private val port: Int = 9901
) {
    companion object {
        private const val TAG = "LocalBridgeServer"
    }

    private var server: WebSocketServer? = null
    private val clients = ConcurrentHashMap<String, WebSocket>()
    private val clientIdCounter = AtomicInteger(0)

    /**
     * Start the WebSocket server. The [handleMessage] callback is invoked
     * for every parsed message from a client.
     */
    fun start(
        handleMessage: (ws: WebSocket, msg: MessageRouter.ParsedMessage) -> Unit
    ) {
        server = object : WebSocketServer(InetSocketAddress("127.0.0.1", port)) {
            override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
                val clientId = "client-${clientIdCounter.incrementAndGet()}"
                clients[clientId] = conn
                conn.setAttachment(clientId)
                Log.i(TAG, "Client connected: $clientId")

                // Auto-auth for localhost — send auth:ok immediately
                val authOk = MessageRouter.buildAuthOkResponse("android")
                conn.send(authOk.toString())
            }

            override fun onClose(conn: WebSocket, code: Int, reason: String, remote: Boolean) {
                val clientId = conn.getAttachment<String>()
                if (clientId != null) clients.remove(clientId)
                Log.i(TAG, "Client disconnected: $clientId")
            }

            override fun onMessage(conn: WebSocket, message: String) {
                Log.d(TAG, "RECV: ${message.take(200)}")
                val parsed = MessageRouter.parseMessage(message)
                if (parsed == null) {
                    Log.w(TAG, "Unparseable message: ${message.take(200)}")
                    return
                }
                if (parsed.type == "auth") return
                handleMessage(conn, parsed)
            }

            override fun onError(conn: WebSocket?, ex: Exception) {
                Log.e(TAG, "WebSocket error: ${ex.message}", ex)
            }

            override fun onStart() {
                Log.i(TAG, "LocalBridgeServer listening on 127.0.0.1:$port")
            }
        }

        server?.isReuseAddr = true
        server?.start()
    }

    fun stop() {
        try {
            server?.stop(1000)
        } catch (e: Exception) {
            Log.w(TAG, "Error stopping server: ${e.message}")
        }
        clients.clear()
        Log.i(TAG, "LocalBridgeServer stopped")
    }

    /** Send a push event to all connected clients */
    fun broadcast(message: JSONObject) {
        val msg = message.toString()
        Log.d(TAG, "BROADCAST (${clients.size} clients): ${msg.take(200)}")
        clients.values.forEach { ws ->
            try {
                ws.send(msg)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to broadcast: ${e.message}")
            }
        }
    }

    /** Send a response to a specific request */
    fun respond(ws: WebSocket, type: String, id: String, payload: Any?) {
        val msg = JSONObject().apply {
            put("type", "${type}:response")
            put("id", id)
            put("payload", payload ?: JSONObject.NULL)
        }.toString()
        Log.d(TAG, "RESPOND: $msg")
        ws.send(msg)
    }

    val isRunning: Boolean get() = server != null
}
