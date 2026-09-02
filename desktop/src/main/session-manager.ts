import { spawn, ChildProcess } from 'child_process';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';
import { SessionInfo, SessionProvider } from '../shared/types';
import type { ModelBinding } from '../shared/provider-types';
import { EventEmitter } from 'events';
import { log } from './logger';
import { deployClaudeCodeLinkMcp } from './claude-code-mcp';

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
  /** Native-runtime model binding (provider='native' only). Required for a
   *  fresh native session; on resume the binding comes from the stored header. */
  binding?: ModelBinding;
  /** Native-runtime harness preset id (provider='native', fresh create only) —
   *  'assistant' | 'coder'. On resume the preset comes from the stored header.
   *  ipc-handlers threads it into nativeHost.create() and re-stamps the resolved
   *  id back onto the returned SessionInfo. */
  preset?: string;
  /** Optional text to prefill into the input bar after the session is selected.
   *  Forwarded into SessionInfo so the renderer can pick it up on session-created. */
  initialInput?: string;
}

interface ManagedSession {
  info: SessionInfo;
  // Native sessions have NO PTY worker — their turn loop lives in a
  // HarnessSession owned by NativeSessionHost (ipc-handlers wires it up after
  // createSession returns). Every `session.worker.X` access is guarded.
  worker?: ChildProcess;
}

export class SessionManager extends EventEmitter {
  private sessions = new Map<string, ManagedSession>();
  private pipeName: string = '';

  setPipeName(name: string) {
    this.pipeName = name;
  }

  createSession(opts: CreateSessionOpts): SessionInfo {
    const provider: SessionProvider = opts.provider || 'claude';
    // Resolve CWD: fall back to home directory if empty or nonexistent.
    const cwdExists = !!opts.cwd && fs.existsSync(opts.cwd);
    // Diagnostic (2026-07-12): a RESUME whose cwd was provided but doesn't exist
    // means upstream row resolution produced a bad path — silently falling back
    // to $HOME then runs `claude --resume` in the WRONG project (this is exactly
    // how the greedy-slug bug surfaced as "every session resumed from home"). The
    // Resume Browser now gates resume on resolvable rows and the slug walk is
    // fixed, so this should be rare; the warning makes any regression VISIBLE
    // instead of a silent wrong-directory resume. Behavior is unchanged.
    if (!cwdExists && opts.cwd && opts.resumeSessionId) {
      // Persisted breadcrumb (2026-08-12): this was a bare console.warn, which goes
      // only to Electron stdout — invisible in a shipped build. log() lands it in
      // ~/.claude/desktop.log where the next wrong-resume investigation can find it.
      log('WARN', 'SessionManager', 'resume cwd does not exist — falling back to home; resume may open the wrong project', {
        resumeSessionId: opts.resumeSessionId, cwd: opts.cwd,
      });
    }
    const resolvedCwd = cwdExists ? opts.cwd! : os.homedir();

    // Native branch (platform roadmap Phase 1): no PTY worker — the turn loop
    // runs in a HarnessSession that ipc-handlers starts AFTER this returns
    // (SessionManager stays PTY-focused; it does not construct HarnessSession).
    // On resume the id MUST equal the resumed id so the HarnessSession the host
    // rebuilds and the SessionInfo the renderer holds share one identity.
    if (provider === 'native') {
      // Resume reads the binding from the stored session header; a fresh native
      // session must be given one up front.
      if (!opts.resumeSessionId && !opts.binding) {
        throw new Error('SessionManager: a new native session requires a model binding.');
      }
      const nativeId = opts.resumeSessionId || randomUUID();
      const nativeInfo: SessionInfo = {
        id: nativeId,
        name: opts.name,
        cwd: resolvedCwd,
        permissionMode: 'normal',
        skipPermissions: false,
        status: 'active',
        createdAt: Date.now(),
        provider: 'native',
        model: opts.binding?.modelId,
        // Seed the resolved-preset badge on the FIRST push for a fresh create
        // (opts.preset is the user's pick, which equals the resolved id for the
        // two built-ins). ipc-handlers re-stamps the authoritative resolved id
        // after nativeHost.create/resume. On RESUME the id is header-derived and
        // unknown here (left absent). It does NOT reach the live pill via the
        // re-stamp — session:created is sent before create/resume awaits, so the
        // renderer patches the pill from the SESSION_CREATE invoke's RETURN value
        // (App.createSession / handleResumeSession), which carries the re-stamped id.
        ...(opts.preset && !opts.resumeSessionId ? { harnessId: opts.preset } : {}),
        ...(opts.initialInput !== undefined ? { initialInput: opts.initialInput } : {}),
      };
      this.sessions.set(nativeId, { info: nativeInfo });
      this.emit('session-created', nativeInfo);
      return nativeInfo;
    }

    const id = randomUUID();

    // Always use system Node.js — Electron's binary can't load node-pty.
    // Resolve via which() for Windows where Electron's PATH may differ.
    // Resolved HERE, ahead of the args, because the SendUserLink MCP config
    // below names this same interpreter for Claude Code to spawn the server with.
    let nodePath = 'node';
    try { if (whichSync) nodePath = whichSync('node'); } catch { /* use bare 'node' */ }

    // Build Claude CLI args.
    const args: string[] = [];
    if (opts.skipPermissions) {
      args.push('--dangerously-skip-permissions');
    }
    if (opts.resumeSessionId) {
      args.push('--resume', opts.resumeSessionId);
    }
    if (opts.model) {
      args.push('--model', opts.model);
    }
    // Give this session YouCoded's SendUserLink tool (claude-code-mcp.ts) —
    // Claude Code has no link deliverable of its own. Best-effort: if the
    // deploy throws (read-only userData, disk full) the session still starts,
    // just without the link tool. Pushing a --mcp-config path that does not
    // exist would instead be a hard startup failure for the whole session.
    try {
      args.push(...deployClaudeCodeLinkMcp(app.getPath('userData'), nodePath).args);
    } catch (err) {
      log('WARN', 'SessionManager', 'SendUserLink MCP deploy failed — this session starts without the link tool', { error: String(err) });
    }

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
        command: 'claude',
        args,
        cwd: resolvedCwd,
        cols: opts.cols || 80,
        rows: opts.rows || 24,
        // Session ID + pipe name for hook event correlation
        sessionId: id,
        pipeName: this.pipeName,
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
    // Uniform teardown: native sessions (no worker) still emit session-exit so
    // downstream cleanup (window release, remote broadcast) runs identically.
    this.emit('session-exit', id, 0);
    if (session.worker) {
      try {
        session.worker.send({ type: 'kill' });
        session.worker.disconnect();
      } catch {
        // Worker IPC already closed (e.g., process crashed or exited)
      }
    }
    return true;
  }

  sendInput(id: string, text: string): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.worker) return false; // native sessions have no PTY
    try { session.worker.send({ type: 'input', data: text }); } catch { return false; }
    return true;
  }

  resizeSession(id: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(id);
    if (!session || !session.worker) return false; // native sessions have no PTY
    try { session.worker.send({ type: 'resize', cols, rows }); } catch { return false; }
    return true;
  }

  listSessions(): SessionInfo[] {
    return Array.from(this.sessions.values()).map(s => s.info);
  }

  // Optional per-session hold for broadcastReloadPlugins. Wired to
  // HookRelay.hasPendingPermission in main.ts: while a permission /
  // AskUserQuestion request is pending, the session's TUI shows a live Ink
  // select menu, and typing "/reload-plugins\r" into it would press Enter on
  // the highlighted option — silently answering the prompt (2026-07-09
  // stray-Enter fix). Returns true when the session must NOT receive input.
  private reloadPluginsGate: ((sessionId: string) => boolean) | null = null;

  setReloadPluginsGate(gate: (sessionId: string) => boolean): void {
    this.reloadPluginsGate = gate;
  }

  private static readonly RELOAD_RETRY_MS = 5000;
  private static readonly RELOAD_MAX_RETRIES = 24; // ~2 minutes of deferral

  /**
   * Send `/reload-plugins` to every active session after a short delay.
   * The delay gives Claude Code time to (a) flush its cached plugin state
   * and (b) be ready for input at the prompt. Firing immediately after an
   * install races with both and the reload silently no-ops.
   *
   * Sessions the gate reports blocked are retried every RELOAD_RETRY_MS for
   * up to RELOAD_MAX_RETRIES (so the reload still lands once the user answers
   * the prompt), then dropped — a missed reload is recoverable (next install
   * or a manual /reload-plugins), an auto-answered prompt is not.
   */
  broadcastReloadPlugins(delayMs: number = 1500): void {
    setTimeout(() => {
      for (const s of this.listSessions()) {
        if (s.status === 'active') this.sendReloadWhenClear(s.id, 0);
      }
    }, delayMs);
  }

  private sendReloadWhenClear(id: string, attempt: number): void {
    const session = this.sessions.get(id);
    if (!session || session.info.status !== 'active') return;
    if (this.reloadPluginsGate?.(id)) {
      if (attempt >= SessionManager.RELOAD_MAX_RETRIES) return;
      setTimeout(
        () => this.sendReloadWhenClear(id, attempt + 1),
        SessionManager.RELOAD_RETRY_MS,
      );
      return;
    }
    this.sendInput(id, '/reload-plugins\r');
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
