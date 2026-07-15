// EngineSupervisor — llama-server lifecycle (spec §3.2, ADR 007). Direct heir
// of the archived feat/opencode-mvp OpenCodeService supervision pattern.
//
// Router mode: spawned WITHOUT -m; the server auto-discovers GGUFs in
// LLAMA_CACHE, hot-loads on first request, LRU-evicts (--models-max), and
// isolates each model in its own child process. We only ever talk HTTP to it.
//
// Idle shutdown: the AI SDK is handed trackedFetch, so every chat request
// passes through here — each call bumps lastActivity and holds an inFlight
// count until its response BODY is fully read (streams count as active for
// their whole duration; a 10-minute generation must not be killed mid-stream).
import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import { EventEmitter } from 'events';
import type { EngineModel, EngineModelState, EngineRunState } from '../../shared/engine-types';
import { scanGgufCache } from './cache-scan';

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
        if (res.ok) {
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
    child.kill();
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(timer); resolve(); } };
      child.once('exit', finish);
      const timer = setTimeout(finish, 2_000); // best-effort — don't hang app quit
    });
    this.child = null;
    this.state = 'stopped';
    this.emit('status-changed');
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

  /** Running → GET /models (live status); stopped → cache scan (loaded:false).
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
      const sizeById = new Map<string, number | null>();
      for (const m of scanGgufCache(this.opts.cacheDir)) sizeById.set(m.id, m.sizeBytes);
      const out: EngineModel[] = [];
      for (const row of rows) {
        const id = typeof row?.id === 'string' ? row.id : typeof row?.name === 'string' ? row.name : null;
        if (!id) continue; // skip malformed
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
      return out;
    } catch {
      return scanGgufCache(this.opts.cacheDir); // engine died mid-call — degrade to scan
    }
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
