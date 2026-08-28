// EngineSupervisor — llama-server lifecycle (spec §3.2, ADR 007). Direct heir
// of the archived feat/opencode-mvp OpenCodeService supervision pattern.
//
// Router mode: spawned WITHOUT -m; the server discovers GGUFs in --models-dir,
// hot-loads on first request, LRU-evicts (--models-max), and isolates each model
// in its own child process. We only ever talk HTTP to it.
// Discovery is BOOT-TIME ONLY — the router never re-scans --models-dir on its
// own (no timer, no inotify, no rescan on a plain GET /models). A file that
// lands after boot 400s until refreshModels() asks for one. See "router rescan"
// below; the discovery dir is --models-dir, NOT LLAMA_CACHE (vestigial).
//
// Idle shutdown: the AI SDK is handed trackedFetch, so every chat request
// passes through here — each call bumps lastActivity and holds an inFlight
// count until its response BODY is fully read (streams count as active for
// their whole duration; a 10-minute generation must not be killed mid-stream).
import { spawn, ChildProcess, execFileSync } from 'child_process';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import type { EngineModel, EngineModelState, EngineRunState } from '../../shared/engine-types';
import { scanGgufCache } from './cache-scan';
import { isFollowerPart } from '../../shared/gguf-split';

export interface EngineSupervisorOpts {
  binaryPath: string;
  port: number;
  cacheDir: string;          // exported to the child as LLAMA_CACHE
  contextSize: number;       // -c; inherited by every model instance the router spawns
  env?: NodeJS.ProcessEnv;   // test override
  fetchImpl?: typeof fetch;  // test override
  readyDeadlineMs?: number;  // default 30_000 — first Vulkan init can be slow
  readyPollMs?: number;      // default 250
  idleMs?: number;           // default 10 min (spec §3.2)
  idleCheckMs?: number;      // default 60s
  sleepIdleSeconds?: number; // per-model auto-sleep; default 300 (5 min)
  modelPollMs?: number;      // /models state poll cadence when idle; default 1500
  modelPollLoadingMs?: number; // faster cadence while a model is loading; default 400
  /** Test seam: resolve the PID listening on `port` (Linux). Default: ss + /proc scan. */
  pidOnPort?: (port: number) => number | null;
  /** Test seam: resolve a PID's executable path (for the stale-engine reaper).
   *  Default: readlink /proc/<pid>/exe. */
  exeForPid?: (pid: number) => string | null;
}

// Keep at most 2 models resident: the router's LRU default (4) can overcommit
// RAM on consumer machines (two 8GB models already hurt); 2 still makes
// switching between a chat and a utility model free. Recorded in
// docs/engine-dependencies.md.
const MODELS_MAX = 2;
// Per-model idle sleep: the router frees an idle model's memory after this many
// seconds (status → 'sleeping'); the next request wakes it. 5 min per product
// decision 2026-07-14. This is FINER-grained than the engine-wide idle stop
// (idleMs, 10 min) which tears down the whole process. Verified b9992.
const SLEEP_IDLE_SECONDS = 300;
// Crash strike-out (spec §3.2): 3 crashes within 5 minutes → error state,
// stop retrying until the user acts (EngineCard's Restart button).
const STRIKE_LIMIT = 3;
const STRIKE_WINDOW_MS = 5 * 60_000;

/** Resolve the PID of the process listening on a localhost port, cross-platform:
 *  Linux `ss` (+ /proc fallback), macOS `lsof`, Windows `netstat`. Returns null
 *  when the tool is missing/unparseable or no listener is found — callers treat
 *  null as "unknown", never "safe", so a non-answer never blocks startup. */
function defaultPidOnPort(port: number): number | null {
  switch (process.platform) {
    case 'linux': {
      try {
        const out = execFileSync('ss', ['-ltnp'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        const pid = parseSsListenerPid(out, port);
        if (pid != null) return pid;
      } catch { /* ss missing/failed — fall through to the /proc scan */ }
      return pidOnPortViaProc(port);
    }
    case 'darwin': {
      // -nP: no DNS/port-name lookups (fast); -sTCP:LISTEN: listeners only; -F p: PID-only output.
      const out = runTool('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-F', 'p']);
      return out ? parseLsofPid(out) : null;
    }
    case 'win32': {
      const out = runTool('netstat', ['-ano', '-p', 'tcp']);
      return out ? parseNetstatListenerPid(out, port) : null;
    }
    default:
      return null;
  }
}

function runTool(file: string, args: string[]): string | null {
  try {
    return execFileSync(file, args, { encoding: 'utf8', timeout: 4000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // tool missing, non-zero exit, or timeout — all non-fatal (unknown).
  }
}

// ---- pure parsers (unit-tested; no shell in tests) ----

/** Linux `ss -ltnp` → PID of the process listening on `port`. Port match is exact
 *  (`:9920` must not match a `:992` query) and anchored to the LOCAL address column
 *  so a foreign/peer address can't false-match. */
export function parseSsListenerPid(stdout: string, port: number): number | null {
  for (const line of stdout.split('\n')) {
    if (!line.includes('LISTEN')) continue;
    const cols = line.trim().split(/\s+/);
    // ss -ltnp columns: State Recv-Q Send-Q Local:Port Peer:Port Process
    const local = cols[3] ?? '';
    const m = local.match(/:(\d+)$/);
    if (m && parseInt(m[1], 10) === port) {
      const p = /pid=(\d+)/.exec(line);
      if (p) return parseInt(p[1], 10);
    }
  }
  return null;
}

/** macOS `lsof -F p` output → PID. With `-F p`, PID lines are `p<pid>`. */
export function parseLsofPid(stdout: string): number | null {
  const line = stdout.split('\n').find((l) => /^p\d+$/.test(l.trim()));
  return line ? parseInt(line.trim().slice(1), 10) : null;
}

/** Windows `netstat -ano -p tcp` → PID of the LISTENING socket on `port`.
 *  Row shape: `  TCP    127.0.0.1:9920    0.0.0.0:0    LISTENING    12345`. */
export function parseNetstatListenerPid(stdout: string, port: number): number | null {
  for (const line of stdout.split('\n')) {
    if (!/LISTENING/i.test(line)) continue;
    const cols = line.trim().split(/\s+/);
    // cols: [TCP, local, foreign, state, pid]
    if (cols.length >= 5 && cols[1]?.endsWith(`:${port}`)) {
      const pid = parseInt(cols[cols.length - 1], 10);
      if (Number.isFinite(pid)) return pid;
    }
  }
  return null;
}

/** Linux /proc-only port→PID: find the socket inode for the LISTEN port in
 *  /proc/net/tcp(6), then the process whose fd links to that inode. */
function pidOnPortViaProc(port: number): number | null {
  const hex = ':' + port.toString(16).toUpperCase().padStart(4, '0');
  const inode = listenInodeForPort(hex);
  if (!inode) return null;
  let pids: string[];
  try { pids = fs.readdirSync('/proc'); } catch { return null; }
  for (const pid of pids) {
    if (!/^\d+$/.test(pid)) continue;
    let fds: string[];
    try { fds = fs.readdirSync(`/proc/${pid}/fd`); } catch { continue; } // perms / raced exit
    for (const fd of fds) {
      try {
        if (fs.readlinkSync(`/proc/${pid}/fd/${fd}`) === `socket:[${inode}]`) return parseInt(pid, 10);
      } catch { /* raced fd close */ }
    }
  }
  return null;
}

function listenInodeForPort(hexPort: string): string | null {
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    let lines: string[];
    try { lines = fs.readFileSync(f, 'utf8').split('\n'); } catch { continue; }
    for (const line of lines.slice(1)) {
      const cols = line.trim().split(/\s+/);
      // cols[1]=local_address (hexIP:hexPort), cols[3]=state ('0A' = LISTEN), cols[9]=inode
      if (cols.length > 9 && cols[1]?.endsWith(hexPort) && cols[3] === '0A') return cols[9];
    }
  }
  return null;
}

/** Resolve a PID's executable path / image name, cross-platform — used by the
 *  stale-engine reaper to confirm the squatter is actually llama-server before
 *  killing it. Returns null when undeterminable — callers treat null as
 *  "unknown", never "safe", so an unconfirmable process is never killed. */
function defaultExeForPid(pid: number): string | null {
  switch (process.platform) {
    case 'linux':
      try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return null; }
    case 'darwin': {
      const out = runTool('ps', ['-p', String(pid), '-o', 'comm=']);
      const name = out?.split('\n')[0]?.trim();
      return name || null;
    }
    case 'win32': {
      // Image name only (llama-server.exe) — enough to confirm it's our engine.
      const out = runTool('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
      const m = out && /^"([^"]+)"/.exec(out.trim());
      return m ? m[1] : null;
    }
    default:
      return null;
  }
}

export class EngineSupervisor extends EventEmitter {
  private child: ChildProcess | null = null;
  private state: EngineRunState = 'stopped';
  private startPromise: Promise<string> | null = null; // single-flight ensureRunning
  private stopPromise: Promise<void> | null = null;    // single-flight stop (idle/restart)
  private crashTimes: number[] = [];
  private inFlight = 0;
  private lastActivity = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private intentionalShutdown = false;
  private modelPollTimer: NodeJS.Timeout | null = null; // per-model /models state poll
  private lastModelSig = '';                             // last emitted (id→state) signature
  private loadProgress = new Map<string, number>();      // modelId → max resident bytes seen while loading (monotonic)

  constructor(private readonly opts: EngineSupervisorOpts) { super(); }

  status(): EngineRunState { return this.state; }

  /** OpenAI-compatible base URL (…/v1) while running, else null. The /v1
   *  suffix is deliberate: createOpenAICompatible appends /chat/completions,
   *  and llama-server serves both /v1/models and /v1/chat/completions there. */
  baseUrl(): string | null {
    return this.state === 'running' ? `http://127.0.0.1:${this.opts.port}/v1` : null;
  }

  /** Root URL for llama-server management endpoints (/health, /models). */
  private rootUrl(): string { return `http://127.0.0.1:${this.opts.port}`; }

  resetStrikes(): void {
    this.crashTimes = [];
    if (this.state === 'error') this.state = 'stopped';
    this.emit('status-changed');
  }

  /** Start if needed; resolve with the OpenAI-compatible base URL. Single-
   *  flight: concurrent callers share one spawn. Throws plain language — the
   *  messages surface in the chat error banner via the registry. */
  ensureRunning(): Promise<string> {
    // A stop is in flight (idle shutdown or restart). The dying child still
    // holds the port for up to ~2s, and its state is briefly still 'running' —
    // so we must NOT hand back that stale baseUrl (the AI SDK would hit a
    // server being killed → ECONNREFUSED mid-turn) NOR spawn a second server
    // on the same port. Wait for the stop to finish, then (re)start cleanly.
    if (this.stopPromise) {
      return this.stopPromise.then(() => this.ensureRunning());
    }
    if (this.state === 'running') {
      this.touch();
      return Promise.resolve(this.baseUrl()!);
    }
    if (this.state === 'error') {
      return Promise.reject(new Error(
        'The local engine keeps crashing — open Settings → Providers and press "Restart engine".'
      ));
    }
    if (!this.startPromise) {
      this.startPromise = this.start().finally(() => { this.startPromise = null; });
    }
    return this.startPromise;
  }

  private async start(): Promise<string> {
    this.intentionalShutdown = false;
    this.state = 'starting';
    this.emit('status-changed');
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const readyDeadlineMs = this.opts.readyDeadlineMs ?? 30_000;
    const readyPollMs = this.opts.readyPollMs ?? 250;

    // Fix: llama-server's router mode treats a MISSING --models-dir as a fatal
    // error and exits during startup. The cache dir is only created lazily when
    // the first model downloads (model-downloader.ts), so a fresh install's
    // verify-boot — which runs BEFORE any model exists — always spawned the
    // engine against a nonexistent dir and it died instantly. Create it here so
    // the engine can always boot (an empty router is valid — it just serves no
    // models yet). A genuine mkdir failure (permissions, path is a file) is
    // surfaced specifically rather than misattributed to a bad build below.
    try {
      fs.mkdirSync(this.opts.cacheDir, { recursive: true });
    } catch (err) {
      this.state = 'stopped';
      this.emit('status-changed');
      throw new Error(
        `The local engine's model folder could not be created at ${this.opts.cacheDir}: ${(err as Error).message}`
      );
    }

    // Reap a stale orphan squatting on our fixed port BEFORE we spawn (2026-07-20).
    // Without a single-instance lock, a previous run's llama-server can outlive the app
    // (the old quit path lost the SIGTERM race) and keep the port bound. Our child then
    // can't bind, and — before the identity guard above — we'd have adopted the orphan.
    // If the listener is a llama-server that is NOT our live child, kill it so this
    // spawn gets the port. Where the port→PID tool is unavailable the reaper is a
    // no-op and the conflict simply surfaces as the child's startup exit (unchanged).
    this.reapStaleEngineOnPort();

    const child = spawn(
      this.opts.binaryPath,
      [
        '--host', '127.0.0.1', '--port', String(this.opts.port),
        '--no-webui',
        // --jinja from day one: Phase 2 tool calling requires it, and keeping
        // the spawn shape constant means Phase 2 changes no process contract.
        '--jinja',
        // --models-dir is what makes the router DISCOVER our dropped GGUFs and
        // auto-load them by filename id (verified b9992). LLAMA_CACHE alone does
        // NOT — it only tracks -hf auto-downloads (Plan C), so without this the
        // router serves ZERO models and every send 400s. Points at the same
        // cache dir so a dropped GGUF and an -hf pull live side by side.
        '--models-dir', this.opts.cacheDir,
        '--models-max', String(MODELS_MAX),
        // Per-model auto-sleep: the router frees an idle model's memory after N
        // seconds and wakes it on the next request. Keeps residency proportional
        // to use without tearing down the whole engine. See engine-dependencies.md.
        '--sleep-idle-seconds', String(this.opts.sleepIdleSeconds ?? SLEEP_IDLE_SECONDS),
        '-c', String(this.opts.contextSize),
      ],
      {
        // --models-dir above is what serves the GGUFs (both hand-placed and
        // Plan C's flat HTTP downloads). LLAMA_CACHE only matters for
        // llama-server's own -hf auto-download path, which nothing uses yet —
        // it's effectively vestigial (kept harmlessly). See engine-dependencies.md.
        env: { ...process.env, ...(this.opts.env ?? {}), LLAMA_CACHE: this.opts.cacheDir },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    this.child = child;

    // Capture the child's output so a startup failure surfaces the REAL reason
    // (e.g. "'…/.cache/llama.cpp' does not exist or is not a directory") instead
    // of a generic guess. Kept to a bounded tail — llama-server is chatty. Also
    // DRAINS both pipes: an unread stdio: 'pipe' can back-pressure and stall the
    // child once its OS pipe buffer fills. See docs/error-message-standards.md.
    const MAX_OUTPUT_TAIL = 4000;
    let outputTail = '';
    const collect = (buf: Buffer) => {
      outputTail = (outputTail + buf.toString('utf8')).slice(-MAX_OUTPUT_TAIL);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);

    let exitedDuringStartup = false;
    const startupExitListener = () => { exitedDuringStartup = true; };
    child.once('exit', startupExitListener);

    const deadline = Date.now() + readyDeadlineMs;
    while (Date.now() < deadline && !exitedDuringStartup) {
      try {
        const res = await fetchImpl(`${this.rootUrl()}/health`, { method: 'GET' });
        // Identity guard (2026-07-20): /health answering "ok" is NOT proof that the
        // server we just spawned is the one listening. An orphaned llama-server from
        // a previous run keeps our fixed port bound, so our child fails to bind and
        // dies while the ORPHAN answers /health. Without this guard we would adopt
        // the orphan — and later count ITS death as OUR crash (the false "engine
        // crashed repeatedly" strike-out). Only accept when the listener is our child
        // (or identity can't be determined on this platform — fall through as before).
        if (res.ok && this.isOurChildOnPort(child)) {
          this.state = 'running';
          this.touch();
          child.off('exit', startupExitListener);
          child.on('exit', (code) => this.onExit(code));
          this.armIdleTimer();
          this.startModelPoll();
          this.emit('status-changed');
          return this.baseUrl()!;
        }
      } catch { /* not reachable yet — keep polling */ }
      await new Promise((r) => setTimeout(r, readyPollMs));
    }

    child.kill();
    this.child = null;
    this.state = 'stopped';
    this.emit('status-changed');
    if (exitedDuringStartup) {
      // Surface the child's own last output — it names the actual cause. Only
      // fall back to a general (non-committal, non-guessing) message when the
      // child died silently. See docs/error-message-standards.md.
      const detail = outputTail.trim();
      throw new Error(
        detail
          ? `The local engine exited during startup. Engine output:\n${detail}`
          : 'The local engine exited during startup without any output.'
      );
    }
    throw new Error(`The local engine did not start within ${Math.round(readyDeadlineMs / 1000)} seconds.`);
  }

  /** Is the process listening on our port the child we just spawned? Returns
   *  true when identity can't be determined (the platform's port→PID tool is
   *  missing/unparseable) so we never regress a platform we can't inspect — the
   *  guard only ever REJECTS a confidently-foreign listener; it never blocks an
   *  unknown one. This is what stops us adopting an orphaned engine on our port. */
  private isOurChildOnPort(child: ChildProcess): boolean {
    if (child.pid == null) return true;            // not assigned yet — can't disprove
    const pid = (this.opts.pidOnPort ?? defaultPidOnPort)(this.opts.port);
    if (pid == null) return true;                  // unknown — don't block on a non-answer
    return pid === child.pid;
  }

  /** Kill a llama-server squatting on our port that is NOT our live child (a stale
   *  orphan from a previous run). Best-effort; never throws, and never touches our
   *  own child or a process we can't confirm is llama-server. Runs before spawn so
   *  this instance can actually bind the fixed port instead of adopting the orphan. */
  private reapStaleEngineOnPort(): void {
    const pid = (this.opts.pidOnPort ?? defaultPidOnPort)(this.opts.port);
    if (pid == null) return;                       // nothing (identifiably) on the port
    if (this.child && this.child.pid === pid) return; // our own live child — leave it
    const exe = (this.opts.exeForPid ?? defaultExeForPid)(pid);
    if (exe == null || !exe.includes('llama-server')) return; // not confirmably our engine — never kill it
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone / not ours to kill */ }
  }

  private onExit(code: number | null): void {
    const wasRunning = this.state === 'running';
    this.child = null;
    this.disarmIdleTimer();
    this.stopModelPoll();
    if (this.intentionalShutdown) { this.state = 'stopped'; this.emit('status-changed'); return; }
    if (!wasRunning) return;
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < STRIKE_WINDOW_MS);
    this.crashTimes.push(now);
    // Strike-out guards against a crash-respawn loop (bad build, broken GGUF):
    // past the limit the state is 'error' and ensureRunning refuses until the
    // user presses Restart. Below the limit, restart is LAZY — the next send's
    // ensureRunning respawns (no eager respawn: nothing may need the engine).
    this.state = this.crashTimes.length >= STRIKE_LIMIT ? 'error' : 'stopped';
    this.emit('status-changed');
    this.emit('crashed', { exitCode: code });
  }

  /** Single-flight: concurrent callers (idle timer + restart + app-quit) share
   *  ONE teardown. ensureRunning() awaits this.stopPromise so no one restarts
   *  the engine while the old child is still releasing the port. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = this._stop().finally(() => { this.stopPromise = null; });
    return this.stopPromise;
  }

  private async _stop(): Promise<void> {
    this.disarmIdleTimer();
    this.stopModelPoll();
    if (!this.child) {
      if (this.state !== 'error') this.state = 'stopped';
      return;
    }
    this.intentionalShutdown = true;
    const child = this.child;
    // Escalating kill (2026-07-20): a single SIGTERM is why engines leaked past app
    // quit — llama-server can ignore/stall on TERM (mid-write, stuck in a CUDA/Vulkan
    // call), the 2s timer fired, app.quit() won the race, and the orphaned server kept
    // our port bound for the NEXT instance to wrongly adopt. TERM → wait → KILL the
    // survivor, then wait for the exit that KILL guarantees. Still bounded so a
    // wedged child can't hang quit: total worst case ~3s.
    child.kill('SIGTERM');
    const exited = await this.waitForExit(child, 1_500);
    if (!exited) {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      await this.waitForExit(child, 1_500);
    }
    this.child = null;
    this.state = 'stopped';
    this.emit('status-changed');
  }

  /** Resolve true if `child` exits within `ms`, false on timeout (timer unref'd so
   *  it can't hold the process open). */
  private waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (exited: boolean) => { if (!done) { done = true; clearTimeout(timer); resolve(exited); } };
      child.once('exit', () => finish(true));
      const timer = setTimeout(() => finish(false), ms);
      timer.unref?.();
    });
  }

  // ---- idle accounting -------------------------------------------------

  private touch(): void { this.lastActivity = Date.now(); }

  private armIdleTimer(): void {
    this.disarmIdleTimer();
    const idleMs = this.opts.idleMs ?? 10 * 60_000;
    const checkMs = this.opts.idleCheckMs ?? 60_000;
    this.idleTimer = setInterval(() => {
      if (this.state !== 'running') return;
      if (this.inFlight > 0) return; // a stream is still being read — never stop mid-turn
      if (Date.now() - this.lastActivity < idleMs) return;
      // Idle shutdown is transparent: the next send's ensureRunning restarts
      // the engine (first token just arrives slower) — spec §3.2.
      void this.stop();
    }, checkMs);
    this.idleTimer.unref?.();
  }

  private disarmIdleTimer(): void {
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = null; }
  }

  /** The fetch handed to createOpenAICompatible for the local provider. Holds
   *  inFlight until the response body is FULLY read (or errored/cancelled) and
   *  touches lastActivity per chunk, so idle shutdown can never cut a stream. */
  trackedFetch: typeof fetch = async (input: any, init?: any) => {
    this.touch();
    this.inFlight++;
    let res: Response;
    try {
      res = await (this.opts.fetchImpl ?? fetch)(input, init);
    } catch (e) {
      this.inFlight--; this.touch();
      throw e;
    }
    if (!res.body) { this.inFlight--; this.touch(); return res; }
    let released = false;
    const release = () => {
      if (!released) { released = true; this.inFlight--; this.touch(); }
    };
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const self = this;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { release(); controller.close(); return; }
          self.touch(); // streaming progress counts as activity
          controller.enqueue(value);
        } catch (e) {
          release();
          controller.error(e);
        }
      },
      cancel(reason) {
        release(); // interrupt/abort paths must not leak the inFlight hold
        return reader.cancel(reason);
      },
    });
    return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
  };

  // ---- model listing ----------------------------------------------------

  /** Running → GET /models (live status) UNIONED with a fresh disk scan, so a
   *  model downloaded after boot is LISTED without a restart (Amendment K2);
   *  stopped → cache scan alone (loaded:false).
   *  **Listed is not servable** — a row this union adds is a selectable model the
   *  router has never heard of, and a completion naming it 400s. Serveability is
   *  `ensureServable()`; never treat a row from here as usable on its own.
   *  Upstream /models schema is a tracked coupling — parse DEFENSIVELY, and
   *  keep the exact observed shape pinned in test-engine/probe-models.mjs +
   *  docs/engine-dependencies.md. */
  async listModels(): Promise<EngineModel[]> {
    if (this.state !== 'running') return scanGgufCache(this.opts.cacheDir);
    try {
      const res = await (this.opts.fetchImpl ?? fetch)(`${this.rootUrl()}/models`, { method: 'GET' });
      if (!res.ok) return scanGgufCache(this.opts.cacheDir);
      const payload: any = await res.json();
      const rows: any[] = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.models) ? payload.models
        : Array.isArray(payload) ? payload : [];
      // /models rows carry no size — the cache scan does, so index sizes by id
      // and merge them in (the UI's loading banner shows the model size).
      const scanned = scanGgufCache(this.opts.cacheDir);
      const sizeById = new Map<string, number | null>();
      for (const m of scanned) sizeById.set(m.id, m.sizeBytes);
      const out: EngineModel[] = [];
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : null;
        if (!id) continue; // skip malformed
        // A split GGUF is ONE model, but --models-dir lists one row per FILE.
        // Parts 2..N carry weights with no architecture header, so selecting one
        // can only ever 500 — drop them here, the single place router rows enter
        // the app (scanGgufCache already groups them on the engine-off path).
        if (isFollowerPart(id)) continue;
        // b9992's /models reports status as an OBJECT ({value:'loaded'|'unloaded'
        // |'loading'|'sleeping'}), NOT a bare string. Handle both so a schema
        // shift either way still reads.
        const statusValue = typeof row?.status === 'object' && row?.status
          ? row.status.value : row?.status;
        const state = mapModelState(statusValue);
        out.push({
          id,
          sizeBytes: typeof row?.size === 'number' ? row.size
            : (sizeById.has(id) ? sizeById.get(id)! : null),
          loaded: state === 'loaded',
          state,
        });
      }
      // Amendment K2: the router discovers GGUFs at BOOT, so union in the fresh
      // disk scan — a just-downloaded model is then LISTED (new-session picker via
      // catalogModels, memory guard via liveModels). Router rows win: they carry
      // live residency state; disk-only rows are 'unloaded' by definition.
      // LISTED IS NOT SERVABLE. A row this union added is a fully selectable model
      // the router has never heard of, and a completion naming it 400s with
      // `model 'X' not found` (measured 2026-08-16, after that reached a user).
      // Serveability is ensureServable()'s job, below — do not read this union as
      // making a post-boot download usable. It only makes it visible.
      const routerIds = new Set(out.map((m) => m.id));
      for (const m of scanned) {
        if (!routerIds.has(m.id)) out.push(m);
      }
      return out;
    } catch {
      return scanGgufCache(this.opts.cacheDir); // engine died mid-call — degrade to scan
    }
  }

  // ---- router rescan ----------------------------------------------------
  //
  // The router discovers GGUFs when it BOOTS and never looks again on its own:
  // upstream gates the rescan behind a `need_reload` dirty flag that is set ONLY
  // when a download the ROUTER itself started finishes. Our downloads are
  // app-side, so it is never set for us — a file we drop into --models-dir is
  // invisible to the router until we ask. There is no timer, no inotify, no
  // SIGHUP, and a plain GET /models does NOT rescan.
  //
  // Asking is `GET /models?reload=1` (any non-empty value). Verified 2026-08-16
  // two ways — disassembly of the shipped libllama-server-impl.so (b9992) and
  // upstream tools/server/server-models.cpp at the b9992 tag — after a real send
  // 400'd on a model that had been on disk for half an hour. NOTE the upstream
  // README also says "The server must be restarted after adding a new model";
  // that line is stale, contradicted by its own ?reload=1 note 150 lines later.

  /** Single-flight guard: N sessions picking the same fresh model must cause ONE
   *  rescan, not N. Cleared as soon as the in-flight scan resolves. */
  private refreshPromise: Promise<Set<string> | null> | null = null;

  /** Router-known model ids. `reload` re-scans --models-dir first. Returns null
   *  when the router can't be reached or its payload doesn't parse — a null is
   *  "don't know", NEVER "empty", because callers gate sends on this. */
  private async routerModelIds(reload: boolean): Promise<Set<string> | null> {
    if (this.state !== 'running') return null;
    try {
      const url = `${this.rootUrl()}/models${reload ? '?reload=1' : ''}`;
      const res = await (this.opts.fetchImpl ?? fetch)(url, { method: 'GET' });
      if (!res.ok) return null;
      const payload: any = await res.json();
      const rows: any[] = Array.isArray(payload?.data) ? payload.data
        : Array.isArray(payload?.models) ? payload.models
        : Array.isArray(payload) ? payload : [];
      const ids = new Set<string>();
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : null;
        if (id) ids.add(id);
      }
      return ids;
    } catch {
      return null;
    }
  }

  /** Make the running router re-scan --models-dir. Call after a download lands or
   *  a model is deleted — NEVER from the poll: a rescan is a WRITE. Upstream's
   *  load_models() unloads a running model whose source changed or vanished, so on
   *  a 1.5s cadence this would be a reconciliation pass every tick, forever.
   *  Pinned by "the background model poll NEVER sends reload=1". */
  async refreshModels(): Promise<void> {
    if (this.state !== 'running') return; // the next boot scans the dir anyway
    await this.rescanOnce();
    void this.emitModelsIfChanged(); // let the UI see the new row promptly
  }

  private rescanOnce(): Promise<Set<string> | null> {
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = this.routerModelIds(true)
      .finally(() => { this.refreshPromise = null; });
    return this.refreshPromise;
  }

  /** True when the router can actually SERVE `modelId` right now — the gap K2's
   *  listing union leaves open, since that union makes a disk-only model a fully
   *  selectable row the router has never heard of. Rescans once if the model is
   *  missing, then re-checks.
   *
   *  FAILS OPEN (returns true) when the engine is stopped or the router can't
   *  answer: a probe that doesn't know must not be the thing that blocks a send
   *  the engine would have served fine. A false is therefore a real, positive
   *  "the router listed its models and yours was not among them". */
  async ensureServable(modelId: string): Promise<boolean> {
    if (this.state !== 'running') return true; // a fresh boot scans the dir
    const known = await this.routerModelIds(false);
    if (known === null) return true;           // unreachable → don't block
    if (known.has(modelId)) return true;
    const rescanned = await this.rescanOnce();
    if (rescanned === null) return true;
    return rescanned.has(modelId);
  }

  // ---- per-model state polling (drives the UI's load/sleep/unload signals) --

  /** Poll GET /models while running and emit 'models-changed' when the set of
   *  (id → state → loadedBytes) changes. llama-server has no push channel, so a
   *  cheap localhost poll is how the renderer learns a model slept/loaded/was
   *  evicted — and, while a model is LOADING, tracks its resident bytes for the
   *  "N GB / M GB" progress bar. Adaptive cadence: fast while anything is loading
   *  (smooth progress), slow otherwise (near-zero idle cost). Unref'd; started on
   *  ready, stopped on teardown. */
  private startModelPoll(): void {
    this.stopModelPoll();
    const schedule = () => {
      // Fast while a load is in flight (loadProgress tracks loading ids), else lazy.
      const loading = this.loadProgress.size > 0;
      const delay = loading ? (this.opts.modelPollLoadingMs ?? 400) : (this.opts.modelPollMs ?? 1500);
      this.modelPollTimer = setTimeout(() => {
        void this.emitModelsIfChanged().finally(() => {
          if (this.state === 'running') schedule();
        });
      }, delay);
      this.modelPollTimer.unref?.();
    };
    void this.emitModelsIfChanged().finally(() => { if (this.state === 'running') schedule(); });
  }

  private stopModelPoll(): void {
    if (this.modelPollTimer) { clearTimeout(this.modelPollTimer); this.modelPollTimer = null; }
    this.lastModelSig = '';
    this.loadProgress.clear();
  }

  /** Compute the live model set (with load progress) and emit if it changed. */
  private async emitModelsIfChanged(): Promise<void> {
    if (this.state !== 'running') return;
    let models: EngineModel[];
    try { models = await this.listModels(); } catch { return; }
    for (const m of models) {
      if (m.state === 'loading') {
        // Resident bytes of the model's child process, monotonic (Vulkan drops
        // RSS once weights move to VRAM, so hold the max seen this load).
        const rss = this.residentBytesForModel(m.id) ?? 0;
        const maxRss = Math.max(this.loadProgress.get(m.id) ?? 0, rss);
        this.loadProgress.set(m.id, maxRss);
        if (maxRss > 0) m.loadedBytes = m.sizeBytes ? Math.min(maxRss, m.sizeBytes) : maxRss;
      } else {
        this.loadProgress.delete(m.id); // load finished / not loading → drop tracker
      }
    }
    const sig = models.map((m) => `${m.id}:${m.state}:${m.loadedBytes ?? ''}`).sort().join('|');
    if (sig !== this.lastModelSig) { this.lastModelSig = sig; this.emit('models-changed', models); }
  }

  /** Resident bytes of the router's child process serving `modelId` (its VmRSS,
   *  which climbs toward the file size as the GGUF is read into RAM). Linux only
   *  (reads /proc); undefined elsewhere → the UI falls back to an elapsed-only,
   *  indeterminate bar. The child's cmdline carries `--model …/<id>.gguf`, which
   *  the router process (with `--models-dir`) does not, so the needle is unique. */
  private residentBytesForModel(modelId: string): number | undefined {
    if (process.platform !== 'linux') return undefined;
    const needle = `/${modelId}.gguf`;
    let pids: string[];
    try { pids = fs.readdirSync('/proc'); } catch { return undefined; }
    for (const pid of pids) {
      if (!/^\d+$/.test(pid)) continue;
      let cmd: string;
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; } // NUL-separated
      if (!cmd.includes('--model') || !cmd.includes(needle)) continue;
      try {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        const m = /VmRSS:\s+(\d+)\s+kB/.exec(status);
        if (m) return parseInt(m[1], 10) * 1024;
      } catch { /* raced exit */ }
    }
    return undefined;
  }

  /** Best-effort per-model unload (frees its memory now). Used when the last
   *  session bound to a model goes away. Silent on failure — a lingering model
   *  is harmless (the 5-min sleep reaps it), and there's no user to inform. */
  async unloadModel(modelId: string): Promise<void> {
    if (this.state !== 'running') return;
    try {
      await (this.opts.fetchImpl ?? fetch)(`${this.rootUrl()}/models/unload`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelId }),
      });
    } catch { /* best-effort */ }
    void this.emitModelsIfChanged();
  }

  /** Force a model resident (the [Reload Model] button AND eager load-on-open).
   *  Fires the warm-up completion WITHOUT awaiting it so the caller returns
   *  immediately; the model poll (fast while loading) then tracks 'loading' +
   *  resident bytes → the progress bar. Routed through trackedFetch so it counts
   *  as activity (never reaped mid-load). */
  async loadModel(modelId: string): Promise<void> {
    const base = await this.ensureRunning(); // http://127.0.0.1:port/v1
    void this.trackedFetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
    }).catch(() => { /* best-effort — the poll reflects the outcome */ });
    // Nudge the poll so 'loading' + the progress bar appear promptly (don't wait
    // for the next lazy tick). The adaptive poll then takes over at fast cadence.
    void this.emitModelsIfChanged();
  }

  /** Emit a fresh models-changed on demand. */
  async pollModelsNow(): Promise<void> {
    await this.emitModelsIfChanged();
  }
}

/** Map llama-server's /models status.value to our EngineModelState. Unknown →
 *  'unloaded' (safe default; never claims a model is resident when unsure). */
function mapModelState(statusValue: unknown): EngineModelState {
  switch (statusValue) {
    case 'loaded': return 'loaded';
    case 'loading': return 'loading';
    case 'sleeping': return 'sleeping';
    default: return 'unloaded';
  }
}
