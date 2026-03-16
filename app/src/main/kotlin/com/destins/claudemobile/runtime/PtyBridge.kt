package com.destins.claudemobile.runtime

import com.destins.claudemobile.parser.EventBridge
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import java.io.File

class PtyBridge(
    private val bootstrap: Bootstrap,
    private val apiKey: String? = null,
) {
    private var session: TerminalSession? = null
    private var eventBridge: EventBridge? = null
    val socketPath: String get() = "${bootstrap.homeDir.absolutePath}/.claude-mobile/parser.sock"

    private val _outputFlow = MutableSharedFlow<String>(replay = 0, extraBufferCapacity = 1000)
    val outputFlow: SharedFlow<String> = _outputFlow

    private val _screenVersion = MutableStateFlow(0)
    val screenVersion: StateFlow<Int> = _screenVersion

    /** Timestamp of last PTY output — used by activity indicator */
    private val _lastPtyOutputTime = MutableStateFlow(0L)
    val lastPtyOutputTime: StateFlow<Long> = _lastPtyOutputTime

    private val _rawBuffer = StringBuilder()
    val rawBuffer: String get() = _rawBuffer.toString()
    private var lastTranscriptLength = 0

    val isRunning: Boolean get() = session?.isRunning == true

    private val sessionClient = object : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession) {
            _screenVersion.value++
            _lastPtyOutputTime.value = System.currentTimeMillis()

            val transcript = changedSession.getEmulator()?.getScreen()?.getTranscriptText() ?: return
            if (transcript.length > lastTranscriptLength) {
                val delta = transcript.substring(lastTranscriptLength)
                lastTranscriptLength = transcript.length
                _rawBuffer.append(delta)
                _outputFlow.tryEmit(delta)
            } else if (transcript.length < lastTranscriptLength) {
                lastTranscriptLength = transcript.length
            }
        }

        override fun onTitleChanged(changedSession: TerminalSession) {}
        override fun onSessionFinished(finishedSession: TerminalSession) {}
        override fun onCopyTextToClipboard(session: TerminalSession, text: String) {}
        override fun onPasteTextFromClipboard(session: TerminalSession) {}
        override fun onBell(session: TerminalSession) {}
        override fun onColorsChanged(session: TerminalSession) {}
        override fun onTerminalCursorStateChange(state: Boolean) {}
        override fun getTerminalCursorStyle(): Int? = null
        override fun logError(tag: String?, message: String?) {}
        override fun logWarn(tag: String?, message: String?) {}
        override fun logInfo(tag: String?, message: String?) {}
        override fun logDebug(tag: String?, message: String?) {}
        override fun logVerbose(tag: String?, message: String?) {}
        override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}
        override fun logStackTrace(tag: String?, e: Exception?) {}
    }

    fun startEventBridge(scope: CoroutineScope) {
        val bridge = EventBridge(socketPath)
        bridge.startServer(scope)
        eventBridge = bridge
    }

    fun start() {
        val env = bootstrap.buildRuntimeEnv().toMutableMap()
        apiKey?.let { env["ANTHROPIC_API_KEY"] = it }

        // Set socket path for hook-relay.js
        env["CLAUDE_MOBILE_SOCKET"] = socketPath

        val claudePath = File(bootstrap.usrDir, "lib/node_modules/@anthropic-ai/claude-code/cli.js")
        val nodePath = File(bootstrap.usrDir, "bin/node")

        // Always deploy/update helper files before launch — setup() may not run
        // on existing installations after an APK update.
        val mobileDir = File(bootstrap.homeDir, ".claude-mobile")
        mobileDir.mkdirs()
        val wrapperPath = File(mobileDir, "claude-wrapper.js")
        wrapperPath.writeText(WRAPPER_JS)

        // Deploy BASH_ENV script that creates shell functions for all embedded
        // binaries, routing them through linker64. This fixes "Permission denied"
        // errors when bash tries to exec binaries in app_data_file (SELinux blocks
        // direct exec, but shell functions run in-process — no exec needed).
        val bashEnvPath = File(mobileDir, "linker64-env.sh")
        bashEnvPath.writeText(buildBashEnvSh(bootstrap.usrDir.absolutePath))
        env["BASH_ENV"] = bashEnvPath.absolutePath

        // Launch Claude Code through the JS wrapper, which patches child_process
        // and fs to route embedded binary exec calls through linker64.
        // The wrapper fixes Claude Code's shell detection (it requires bash/zsh
        // but can't exec them directly due to SELinux on app_data_file).
        val launchCmd = "exec /system/bin/linker64 ${nodePath.absolutePath} ${wrapperPath.absolutePath} ${claudePath.absolutePath}"

        File(bootstrap.homeDir, "tmp").mkdirs()

        val envArray = env.map { "${it.key}=${it.value}" }.toTypedArray()

        // TerminalSession passes args as argv to execvp. argv[0] must be the
        // program name ("sh"), then "-c", then the command string.
        session = TerminalSession(
            "/system/bin/sh",
            bootstrap.homeDir.absolutePath,
            arrayOf("sh", "-c", launchCmd),
            envArray,
            200,
            sessionClient
        )
        // initializeEmulator forks the process and starts the PTY.
        // Without this call, the session is created but nothing runs.
        session?.initializeEmulator(60, 40)
    }

    fun writeInput(text: String) {
        android.util.Log.d("PtyBridge", "writeInput: ${text.map { if (it.code < 32) "\\x${it.code.toString(16)}" else it.toString() }.joinToString("")}")
        session?.write(text)
    }

    fun sendApproval(accepted: Boolean) {
        writeInput(if (accepted) "y\r" else "n\r")
    }

    fun sendBtw(message: String) {
        writeInput("/btw $message\r")
    }

    fun getSession(): TerminalSession? = session

    fun getEventBridge(): EventBridge? = eventBridge

    /** Create a standalone bash shell session (no Claude Code). */
    fun createDirectShell(): DirectShellBridge {
        return DirectShellBridge(bootstrap).also { it.start() }
    }

    fun stop() {
        eventBridge?.stop()
        session?.finishIfRunning()
        session = null
    }

    companion object {
        // Embedded wrapper JS — patches child_process/fs for SELinux exec bypass.
        // Key addition: injectEnv() explicitly sources BASH_ENV into every bash -c
        // command, ensuring shell function wrappers are always available.
        private val WRAPPER_JS = """
'use strict';
var child_process = require('child_process');
var fs = require('fs');
var LINKER64 = '/system/bin/linker64';
var PREFIX = process.env.PREFIX || '';
var BASH_ENV_FILE = process.env.BASH_ENV || '';
function isEB(f) { return f && PREFIX && f.startsWith(PREFIX + '/'); }
var _as = fs.accessSync;
fs.accessSync = function(p, m) {
    if (isEB(p) && m !== undefined && (m & fs.constants.X_OK)) return _as.call(this, p, fs.constants.R_OK);
    return _as.apply(this, arguments);
};
function injectEnv(cmd, args) {
    if (BASH_ENV_FILE && cmd.endsWith('/bash') && Array.isArray(args) && args[0] === '-c' && args.length >= 2) {
        args = args.slice();
        args[1] = '. "' + BASH_ENV_FILE + '" 2>/dev/null; ' + args[1];
    }
    return args;
}
var _efs = child_process.execFileSync;
child_process.execFileSync = function(file) {
    if (isEB(file)) {
        var args = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[1] : [];
        var opts = arguments.length > 1 && Array.isArray(arguments[1]) ? arguments[2] : arguments[1];
        args = injectEnv(file, args);
        return _efs.call(this, LINKER64, [file].concat(args), opts);
    }
    return _efs.apply(this, arguments);
};
var _ef = child_process.execFile;
child_process.execFile = function(file) {
    if (isEB(file)) {
        var rest = Array.prototype.slice.call(arguments, 1);
        var args = rest.length > 0 && Array.isArray(rest[0]) ? rest[0] : [];
        var remaining = rest.length > 0 && Array.isArray(rest[0]) ? rest.slice(1) : rest;
        args = injectEnv(file, args);
        return _ef.apply(this, [LINKER64, [file].concat(args)].concat(remaining));
    }
    return _ef.apply(this, arguments);
};
// Strip -l flag from bash args. Claude Code sends ["-c", "-l", cmd] but
// via linker64 bash treats -l as the command string, not an option.
function stripLogin(args) {
    return args.filter(function(a) { return a !== '-l'; });
}
var _sp = child_process.spawn;
child_process.spawn = function(command, args, options) {
    if (isEB(command)) {
        var actualArgs = Array.isArray(args) ? args : [];
        var actualOpts = Array.isArray(args) ? options : args;
        actualArgs = stripLogin(actualArgs);
        actualArgs = injectEnv(command, actualArgs);
        return _sp.call(this, LINKER64, [command].concat(actualArgs), actualOpts);
    }
    return _sp.call(this, command, args, options);
};
var _sps = child_process.spawnSync;
child_process.spawnSync = function(command, args, options) {
    if (isEB(command)) {
        var actualArgs = Array.isArray(args) ? args : [];
        var actualOpts = Array.isArray(args) ? options : args;
        actualArgs = stripLogin(actualArgs);
        actualArgs = injectEnv(command, actualArgs);
        return _sps.call(this, LINKER64, [command].concat(actualArgs), actualOpts);
    }
    return _sps.call(this, command, args, options);
};
var cliPath = process.argv[2];
if (!cliPath) { process.stderr.write('claude-wrapper: missing CLI path\n'); process.exit(1); }
process.argv = [process.argv[0], cliPath].concat(process.argv.slice(3));
require(cliPath);
        """.trimIndent()

        /**
         * Generate BASH_ENV script with explicit shell functions for each binary.
         * Generated at launch time from the actual files in usr/bin/ — avoids all
         * shell eval/escaping issues since each function is a static string.
         *
         * Detects file type by reading the first bytes:
         * - ELF binaries → wrap with linker64 directly
         * - Scripts with shebangs → run the interpreter through linker64 with
         *   the script as an argument (linker64 can't load scripts)
         */
        private fun buildBashEnvSh(usrPath: String): String {
            val binDir = File(usrPath, "bin")
            if (!binDir.isDirectory) return "# bin dir not found\n"
            val skip = setOf("bash", "sh", "sh-wrapper", "env")
            val sb = StringBuilder("# linker64 wrapper functions for embedded binaries\n")
            val functionNames = mutableListOf<String>()

            binDir.listFiles()?.sorted()?.forEach { file ->
                if (!file.isFile) return@forEach
                val n = file.name
                if (n in skip) return@forEach
                if (!n.matches(Regex("[a-zA-Z_][a-zA-Z0-9_.+-]*"))) return@forEach

                // Read first bytes to determine file type
                val header = ByteArray(512)
                val bytesRead = try {
                    file.inputStream().use { it.read(header) }
                } catch (_: Exception) { return@forEach }
                if (bytesRead < 2) return@forEach

                val isElf = bytesRead >= 4 &&
                    header[0] == 0x7f.toByte() &&
                    header[1] == 'E'.code.toByte() &&
                    header[2] == 'L'.code.toByte() &&
                    header[3] == 'F'.code.toByte()

                val isScript = header[0] == '#'.code.toByte() &&
                    header[1] == '!'.code.toByte()

                if (isElf) {
                    // ELF binary — run directly through linker64
                    sb.appendLine("""$n() { /system/bin/linker64 "$usrPath/bin/$n" "${'$'}@"; }""")
                } else if (isScript) {
                    // Script — parse shebang to find the interpreter, then run
                    // the interpreter through linker64 with the script as arg
                    val shebangLine = String(header, 0, bytesRead)
                        .lines().first().removePrefix("#!").trim()
                    val parts = shebangLine.split(Regex("\\s+"))
                    val interpreter = parts[0]
                    val interpArgs = parts.drop(1)

                    if (interpreter.endsWith("/env") && interpArgs.isNotEmpty()) {
                        // #!/usr/bin/env node → resolve to $PREFIX/bin/node
                        val prog = interpArgs[0]
                        sb.appendLine("""$n() { /system/bin/linker64 "$usrPath/bin/$prog" "$usrPath/bin/$n" "${'$'}@"; }""")
                    } else {
                        // Direct interpreter path — resolve basename to our prefix
                        val interpName = File(interpreter).name
                        sb.appendLine("""$n() { /system/bin/linker64 "$usrPath/bin/$interpName" "$usrPath/bin/$n" "${'$'}@"; }""")
                    }
                } else {
                    // Unknown type — try linker64 (may work for static binaries)
                    sb.appendLine("""$n() { /system/bin/linker64 "$usrPath/bin/$n" "${'$'}@"; }""")
                }
                functionNames.add(n)
            }

            // Export all functions so they're available in subshells
            if (functionNames.isNotEmpty()) {
                sb.appendLine()
                sb.appendLine("# Export functions for subshells")
                for (n in functionNames) {
                    sb.appendLine("export -f $n 2>/dev/null")
                }
            }
            return sb.toString()
        }
    }
}
