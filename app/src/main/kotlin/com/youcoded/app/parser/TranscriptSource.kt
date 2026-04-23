package com.youcoded.app.parser

import kotlinx.coroutines.flow.SharedFlow

/**
 * Common interface for everything that produces [TranscriptEvent]s for a
 * Claude Code session. Two implementations:
 *
 * - [TranscriptWatcher] — pure-Kotlin parser that reads the JSONL transcript
 *   directly. The legacy path; remains the default and the safety-net
 *   fallback when the Node CLI bundle is missing or fails to spawn.
 *
 * - [TranscriptWatcherProcess] — spawns the bundled `transcript-watcher-cli.js`
 *   under Termux Node and forwards its NDJSON output. Single source of truth
 *   with the desktop's in-process parser. Opt-in via the
 *   `transcriptWatcher.useNodeProcess` flag in `~/.claude-mobile/config.json`.
 *
 * The unified `startWatching` signature accepts every field either implementation
 * needs — Kotlin uses [transcriptPath]; the subprocess uses [claudeSessionId]
 * + [cwd] (the CLI re-derives the path from those, matching the desktop
 * TranscriptWatcher's path computation). Callers pass everything; each
 * implementation picks what it wants. ManagedSession.startTranscriptWatcher-
 * IfNeeded already has all four pieces of state, so this isn't extra work.
 */
interface TranscriptSource {
    val events: SharedFlow<TranscriptEvent>

    fun startWatching(
        mobileSessionId: String,
        claudeSessionId: String,
        cwd: String,
        transcriptPath: String,
    )

    fun stopWatching(mobileSessionId: String)
}
