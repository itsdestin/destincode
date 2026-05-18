import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { SessionInfo, SessionProvider } from '../shared/types';
import { EventEmitter } from 'events';
import { log } from './logger';
import { OpenCodeService } from './opencode-service';
import { OpenCodeSessionAdapter } from './opencode-session-adapter';
import { getModelCapability } from '../shared/local-effort-capability';

// Optional — which may not be installed; fall back to bare command name
let whichSync: ((cmd: string) => string) | null = null;
try { const w = require('which'); whichSync = w.sync; } catch { /* noop */ }

export interface CreateSessionOpts {
  name: string;
  cwd: string;
  skipPermissions: boolean;
  cols?: number;
  rows?: number;
  /** Resume a previous session by its Claude Code session ID */
  resumeSessionId?: string;
  model?: string;
  /** Which CLI backend to launch — defaults to 'claude' */
  provider?: SessionProvider;
  /** Optional text to prefill into the input bar after the session is selected.
   *  Forwarded into SessionInfo so the renderer can pick it up on session-created. */
  initialInput?: string;
  /** Local-only: system prompt to pass to OpenCode session creation */
  systemPrompt?: string;
}

interface ManagedSession {
  info: SessionInfo;
  // null for local sessions — they have no PTY worker, they delegate to OpenCodeService.
  worker: ChildProcess | null;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private pipeName: string = '';

  // Set once by ipc-handlers after the OpenCode daemon starts (Task 8 wires this in).
  private opencodeService: OpenCodeService | null = null;

  // Keyed on desktop session id. One adapter per local session — translates
  // SSE events from OpenCode into transcript-event re-emissions.
  private localAdapters = new Map<string, OpenCodeSessionAdapter>();

  // Desktop id -> OpenCode session id. For RESUME these are equal (the user
  // picked an OC session id from the resume browser). For NEW sessions, the
  // desktop id is a fresh UUID and the OC id is whatever OpenCode generates
  // when we call createSession; the renderer holds the desktop id, but
  // every SDK call needs the OC id, so we translate via this map.
  private localIdMap = new Map<string, string>();

  // sendInput may arrive after createSession returned synchronously but
  // before the OC session id resolved. Queue the texts and drain when ready.
  private localPendingSends = new Map<string, string[]>();

  // Per-local-session system prompt, captured at create time. Used by
  // sendInput's local branch to (a) pass user-configured prompts through
  // to OpenCode, and (b) prepend thinking-trigger tokens for binary-thinking
  // models (e.g. Gemma 4's `<|think|>`). Stored separate from the SessionInfo
  // because SessionInfo is shaped for cross-platform parity with Claude.
  private localSystemPrompts = new Map<string, string>();

  /** Read the captured system prompt for a local session id, or undefined
   *  if none was configured. */
  localSystemPromptFor(desktopId: string): string | undefined {
    return this.localSystemPrompts.get(desktopId);
  }

  /**
   * Resolve the per-message dispatch shape for a local session: the model
   * spec to send AND the system prompt to use. Encapsulates the per-mechanism
   * routing (variant suffix passthrough vs system-prompt token injection).
   * Used by BOTH sendInput's live path AND the queued-sends drain in
   * createSession's .then() — they must produce identical shapes or queued
   * messages would silently bypass thinking-token injection on gemma4 etc.
   */
  private resolveLocalDispatch(desktopId: string): {
    modelSpec: { providerID: string; modelID: string } | undefined;
    systemPrompt: string | undefined;
  } {
    const info = this.sessions.get(desktopId)?.info;
    let resolvedModelId = info?.model ?? '';
    const systemPrompt: string | undefined = this.localSystemPrompts.get(desktopId);
    if (resolvedModelId) {
      const cap = getModelCapability(resolvedModelId);
      const at = resolvedModelId.lastIndexOf('@');
      const baseModelId = at === -1 ? resolvedModelId : resolvedModelId.slice(0, at);
      if (cap.mechanism === 'none') {
        // Strip any spurious suffix; nothing else to do.
        resolvedModelId = baseModelId;
      }
      // 'variant' mechanism: keep resolvedModelId with its @on suffix —
      // opencode.json has the variant entry registered. System-prompt
      // mechanism was retired 2026-05-11; all thinking models now use variants.
    }
    const modelSpec = resolvedModelId
      ? { providerID: 'ollama', modelID: resolvedModelId }
      : undefined;
    return { modelSpec, systemPrompt };
  }

  setPipeName(name: string) {
    this.pipeName = name;
  }

  setOpenCodeService(svc: OpenCodeService) {
    this.opencodeService = svc;
    // When OpenCode crashes, every local adapter is bound to a dead SDK.
    // Tear them all down and emit session-exit with the child's exit code
    // (non-zero triggers the chat reducer's session-died attentionState
    // via SESSION_PROCESS_EXITED — the existing AttentionBanner surfaces).
    svc.on('crashed', ({ exitCode }) => this.handleOpencodeCrash(exitCode ?? 1));
  }

  private handleOpencodeCrash(exitCode: number): void {
    for (const [desktopId, session] of this.sessions) {
      if (session.info.provider !== 'local') continue;
      this.localAdapters.get(desktopId)?.destroy();
      this.localAdapters.delete(desktopId);
      this.localIdMap.delete(desktopId);
      this.localPendingSends.delete(desktopId);
      this.localSystemPrompts.delete(desktopId);
      session.info.status = 'destroyed';
      this.sessions.delete(desktopId);
      this.emit('session-exit', desktopId, exitCode);
    }
  }

  private emitSyntheticUserMessage(desktopId: string, text: string): void {
    // Tagged with the EXACT text we sent — guarantees content-match dedup
    // against the optimistic USER_PROMPT bubble's pending entry. Bypasses
    // any whitespace normalization OpenCode might apply to its echo.
    // Renderer reads `uuid` and `timestamp` at the TOP level of the event,
    // NOT inside `data` — the dispatch in App.tsx::transcriptHandler does
    // `event.uuid` / `event.timestamp`. If they're under `event.data` the
    // reducer dedup drops the action silently and bubbles never render.
    const ts = Date.now();
    const uuid = `local-u-${ts}-${Math.random().toString(36).slice(2, 8)}`;
    this.emit('transcript-event', {
      type: 'user-message',
      sessionId: desktopId,
      uuid,
      timestamp: ts,
      data: { text },
    });
  }

  createSession(opts: CreateSessionOpts): SessionInfo {
    const id = randomUUID();
    const provider: SessionProvider = opts.provider || 'claude';
    // Resolve CWD: fall back to home directory if empty or nonexistent
    const resolvedCwd = (opts.cwd && fs.existsSync(opts.cwd)) ? opts.cwd : os.homedir();

    // --- LOCAL provider branch ---
    if (provider === 'local') {
      if (!this.opencodeService) throw new Error('OpenCode service not wired');

      // Desktop session id assignment:
      // - RESUME: the renderer hands us the OC session id (it queried
      //   opencodeService.listSessions to populate the resume browser). Use
      //   it as the desktop id; the localIdMap entry is identity.
      // - NEW: the desktop id is a fresh UUID. The OC session id won't be
      //   known until createSession() resolves — set the localIdMap entry
      //   in the .then() block. Sends arriving before that get queued.
      const desktopId = opts.resumeSessionId || id;
      const isResume = !!opts.resumeSessionId;

      const info: SessionInfo = {
        id: desktopId, name: opts.name, cwd: resolvedCwd,
        permissionMode: 'normal', skipPermissions: false,
        status: 'active', createdAt: Date.now(),
        provider: 'local', model: opts.model,
        ...(opts.initialInput !== undefined ? { initialInput: opts.initialInput } : {}),
      };
      this.sessions.set(desktopId, { info, worker: null });   // worker unused for local
      // Capture the user-configured system prompt for this session. Used by
      // sendInput's local branch when assembling the per-message `system`
      // field (and prepending thinking-trigger tokens for binary-thinking
      // models like Gemma 4 — see local-effort-capability).
      if (typeof opts.systemPrompt === 'string' && opts.systemPrompt) {
        this.localSystemPrompts.set(desktopId, opts.systemPrompt);
      }
      this.emit('session-created', info);

      const ensureOcSession = isResume
        ? Promise.resolve({ id: opts.resumeSessionId! })
        : this.opencodeService.createSession({ systemPrompt: opts.systemPrompt });

      ensureOcSession.then((ocSession) => {
        this.localIdMap.set(desktopId, ocSession.id);
        const adapter = new OpenCodeSessionAdapter({
          ocSessionId: ocSession.id,
          desktopSessionId: desktopId,
          service: this.opencodeService!,
          isResume,
        });
        adapter.on('transcript-event', (event) => this.emit('transcript-event', event));
        // Forward session-rename events from OpenCode (auto-generated titles)
        // up to ipc-handlers, which re-broadcasts via broadcastRename. Mirror
        // of the Claude path's `~/.claude/topics/topic-<sid>` watcher — without
        // this, local sessions stay named "Local Session" forever.
        adapter.on('session-renamed', (info) => this.emit('session-renamed', info));
        this.localAdapters.set(desktopId, adapter);

        // Drain any queued sends that arrived during the create race window.
        // Use resolveLocalDispatch so queued sends get the same model + system
        // prompt resolution as live sends — without this, queued sends to
        // binary-thinking models (gemma4) would skip the <|think|> injection
        // and never trigger thinking on the very first message.
        const { modelSpec, systemPrompt } = this.resolveLocalDispatch(desktopId);
        const queued = this.localPendingSends.get(desktopId) ?? [];
        this.localPendingSends.delete(desktopId);
        for (const text of queued) {
          this.emitSyntheticUserMessage(desktopId, text);
          this.opencodeService!.sendMessage(ocSession.id, text, modelSpec, systemPrompt).catch((err) => {
            log('ERROR', 'SessionManager', 'OpenCode sendMessage (queued) failed', { sessionId: desktopId, error: String(err) });
          });
        }
      }).catch((err) => {
        log('ERROR', 'SessionManager', 'Local session start failed', { sessionId: desktopId, error: String(err) });
        this.localPendingSends.delete(desktopId);
        this.emit('session-exit', desktopId, 1);
        this.sessions.delete(desktopId);
      });

      return info;
    }
    // --- end LOCAL branch ---

    // Build CLI args — Gemini CLI has no equivalent for Claude's flags
    const args: string[] = [];
    if (provider === 'claude') {
      if (opts.skipPermissions) {
        args.push('--dangerously-skip-permissions');
      }
      if (opts.resumeSessionId) {
        args.push('--resume', opts.resumeSessionId);
      }
      if (opts.model) {
        args.push('--model', opts.model);
      }
    }
    // Gemini CLI launches with no special args for now

    // Spawn a separate Node.js process for node-pty so it uses Node's
    // native binary instead of Electron's (which requires electron-rebuild).
    // We use spawn with 'node' (system Node) + IPC channel instead of fork()
    // because fork() uses Electron's Node.js which has the same ABI mismatch.
    // In packaged builds, pty-worker.js is unpacked from the asar archive
    // so that system Node.js can access it (node can't read asar files).
    let workerPath = path.join(__dirname, 'pty-worker.js');
    if (app.isPackaged) {
      const unpackedPath = workerPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
      if (fs.existsSync(unpackedPath)) {
        workerPath = unpackedPath;
      } else {
        log('ERROR', 'SessionManager', 'Unpacked worker not found, using asar path', { path: unpackedPath });
      }
    }
    // Always use system Node.js — Electron's binary can't load node-pty.
    // Resolve via which() for Windows where Electron's PATH may differ.
    let nodePath = 'node';
    try { if (whichSync) nodePath = whichSync('node'); } catch { /* use bare 'node' */ }
    const worker = spawn(nodePath, [workerPath], {
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });

    const info: SessionInfo = {
      id,
      name: opts.name,
      cwd: resolvedCwd,
      permissionMode: opts.skipPermissions ? 'bypass' : 'normal',
      skipPermissions: opts.skipPermissions,
      status: 'active',
      createdAt: Date.now(),
      provider,
      model: opts.model,
      // Carry initialInput through so the renderer can prefill the input bar.
      // Omit the key entirely when undefined to keep the object clean.
      ...(opts.initialInput !== undefined ? { initialInput: opts.initialInput } : {}),
    };

    const session: ManagedSession = { info, worker };
    this.sessions.set(id, session);
    this.emit('session-created', info);

    // Handle spawn failure (e.g., node not on PATH) — without this,
    // the unhandled 'error' event would crash the Electron main process.
    worker.on('error', (err) => {
      log('ERROR', 'SessionManager', 'Worker spawn failed', { sessionId: id, error: String(err) });
      if (this.sessions.has(id)) {
        this.sessions.get(id)!.info.status = 'destroyed';
        this.sessions.delete(id);
        this.emit('session-exit', id, 1);
      }
    });

    // Drain stderr so the pipe buffer doesn't fill up and cause backpressure.
    worker.stderr?.on('data', (chunk: Buffer) => {
      log('ERROR', 'SessionManager', 'Worker stderr', { sessionId: id, output: chunk.toString() });
    });

    worker.on('message', (msg: any) => {
      switch (msg.type) {
        case 'data':
          this.emit('pty-output', id, msg.data);
          break;
        case 'exit':
          if (!this.sessions.has(id)) return;
          const exitingSession = this.sessions.get(id)!;
          exitingSession.info.status = 'destroyed';
          this.emit('session-exit', id, msg.exitCode);
          this.sessions.delete(id);
          break;
      }
    });

    worker.on('exit', () => {
      if (!this.sessions.has(id)) return;
      const exitingSession = this.sessions.get(id)!;
      exitingSession.info.status = 'destroyed';
      this.emit('session-exit', id, 0);
      this.sessions.delete(id);
    });

    // Tell the worker to spawn the CLI, passing our session ID
    // so hook events can be correlated back to this session.
    // Wrapped in try/catch because send() throws synchronously if
    // the spawn failed (IPC channel never opened), which happens
    // before the async 'error' event fires.
    try {
      worker.send({
        type: 'spawn',
        command: provider === 'gemini' ? 'gemini' : 'claude',
        args,
        cwd: resolvedCwd,
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        // Claude-specific: session ID + pipe name for hook event correlation
        sessionId: provider === 'claude' ? id : '',
        pipeName: provider === 'claude' ? this.pipeName : '',
      });
    } catch {
      // The 'error' handler above will clean up the session asynchronously.
    }

    return info;
  }

  destroySession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.info.status = 'destroyed';
    this.sessions.delete(id);
    this.emit('session-exit', id, 0);
    if (session.info.provider === 'local') {
      this.localAdapters.get(id)?.destroy();
      this.localAdapters.delete(id);
      const ocId = this.localIdMap.get(id);
      this.localIdMap.delete(id);
      this.localPendingSends.delete(id);
      if (ocId) this.opencodeService?.destroySession(ocId).catch(() => { /* swallow */ });
      return true;
    }
    try {
      session.worker!.send({ type: 'kill' });
      session.worker!.disconnect();
    } catch {
      // Worker IPC already closed (e.g., process crashed or exited)
    }
    return true;
  }

  sendInput(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.info.provider === 'local') {
      if (!this.opencodeService) return false;
      const userText = text.endsWith('\r') ? text.slice(0, -1) : text;
      if (userText === '\x1b') {
        const ocId = this.localIdMap.get(id);
        if (ocId) {
          // Mark the adapter so its next session.idle emits `user-interrupt`
          // instead of `turn-complete` — produces the "Interrupted." footer
          // matching the Claude path. Then issue the actual cancel.
          this.localAdapters.get(id)?.markInterrupted();
          this.opencodeService.cancelSession(ocId).catch(() => { /* swallow */ });
        }
        // No queued cancel for un-mapped sessions — there's nothing to cancel yet.
        return true;
      }
      if (!userText) return true;
      const ocId = this.localIdMap.get(id);
      if (!ocId) {
        // OC session not yet created — queue the text. The .then() in createSession
        // drains the queue with the synthetic user-message + sendMessage.
        const q = this.localPendingSends.get(id) ?? [];
        q.push(userText);
        this.localPendingSends.set(id, q);
        return true;
      }
      this.emitSyntheticUserMessage(id, userText);
      // Single source of truth for model + system-prompt resolution — also
      // used by the queued-sends drain so live and queued behavior match.
      const { modelSpec, systemPrompt } = this.resolveLocalDispatch(id);
      this.opencodeService.sendMessage(ocId, userText, modelSpec, systemPrompt).catch((err) => {
        log('ERROR', 'SessionManager', 'OpenCode sendMessage failed', { sessionId: id, error: String(err) });
      });
      return true;
    }
    try { session.worker!.send({ type: 'input', data: text }); } catch { return false; }
    return true;
  }

  resizeSession(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    if (session.info.provider === 'local') return true;   // no PTY to resize
    try { session.worker!.send({ type: 'resize', cols, rows }); } catch { return false; }
    return true;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.info);
  }

  /**
   * Send `/reload-plugins` to every active session after a short delay.
   * The delay gives Claude Code time to (a) flush its cached plugin state
   * and (b) be ready for input at the prompt. Firing immediately after an
   * install races with both and the reload silently no-ops.
   */
  broadcastReloadPlugins(delayMs: number = 1500): void {
    setTimeout(() => {
      for (const s of this.listSessions()) {
        if (s.status === 'active') this.sendInput(s.id, '/reload-plugins\r');
      }
    }, delayMs);
  }

  getSession(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.destroySession(id);
    }
  }
}
