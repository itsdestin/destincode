package com.youcoded.app.runtime

import android.util.Log
import com.youcoded.app.bridge.LocalBridgeServer
import com.youcoded.app.parser.TranscriptSource
import com.youcoded.app.parser.TranscriptWatcher
import com.youcoded.app.parser.TranscriptWatcherProcess
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import java.io.File
import org.json.JSONObject

class SessionRegistry {
    var bridgeServer: LocalBridgeServer? = null
    private val _sessions = MutableStateFlow<Map<String, ManagedSession>>(emptyMap())
    val sessions: StateFlow<Map<String, ManagedSession>> = _sessions

    private val _currentSessionId = MutableStateFlow<String?>(null)
    val currentSessionId: StateFlow<String?> = _currentSessionId

    fun getCurrentSession(): ManagedSession? {
        val id = _currentSessionId.value ?: return null
        return _sessions.value[id]
    }

    fun createSession(
        bootstrap: Bootstrap,
        cwd: File,
        dangerousMode: Boolean,
        apiKey: String?,
        titlesDir: File,
        resumeSessionId: String? = null,
        model: String? = null,
    ): ManagedSession {
        val sessionId = java.util.UUID.randomUUID().toString()
        val socketName = "parser-$sessionId"
        val titleFile = File(titlesDir, sessionId)

        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        val bridge = PtyBridge(
            context = bootstrap.context,
            bootstrap = bootstrap,
            apiKey = apiKey,
            socketName = socketName,
            cwd = cwd,
            dangerousMode = dangerousMode,
            mobileSessionId = sessionId,
            resumeSessionId = resumeSessionId,
            model = model,
        )

        val projectsDir = File(bootstrap.homeDir, ".claude/projects")
        val transcriptWatcher: TranscriptSource = pickTranscriptSource(bootstrap, projectsDir, scope)

        val session = ManagedSession(
            id = sessionId,
            cwd = cwd,
            homeDir = bootstrap.homeDir,
            dangerousMode = dangerousMode,
            ptyBridge = bridge,
            transcriptWatcher = transcriptWatcher,
            titleFile = titleFile,
            scope = scope,
        )

        // Wire bridge server for React UI forwarding
        session.bridgeServer = bridgeServer

        // Start EventBridge BEFORE Claude Code — hooks fire immediately on launch
        bridge.startEventBridge(scope)
        bridge.start()
        session.startTitleObserver()

        // Wire up the current-session check for blue dot logic
        session.isCurrentSession = { _currentSessionId.value == sessionId }

        // Start background collectors (hook events, status polling, approval observer)
        session.startBackgroundCollectors()

        _sessions.update { it + (sessionId to session) }
        _currentSessionId.value = sessionId

        return session
    }

    /**
     * Pick the transcript source implementation per session. Returns
     * [TranscriptWatcherProcess] when the user has opted in via the
     * `transcriptWatcher.useNodeProcess` flag in `~/.claude-mobile/config.json`
     * AND the bundled CLI script is deployed; otherwise returns the legacy
     * Kotlin [TranscriptWatcher].
     *
     * Why opt-in default-off: the Node-CLI path is the long-term plan (single
     * source of truth with desktop, prevents the parser drift that produced
     * Bug 2 in docs/plans/2026-04-23-android-desktop-parity.md), but it
     * spawns a Node subprocess per session and has had no production runtime
     * yet. Default-off lets the user flip the flag for one session to test
     * before we commit to it as default-on in a future release.
     */
    private fun pickTranscriptSource(
        bootstrap: Bootstrap,
        projectsDir: File,
        scope: CoroutineScope,
    ): TranscriptSource {
        val useNodeProcess = readUseNodeProcessFlag(bootstrap)
        val cliFile = File(bootstrap.homeDir, ".claude-mobile/transcript-watcher-cli.js")
        if (useNodeProcess && cliFile.exists()) {
            Log.i("SessionRegistry", "Using TranscriptWatcherProcess (Node CLI) for transcript parsing")
            return TranscriptWatcherProcess(bootstrap, scope)
        }
        if (useNodeProcess) {
            Log.w("SessionRegistry", "useNodeProcess set but CLI bundle missing at ${cliFile.absolutePath} — falling back to Kotlin watcher")
        }
        return TranscriptWatcher(projectsDir, scope)
    }

    /**
     * Read the boolean flag from `~/.claude-mobile/config.json` at key
     * `transcriptWatcher.useNodeProcess`. Tolerates missing file / malformed
     * JSON / missing key by returning false. Re-read every session create so
     * the user can toggle the flag without an app restart (next new session
     * picks up the change).
     */
    private fun readUseNodeProcessFlag(bootstrap: Bootstrap): Boolean {
        val configFile = File(bootstrap.homeDir, ".claude-mobile/config.json")
        if (!configFile.exists()) return false
        return try {
            val obj = JSONObject(configFile.readText())
            val tw = obj.optJSONObject("transcriptWatcher") ?: return false
            tw.optBoolean("useNodeProcess", false)
        } catch (_: Exception) {
            false
        }
    }

    fun switchTo(sessionId: String) {
        if (_sessions.value.containsKey(sessionId)) {
            // Notify the old session so it can re-derive status (may turn blue)
            val oldId = _currentSessionId.value
            if (oldId != null && oldId != sessionId) {
                _sessions.value[oldId]?.notifyViewedStateChanged()
            }
            // Switch and mark viewed
            _currentSessionId.value = sessionId
            val session = _sessions.value[sessionId]
            session?.hasBeenViewed = true
            session?.notifyViewedStateChanged()
        }
    }

    fun destroySession(sessionId: String) {
        val session = _sessions.value[sessionId] ?: return
        session.destroy()
        _sessions.update { it - sessionId }
        // If we destroyed the current session, switch to another or null
        if (_currentSessionId.value == sessionId) {
            _currentSessionId.value = _sessions.value.keys.firstOrNull()
        }
    }

    fun destroyAll() {
        _sessions.value.values.forEach { it.destroy() }
        _sessions.value = emptyMap()
        _currentSessionId.value = null
    }

    fun relaunchSession(
        sessionId: String,
        bootstrap: Bootstrap,
        apiKey: String?,
        titlesDir: File,
    ): ManagedSession? {
        val old = _sessions.value[sessionId] ?: return null
        destroySession(sessionId)
        return if (old.shellMode) {
            createShellSession(bootstrap, titlesDir)
        } else {
            createSession(bootstrap, old.cwd, old.dangerousMode, apiKey, titlesDir)
        }
    }

    /** Create a managed shell session (appears in session switcher). */
    fun createShellSession(bootstrap: Bootstrap, titlesDir: File): ManagedSession {
        val sessionId = java.util.UUID.randomUUID().toString()
        val titleFile = File(titlesDir, sessionId)
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

        val shell = DirectShellBridge(bootstrap).also { it.start() }

        val session = ManagedSession(
            id = sessionId,
            cwd = bootstrap.homeDir,
            homeDir = bootstrap.homeDir,
            dangerousMode = false,
            directShellBridge = shell,
            shellMode = true,
            titleFile = titleFile,
            scope = scope,
        )

        session.startBackgroundCollectors()

        _sessions.update { it + (sessionId to session) }
        _currentSessionId.value = sessionId

        return session
    }

    /**
     * Resume a past session. Creates a new Claude Code PTY with --resume flag
     * in the session's original project directory, then loads history.
     * Mirrors the desktop's handleResumeSession() in App.tsx.
     */
    fun resumeSession(
        pastSession: SessionBrowser.PastSession,
        bootstrap: Bootstrap,
        apiKey: String?,
        titlesDir: File,
        model: String? = null,
    ): ManagedSession {
        // Derive CWD from the project slug — fall back to homeDir if path doesn't exist
        val cwd = SessionBrowser.slugToCwd(pastSession.projectSlug, bootstrap.homeDir)

        // Create session with --resume CLI flag (NOT /resume stdin)
        val session = createSession(
            bootstrap = bootstrap,
            cwd = cwd,
            dangerousMode = false,
            apiKey = apiKey,
            titlesDir = titlesDir,
            resumeSessionId = pastSession.sessionId,
            model = model,
        )

        // History for resumed sessions is now handled entirely by the React UI
        // via TranscriptWatcher forwarding — no need to load it here.

        return session
    }

    val sessionCount: Int get() = _sessions.value.size
}
