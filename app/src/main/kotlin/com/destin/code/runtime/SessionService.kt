package com.destin.code.runtime

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Intent
import android.net.Uri
import android.os.Binder
import android.os.FileObserver
import android.os.IBinder
import android.os.PowerManager
import com.destin.code.MainActivity
import com.destin.code.bridge.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

class SessionService : Service() {
    private val binder = LocalBinder()
    val sessionRegistry = SessionRegistry()
    val bridgeServer = LocalBridgeServer()
    var platformBridge: PlatformBridge? = null
    private val serviceScope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    /** View mode requested by React UI — ChatScreen observes this.
     *  SharedFlow (not StateFlow) because these are events, not state:
     *  "switch to terminal" must fire even if the last request was also "terminal". */
    private val _viewModeRequest = kotlinx.coroutines.flow.MutableSharedFlow<String>(extraBufferCapacity = 1)
    val viewModeRequest: kotlinx.coroutines.flow.SharedFlow<String> = _viewModeRequest

    /** Emit a view mode change from native code (e.g., TerminalKeyboardRow "Chat" button). */
    fun requestViewMode(mode: String) {
        _viewModeRequest.tryEmit(mode)
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var urlObserver: FileObserver? = null
    var bootstrap: Bootstrap? = null
        private set

    // Legacy single-session API — kept for ServiceBinder compatibility during migration
    var ptyBridge: PtyBridge? = null
        private set

    inner class LocalBinder : Binder() {
        val service: SessionService get() = this@SessionService
    }

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForeground(NOTIFICATION_ID, buildSessionNotification())

        val homeDir = bootstrap?.homeDir ?: filesDir
        platformBridge = PlatformBridge(applicationContext, homeDir)
        sessionRegistry.bridgeServer = bridgeServer
        if (!bridgeServer.isRunning) {
            bridgeServer.start { ws, msg ->
                serviceScope.launch {
                    handleBridgeMessage(ws, msg)
                }
            }
        }

        return START_STICKY
    }

    fun initBootstrap(bs: Bootstrap) {
        bootstrap = bs
        titlesDir.mkdirs()
        startUrlObserver(bs)
    }

    /** Watch ~/.claude-mobile/open-url for URLs written by the JS wrapper.
     *  Opens them via Android Intent (only way to launch browser from app UID). */
    private fun startUrlObserver(bs: Bootstrap) {
        val mobileDir = File(bs.homeDir, ".claude-mobile")
        mobileDir.mkdirs()
        val urlFile = File(mobileDir, "open-url")

        urlObserver?.stopWatching()
        urlObserver = object : FileObserver(mobileDir, CLOSE_WRITE or MODIFY) {
            override fun onEvent(event: Int, path: String?) {
                if (path != "open-url") return
                try {
                    val url = urlFile.readText().trim()
                    if (url.startsWith("http")) {
                        urlFile.delete()
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                        }
                        startActivity(intent)
                    }
                } catch (_: Exception) {}
            }
        }
        urlObserver?.startWatching()
    }

    val titlesDir: File get() = File(bootstrap?.homeDir ?: File("/"), ".claude-mobile/titles")

    // Legacy single-session API — used by ServiceBinder until full migration
    fun startSession(bs: Bootstrap, apiKey: String? = null) {
        initBootstrap(bs)
        val session = createSession(bs.homeDir, dangerousMode = false, apiKey = apiKey)
        ptyBridge = session.ptyBridge
        startForeground(NOTIFICATION_ID, buildSessionNotification())
    }

    fun stopSession() {
        sessionRegistry.destroyAll()
        ptyBridge = null
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    fun createSession(cwd: File, dangerousMode: Boolean, apiKey: String?): ManagedSession {
        val bs = bootstrap ?: throw IllegalStateException("Bootstrap not initialized")
        val session = sessionRegistry.createSession(bs, cwd, dangerousMode, apiKey, titlesDir)

        // Wire clipboard callback
        session.ptyBridge?.onCopyToClipboard = { text ->
            val clipboard = getSystemService(CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Terminal", text))
        }

        // Wire approval notification callbacks
        session.onApprovalNeeded = { sessionId, sessionName ->
            postApprovalNotification(sessionId, sessionName)
        }
        session.onApprovalCleared = { sessionId ->
            clearApprovalNotification(sessionId)
        }

        acquireWakeLock()
        updateNotification()
        return session
    }

    fun destroySession(sessionId: String) {
        sessionRegistry.destroySession(sessionId)
        if (sessionRegistry.sessionCount == 0) {
            releaseWakeLock()
            stopForeground(STOP_FOREGROUND_REMOVE)
            stopSelf()
        } else {
            updateNotification()
        }
    }

    fun destroyAllSessions() {
        sessionRegistry.destroyAll()
        ptyBridge = null
        releaseWakeLock()
        stopForeground(STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    private fun acquireWakeLock() {
        if (wakeLock == null) {
            val pm = getSystemService(POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "DestinCode::Session").apply {
                acquire(4 * 60 * 60 * 1000L) // 4 hour timeout
            }
        }
    }

    private fun releaseWakeLock() {
        wakeLock?.let {
            if (it.isHeld) it.release()
        }
        wakeLock = null
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        val sessionChannel = NotificationChannel(
            CHANNEL_SESSION, "DestinCode Sessions", NotificationManager.IMPORTANCE_LOW
        ).apply { description = "Active DestinCode sessions" }

        val approvalChannel = NotificationChannel(
            CHANNEL_APPROVAL, "Approval Prompts", NotificationManager.IMPORTANCE_HIGH
        ).apply { description = "DestinCode permission prompts" }

        manager.createNotificationChannel(sessionChannel)
        manager.createNotificationChannel(approvalChannel)
    }

    private fun buildSessionNotification(): Notification {
        val count = sessionRegistry.sessionCount
        val text = if (count <= 1) "Session active" else "$count sessions active"

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
        }
        val pending = PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE)

        return Notification.Builder(this, CHANNEL_SESSION)
            .setContentTitle("DestinCode")
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentIntent(pending)
            .setOngoing(true)
            .build()
    }

    fun postApprovalNotification(sessionId: String, sessionName: String) {
        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP
            putExtra("session_id", sessionId)
        }
        val pending = PendingIntent.getActivity(
            this, sessionId.hashCode(), intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val notification = Notification.Builder(this, CHANNEL_APPROVAL)
            .setContentTitle("$sessionName: waiting for approval")
            .setContentText("Tap to review permission request")
            .setSmallIcon(android.R.drawable.ic_menu_edit)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .build()

        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(APPROVAL_NOTIFICATION_BASE + sessionId.hashCode(), notification)
    }

    fun clearApprovalNotification(sessionId: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.cancel(APPROVAL_NOTIFICATION_BASE + sessionId.hashCode())
    }

    private fun updateNotification() {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, buildSessionNotification())
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep service running when user swipes app from recents
    }

    override fun onDestroy() {
        bridgeServer.stop()
        urlObserver?.stopWatching()
        urlObserver = null
        sessionRegistry.destroyAll()
        releaseWakeLock()
        super.onDestroy()
    }

    private suspend fun handleBridgeMessage(
        ws: org.java_websocket.WebSocket,
        msg: MessageRouter.ParsedMessage
    ) {
        when (msg.type) {
            "session:create" -> {
                val cwd = msg.payload.optString("cwd", bootstrap?.homeDir?.absolutePath ?: "")
                val dangerous = msg.payload.optBoolean("skipPermissions", false)
                android.util.Log.i("SessionService", "Bridge session:create cwd=$cwd dangerous=$dangerous")
                // TerminalSession requires the main thread (Looper)
                val session = withContext(Dispatchers.Main) {
                    createSession(File(cwd), dangerous, null)
                }
                android.util.Log.i("SessionService", "Session created: id=${session.id} ptyBridge=${session.ptyBridge != null} termSession=${session.getTerminalSession() != null}")
                val info = MessageRouter.buildSessionInfo(
                    id = session.id, name = session.name.value,
                    cwd = cwd, status = "active",
                    permissionMode = "normal", skipPermissions = dangerous,
                    createdAt = session.createdAt
                )
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, info) }
                bridgeServer.broadcast(JSONObject().apply {
                    put("type", "session:created")
                    put("payload", info)
                })
            }
            "session:destroy" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                withContext(Dispatchers.Main) {
                    destroySession(sessionId)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "session:list" -> {
                val sessions = sessionRegistry.sessions.value.map { (id, session) ->
                    MessageRouter.buildSessionInfo(
                        id = id, name = session.name.value,
                        cwd = session.cwd.absolutePath,
                        status = if (session.status.value == SessionStatus.Dead) "dead" else "active",
                        permissionMode = session.permissionMode,
                        skipPermissions = session.dangerousMode,
                        createdAt = session.createdAt
                    )
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray(sessions)) }
            }
            "session:switch" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                if (sessionId.isNotEmpty()) {
                    sessionRegistry.switchTo(sessionId)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "session:input" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                val text = msg.payload.optString("text", "")
                if (text.isNotEmpty()) {
                    sessionRegistry.sessions.value[sessionId]?.writeInput(text)
                }
            }
            "session:resize" -> {
                val sessionId = msg.payload.optString("sessionId", "")
                val cols = msg.payload.optInt("cols", 80)
                val rows = msg.payload.optInt("rows", 24)
                if (cols > 0 && rows > 0) {
                    try {
                        withContext(Dispatchers.Main) {
                            sessionRegistry.sessions.value[sessionId]?.getTerminalSession()?.updateSize(cols, rows)
                        }
                    } catch (e: Exception) {
                        android.util.Log.w("SessionService", "Resize failed: ${e.message}")
                    }
                }
            }
            "permission:respond" -> {
                val requestId = msg.payload.optString("requestId", "")
                val decision = msg.payload.optJSONObject("decision") ?: JSONObject()
                sessionRegistry.sessions.value.values.forEach { session ->
                    session.ptyBridge?.getEventBridge()?.respond(requestId, decision)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "skills:list" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
            }
            "github:auth" -> {
                // No GitHub auth on Android — return null
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject.NULL) }
            }
            "favorites:get" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("favorites", org.json.JSONArray())) }
            }
            "favorites:set" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("ok", true)) }
            }
            "get-home-path" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, platformBridge?.getHomePath() ?: "") }
            }
            "dialog:open-file" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("paths", org.json.JSONArray())) }
            }
            "clipboard:save-image" -> {
                val result = platformBridge?.saveClipboardImage() ?: JSONObject().put("path", JSONObject.NULL)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, result) }
            }
            "remote:get-client-count" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, 1) }
            }
            "remote:get-config" -> {
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, JSONObject().apply {
                        put("enabled", false)
                        put("port", 9901)
                        put("hasPassword", false)
                        put("trustTailscale", false)
                        put("keepAwakeHours", 0)
                        put("clientCount", 1)
                    })
                }
            }
            "remote:detect-tailscale" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("installed", false)) }
            }
            "remote:get-client-list" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
            }
            "remote:set-password" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "remote:set-config" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject()) }
            }
            "remote:disconnect-client" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "transcript:read-meta" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject.NULL) }
            }
            "session:terminal-ready" -> {
                // fire-and-forget — no response needed
            }
            "session:browse" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
            }
            "session:history" -> {
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, org.json.JSONArray()) }
            }
            "ui:action" -> {
                // Handle view switching from React UI
                val action = msg.payload.optString("action", "")
                if (action == "switch-view") {
                    val mode = msg.payload.optString("mode", "chat")
                    _viewModeRequest.tryEmit(mode)
                }
            }

            // ── Android-only settings bridge ────────────────────────────
            "android:get-tier" -> {
                val tierStore = com.destin.code.config.TierStore(applicationContext)
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("tier", tierStore.selectedTier.name)) }
            }
            "android:set-tier" -> {
                val tierName = msg.payload.optString("tier", "CORE")
                val tierStore = com.destin.code.config.TierStore(applicationContext)
                val newTier = try {
                    com.destin.code.config.PackageTier.valueOf(tierName)
                } catch (_: Exception) { com.destin.code.config.PackageTier.CORE }
                val changed = newTier != tierStore.selectedTier
                tierStore.selectedTier = newTier
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("restartRequired", changed)) }
            }
            "android:get-directories" -> {
                val homeDir = bootstrap?.homeDir ?: filesDir
                val store = com.destin.code.config.WorkingDirStore(homeDir)
                val dirs = org.json.JSONArray()
                store.allDirs().forEach { (label, dir) ->
                    dirs.put(JSONObject().put("label", label).put("path", dir.absolutePath))
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("directories", dirs)) }
            }
            "android:add-directory" -> {
                val path = msg.payload.optString("path", "")
                val label = msg.payload.optString("label", "")
                if (path.isNotEmpty()) {
                    val homeDir = bootstrap?.homeDir ?: filesDir
                    val store = com.destin.code.config.WorkingDirStore(homeDir)
                    store.add(com.destin.code.config.WorkingDir(label = label.ifEmpty { File(path).name }, path = path))
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "android:remove-directory" -> {
                val path = msg.payload.optString("path", "")
                if (path.isNotEmpty()) {
                    val homeDir = bootstrap?.homeDir ?: filesDir
                    val store = com.destin.code.config.WorkingDirStore(homeDir)
                    store.remove(path)
                }
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "android:get-about" -> {
                val pm = applicationContext.packageManager
                val info = pm.getPackageInfo(applicationContext.packageName, 0)
                msg.id?.let {
                    bridgeServer.respond(ws, msg.type, it, JSONObject().apply {
                        put("version", info.versionName ?: "unknown")
                        put("build", info.longVersionCode.toString())
                    })
                }
            }
            "android:get-paired-devices" -> {
                val prefs = applicationContext.getSharedPreferences("remote_devices", android.content.Context.MODE_PRIVATE)
                val json = prefs.getString("paired_devices", null)
                val devices = if (json != null) {
                    try { org.json.JSONArray(json) } catch (_: Exception) { org.json.JSONArray() }
                } else org.json.JSONArray()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("devices", devices)) }
            }
            "android:save-paired-device" -> {
                val prefs = applicationContext.getSharedPreferences("remote_devices", android.content.Context.MODE_PRIVATE)
                val existing = try {
                    org.json.JSONArray(prefs.getString("paired_devices", "[]"))
                } catch (_: Exception) { org.json.JSONArray() }
                val host = msg.payload.optString("host", "")
                val port = msg.payload.optInt("port", 9900)
                // Remove existing entry with same host:port
                val filtered = org.json.JSONArray()
                for (i in 0 until existing.length()) {
                    val d = existing.getJSONObject(i)
                    if (d.optString("host") != host || d.optInt("port") != port) {
                        filtered.put(d)
                    }
                }
                filtered.put(JSONObject().apply {
                    put("name", msg.payload.optString("name", "Desktop"))
                    put("host", host)
                    put("port", port)
                    put("password", msg.payload.optString("password", ""))
                })
                prefs.edit().putString("paired_devices", filtered.toString()).apply()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "android:remove-paired-device" -> {
                val prefs = applicationContext.getSharedPreferences("remote_devices", android.content.Context.MODE_PRIVATE)
                val existing = try {
                    org.json.JSONArray(prefs.getString("paired_devices", "[]"))
                } catch (_: Exception) { org.json.JSONArray() }
                val host = msg.payload.optString("host", "")
                val port = msg.payload.optInt("port", 9900)
                val filtered = org.json.JSONArray()
                for (i in 0 until existing.length()) {
                    val d = existing.getJSONObject(i)
                    if (d.optString("host") != host || d.optInt("port") != port) {
                        filtered.put(d)
                    }
                }
                prefs.edit().putString("paired_devices", filtered.toString()).apply()
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, true) }
            }
            "android:scan-qr" -> {
                // QR scanning requires Activity — return not-implemented for now,
                // will be wired to ActivityResultContracts in Phase 2
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, JSONObject().put("url", JSONObject.NULL)) }
            }

            else -> {
                android.util.Log.w("SessionService", "Unknown bridge message: ${msg.type}")
                msg.id?.let { bridgeServer.respond(ws, msg.type, it, MessageRouter.buildErrorResponse("Unknown: ${msg.type}")) }
            }
        }
    }

    companion object {
        const val CHANNEL_SESSION = "destincode_session"
        const val CHANNEL_APPROVAL = "destincode_approval"
        const val NOTIFICATION_ID = 1
        const val APPROVAL_NOTIFICATION_BASE = 1000
    }
}
