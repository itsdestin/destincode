import net from 'net';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { HookEvent } from '../shared/types';
import { log } from './logger';

const DEFAULT_PIPE_NAME = process.platform === 'win32'
  ? '\\\\.\\pipe\\claude-desktop-hooks'
  : path.join(os.tmpdir(), 'claude-desktop-hooks.sock');

// §1 tier-1 hold (2026-07-30 spec): the APP owns the permission-ask clock —
// 2h here < 2h30m relay backstop (relay-blocking.js) < 3h CC hook entry
// (install-hooks.js). Margins are load-bearing: if CC ever wins it kills the
// hook with NO decision and AskUserQuestion waits forever on CC's
// default-"never" question timeout. Do not equalize. NOTE: setTimeout does
// not advance during system suspend, so the hold can stretch past 2h of
// wall-clock on a laptop that slept — expected, not a bug.
export const APP_HOLD_MS = 7200000;
// §1a dead-man cap: an ask whose sessionId matches no live session will never
// render a card anywhere — a 2h hold would be a 2h invisible hang.
export const UNROUTABLE_HOLD_MS = 60000;

export class HookRelay extends EventEmitter {
  private server: net.Server | null = null;
  private running = false;
  // requestId → held socket + owning session. The sessionId is tracked so
  // hasPendingPermission() can tell automated PTY writers (e.g. the
  // /reload-plugins broadcast) that this session's terminal currently shows
  // a live permission/AskUserQuestion menu and must not be typed into.
  private pendingSockets = new Map<string, { socket: net.Socket; sessionId: string }>();
  private pipeName: string;
  // requestId → the app-owned hold timer for that pending ask. Cleared on
  // respond()/closeSocket()/socket-close/stop() — a leaked 2h timer would
  // hold a socket reference alive, and firing one after teardown would
  // respond() into a dead/reused socket.
  private holdTimers = new Map<string, NodeJS.Timeout>();
  private sessionGate: ((sessionId: string) => boolean) | null = null;
  private readonly holdMs: number;
  private readonly unroutableHoldMs: number;

  constructor(pipeName?: string, holdMs: number = APP_HOLD_MS, unroutableHoldMs: number = UNROUTABLE_HOLD_MS) {
    super();
    this.pipeName = pipeName || DEFAULT_PIPE_NAME;
    this.holdMs = holdMs;
    this.unroutableHoldMs = unroutableHoldMs;
  }

  /** main.ts wires this to SessionManager (mirrors setReloadPluginsGate). */
  setSessionGate(gate: (sessionId: string) => boolean): void {
    this.sessionGate = gate;
  }

  private clearHold(requestId: string): void {
    const t = this.holdTimers.get(requestId);
    if (t) { clearTimeout(t); this.holdTimers.delete(requestId); }
  }

  private parseHookPayload(data: string): HookEvent {
    const parsed = JSON.parse(data);
    return {
      type: parsed.hook_event_name || 'unknown',
      // Prefer our injected desktop session ID over Claude Code's internal session_id
      sessionId: parsed._desktop_session_id || parsed.session_id || '',
      payload: parsed,
      timestamp: Date.now(),
    };
  }

  private createServer(): net.Server {
    return net.createServer((socket) => {
      let data = '';
      let processed = false;
      socket.setEncoding('utf8');

      socket.on('error', (err) => {
        // Log connection-level errors for debugging (ECONNRESET, EPIPE, etc.)
        log('WARN', 'HookRelay', 'Socket error', { error: String(err.message) });
      });

      const processPayload = (payload: string) => {
        if (processed) return;
        processed = true;
        try {
          const parsed = JSON.parse(payload);
          const event = this.parseHookPayload(payload);

          if (parsed.hook_event_name === 'PermissionRequest') {
            // Hold the socket open — relay-blocking.js is waiting for a response
            const requestId = randomUUID();
            this.pendingSockets.set(requestId, { socket, sessionId: event.sessionId });
            event.payload._requestId = requestId;
            this.emit('hook-event', event);

            // §1 tier-1: the app ends the wait, with a labeled deny. §1a: an
            // unroutable ask (no live session at arrival) gets the short
            // dead-man cap instead — restores what the old 300s timeout was
            // silently doing for that case.
            const routable = this.sessionGate ? this.sessionGate(event.sessionId) : true;
            const holdMs = routable ? this.holdMs : this.unroutableHoldMs;
            this.holdTimers.set(requestId, setTimeout(() => {
              this.holdTimers.delete(requestId);
              // Nested { decision: { … } } is load-bearing: relay-blocking.js
              // reads appDecision.decision — a flat shape ships undefined.
              // The message lands VERBATIM in the denied tool result the model
              // reads (verified in the CC 2.1.220 binary), so say what
              // happened and invite a re-ask.
              this.respond(requestId, {
                decision: {
                  behavior: 'deny',
                  message: routable
                    ? `YouCoded auto-denied this request after ${Math.round(this.holdMs / 3600000)} hour(s) with no user response — ask again if still needed.`
                    : 'YouCoded could not route this request to any open session — auto-denied. Ask again if still needed.',
                },
              });
              // respond() deletes the pending entry BEFORE 'close' fires, so
              // the close handler's wasOpen guard swallows any emit —
              // app-initiated endings must emit explicitly (spec §2).
              this.emit('permission-expired', event.sessionId, requestId,
                routable ? 'app-timeout' : 'unroutable');
            }, holdMs));

            // When the socket closes (relay timeout, Claude Code kills hook,
            // or network error), notify listeners so the UI can clear the
            // awaiting-approval state instead of leaving dead buttons.
            socket.on('close', () => {
              this.clearHold(requestId);
              const wasOpen = this.pendingSockets.delete(requestId);
              if (wasOpen) {
                // Reachable ONLY when the far end went away first (relay
                // timeout/death, CC killing the hook): app-initiated paths
                // delete the entry before 'close' fires and emit their own
                // reason. That asymmetry IS the §2 discrimination.
                this.emit('permission-expired', event.sessionId, requestId, 'hook-closed');
              }
            });
          } else {
            this.emit('hook-event', event);
            socket.end();
          }
        } catch (err: any) {
          log('WARN', 'HookRelay', 'Invalid hook payload', { error: String(err.message) });
          socket.end();
        }
      };

      socket.on('data', (chunk) => {
        data += chunk;
        // Process all complete newline-delimited messages in the buffer
        let nlIndex: number;
        while ((nlIndex = data.indexOf('\n')) >= 0) {
          processPayload(data.substring(0, nlIndex));
          data = data.substring(nlIndex + 1);
        }
      });

      socket.on('end', () => {
        // Fallback: if no newline was found, parse whatever we have
        if (data.length > 0) {
          processPayload(data);
        }
      });
    });
  }

  async start(): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.tryListen();
        return;
      } catch (err: any) {
        if (err.code === 'EADDRINUSE' && attempt < 2) {
          // Stale pipe from a previous process — try to release it
          await this.forceReleasePipe();
        } else {
          throw err;
        }
      }
    }
  }

  private tryListen(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = this.createServer();
      this.server.listen(this.pipeName, () => {
        this.running = true;
        resolve();
      });
      this.server.on('error', reject);
    });
  }

  private async forceReleasePipe(): Promise<void> {
    // On Unix, try unlinking the stale socket file directly — this is the
    // most reliable way to clear a dead socket from a crashed process.
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.pipeName); } catch { /* may not exist */ }
      return;
    }

    // On Windows, named pipes held by dead processes can't be released by
    // client connection alone. We need to try connecting (which may error),
    // wait, and also try unlinking the pipe path as a filesystem entry.
    await new Promise<void>((resolve) => {
      const client = net.createConnection(this.pipeName, () => {
        client.end();
        setTimeout(resolve, 1000);
      });
      client.on('error', () => {
        setTimeout(resolve, 1000);
      });
      client.setTimeout(2000, () => {
        client.destroy();
        setTimeout(resolve, 1000);
      });
    });
  }

  respond(requestId: string, decision: object): boolean {
    this.clearHold(requestId);
    const pending = this.pendingSockets.get(requestId);
    if (!pending || pending.socket.destroyed) {
      this.pendingSockets.delete(requestId);
      return false;
    }
    pending.socket.write(JSON.stringify(decision) + '\n');
    pending.socket.end();
    this.pendingSockets.delete(requestId);
    return true;
  }

  closeSocket(requestId: string): void {
    this.clearHold(requestId);
    const pending = this.pendingSockets.get(requestId);
    if (pending && !pending.socket.destroyed) {
      pending.socket.end();
    }
    this.pendingSockets.delete(requestId);
  }

  /**
   * True while a PermissionRequest for this session is held open. In that
   * window Claude Code's TUI is showing a live Ink select menu — automated
   * PTY writers must not send bytes to the session or they will act as menu
   * keystrokes (a trailing `\r` selects the highlighted option).
   */
  hasPendingPermission(sessionId: string): boolean {
    for (const pending of this.pendingSockets.values()) {
      if (pending.sessionId === sessionId) return true;
    }
    return false;
  }

  stop(): void {
    // Clear all app-owned hold timers first — otherwise a still-pending
    // timer could fire respond() into a socket we're about to tear down.
    for (const t of this.holdTimers.values()) clearTimeout(t);
    this.holdTimers.clear();

    // Clean up all pending permission sockets
    for (const [, pending] of this.pendingSockets) {
      if (!pending.socket.destroyed) {
        pending.socket.end();
      }
    }
    this.pendingSockets.clear();

    if (this.server) {
      this.server.close();
      this.server = null;
      this.running = false;
    }
    // Clean up Unix socket file
    if (process.platform !== 'win32') {
      try { fs.unlinkSync(this.pipeName); } catch { /* may already be gone */ }
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  async simulateEvent(jsonPayload: string): Promise<void> {
    const event = this.parseHookPayload(jsonPayload);
    this.emit('hook-event', event);
  }
}
