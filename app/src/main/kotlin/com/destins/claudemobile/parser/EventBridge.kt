package com.destins.claudemobile.parser

import android.net.LocalServerSocket
import android.net.LocalSocket
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import java.io.BufferedReader
import java.io.InputStreamReader

class EventBridge(private val socketPath: String) {
    private val _events = MutableSharedFlow<HookEvent>(extraBufferCapacity = 1000)
    val events: SharedFlow<HookEvent> = _events

    private var serverSocket: LocalServerSocket? = null
    private var listenJob: Job? = null

    fun startServer(scope: CoroutineScope) {
        // Remove stale socket file if it exists
        try { java.io.File(socketPath).delete() } catch (_: Exception) {}

        listenJob = scope.launch(Dispatchers.IO) {
            try {
                serverSocket = LocalServerSocket(socketPath)
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

    private suspend fun handleClient(client: LocalSocket) {
        try {
            client.use { socket ->
                val reader = BufferedReader(InputStreamReader(socket.inputStream))
                val line = reader.readLine() ?: return
                HookEvent.fromJson(line)?.let { _events.emit(it) }
            }
        } catch (e: Exception) {
            android.util.Log.w("EventBridge", "Client error", e)
        }
    }

    fun stop() {
        listenJob?.cancel()
        try { serverSocket?.close() } catch (_: Exception) {}
        try { java.io.File(socketPath).delete() } catch (_: Exception) {}
        serverSocket = null
    }
}
