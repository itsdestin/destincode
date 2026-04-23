#!/usr/bin/env node
/**
 * Transcript watcher CLI — single-source-of-truth wrapper around
 * `TranscriptWatcher`. Bundled into a CommonJS file by
 * `desktop/scripts/build-transcript-watcher-cli.js` (esbuild) and shipped
 * inside the Android APK at `app/src/main/assets/transcript-watcher-cli.js`.
 * Android's `TranscriptWatcherProcess` spawns this script under Termux Node
 * and forwards each NDJSON event to the React UI over the LocalBridgeServer.
 *
 * Why a subprocess? The transcript JSONL parser is the most CC-coupled,
 * highest-drift surface in the app — it had to be reimplemented in Kotlin
 * for Android, and the two implementations had drifted (the now-removed
 * `streaming-text` event being one example). Running the same TS code on
 * both platforms eliminates that class of bug at the source.
 *
 * ── Protocol ────────────────────────────────────────────────────────────
 * stdin (NDJSON, one command per line):
 *   {"command":"watch","mobileSessionId":"...","claudeSessionId":"...","cwd":"..."}
 *   {"command":"unwatch","mobileSessionId":"..."}
 *   {"command":"history","mobileSessionId":"...","requestId":"..."}
 *
 * stdout (NDJSON):
 *   {"kind":"event","payload":<TranscriptEvent>}
 *   {"kind":"history","requestId":"...","payload":<TranscriptEvent[]>}
 *   {"kind":"ready"}                                 // emitted on startup
 *
 * stderr: free-form diagnostics (forwarded to Android logcat).
 *
 * ── Lifecycle ────────────────────────────────────────────────────────────
 * One process per app lifecycle (not per session). startWatching/stopWatching
 * are called per session via stdin commands. SIGTERM/SIGINT unwinds all
 * watchers cleanly so the supervisor can restart cleanly.
 */

import readline from 'readline';
import { TranscriptWatcher } from '../main/transcript-watcher';

function emit(obj: object): void {
  // Single-line JSON with newline terminator. Android reads line-by-line.
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const projectsDir = arg('--projects-dir');
const watcher = new TranscriptWatcher(projectsDir);

watcher.on('transcript-event', (event) => {
  emit({ kind: 'event', payload: event });
});

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: any;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    process.stderr.write(`bad command (not JSON): ${line}\n`);
    return;
  }
  try {
    switch (msg.command) {
      case 'watch':
        if (!msg.mobileSessionId || !msg.claudeSessionId || !msg.cwd) {
          process.stderr.write(`watch missing required fields: ${line}\n`);
          return;
        }
        watcher.startWatching(msg.mobileSessionId, msg.claudeSessionId, msg.cwd);
        return;
      case 'unwatch':
        if (!msg.mobileSessionId) {
          process.stderr.write(`unwatch missing mobileSessionId: ${line}\n`);
          return;
        }
        watcher.stopWatching(msg.mobileSessionId);
        return;
      case 'history':
        if (!msg.mobileSessionId || !msg.requestId) {
          process.stderr.write(`history missing required fields: ${line}\n`);
          return;
        }
        emit({ kind: 'history', requestId: msg.requestId, payload: watcher.getHistory(msg.mobileSessionId) });
        return;
      default:
        process.stderr.write(`unknown command: ${msg.command}\n`);
    }
  } catch (e: any) {
    process.stderr.write(`command failed: ${e?.message ?? e}\n`);
  }
});

rl.on('close', () => {
  watcher.stopAll();
  process.exit(0);
});

function shutdown(): void {
  try { watcher.stopAll(); } catch {}
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// Ready signal lets the supervisor know stdin is being read and the watcher
// is initialized. Important so the supervisor doesn't fire watch commands
// before the readline interface attaches.
emit({ kind: 'ready' });
