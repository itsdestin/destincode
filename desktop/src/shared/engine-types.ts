// Engine-layer shapes — Phase 1 Plan B (spec 2026-07-10-phase1-engine-providers-design.md §3).
// Shared between main and renderer; keep free of Node/Electron imports.

// 'rocm' added 2026-09-05 (local-engine upgrades, questions deck Q-1): upstream ships
// ROCm builds for Linux x64 and Windows x64 since b10665.
export type EngineBackend = 'vulkan' | 'cpu' | 'metal' | 'cuda' | 'rocm';

export type EngineRunState = 'not-installed' | 'stopped' | 'starting' | 'running' | 'error';

/** A faster engine build the card may offer (S-1: shown ONLY when the matching
 *  graphics chip was detected in main — never a blind "Switch to CUDA" on every
 *  Windows PC). `needs-prereqs` = the chip is there but the system software the
 *  build loads at runtime is not (Linux ROCm); the card then shows the install
 *  guide (Q-1 pick a) instead of switching. */
export interface BackendOption {
  backend: EngineBackend;
  label: string;                     // 'Switch to ROCm (faster on AMD)'
  state: 'ready' | 'needs-prereqs';
}

/** What is missing before a backend can be installed, and how to get it.
 *  `command` is the one line for THIS Linux flavour, and is null for two very
 *  different reasons that `reason` tells apart — see below. */
export interface EnginePrereqs {
  backend: EngineBackend;
  satisfied: boolean;
  distro: string | null;             // 'Arch Linux', 'Ubuntu 24.04', …
  command: string | null;            // 'sudo pacman -S rocm-hip-runtime hipblas rocblas'
  docsUrl: string;
  explainer: string;                 // one plain sentence: what the software is
  /** WHY a `command` is absent, so the card never says the wrong thing:
   *  - 'needs-amd-repo' — we know exactly which Linux this is, and its packages
   *    come from AMD's own repository, which has to be registered first. There
   *    is no honest one-liner for that, so the guide is the answer.
   *  - 'unknown-distro' — we could not identify the system at all.
   *  Telling an Ubuntu user we could not recognise their Linux, right after
   *  naming it as 'Ubuntu 24.04', reads as the app being broken. Absent when
   *  `command` is present or the check is satisfied. */
  reason?: 'needs-amd-repo' | 'unknown-distro';
}

/** The two engine-wide speed features (Q-4 pick a: visible under Advanced, on by
 *  default). Changing either restarts the engine. */
export interface EngineSpeedSettings {
  speculative: boolean;              // --spec-default
  compressCache: boolean;            // --cache-type-k q8_0
}

/** How fast one finished reply ran, read off llama-server's final streamed
 *  frame (`timings.prompt_per_second` / `timings.predicted_per_second`).
 *  'prompt' is how fast it READ the conversation, 'generate' how fast it WROTE
 *  the answer — the two numbers the engine card's fact line shows. */
export interface ReplyTimings {
  promptPerSecond: number;
  generatePerSecond: number;
}

export interface EngineStatus {
  installed: boolean;
  installedVersion: string | null;   // e.g. 'b9986' once installed
  pinnedVersion: string;             // what engine-pin.ts currently wants (differs after a pin bump)
  backend: EngineBackend | null;     // backend of the installed build
  state: EngineRunState;
  errorMessage?: string;             // plain language; present when state === 'error'
  cacheDir: string;                  // where GGUF models live (LLAMA_CACHE)
  contextSize: number;               // configured -c (Plan C context-length knob reads this)
  port: number;
  // ---- 2026-09-05 local-engine upgrades (all optional: an older main omits them) ----
  /** The device the engine reports it will run on ('AMD Radeon 8060S Graphics'),
   *  from `llama-server --list-devices` at install/verify time. Null = CPU only. (S-4) */
  deviceName?: string | null;
  /** Σ `sizeBytes` of the engine's **`loaded`** rows only — never `sleeping`
   *  ones. A slept model has had its memory FREED (that is what
   *  --sleep-idle-seconds does); counting it would tell the user gigabytes are
   *  in use that the machine has already got back (R1-14). `undefined` = the
   *  engine has not been asked yet, which is not the same as "nothing loaded".
   *  (S-4) */
  loadedModelsBytes?: number;
  /** Speed of the most recent reply: prompt reading and generation, per second.
   *  Absent until a reply has actually been measured — never a zero standing in
   *  for "we don't know yet". (S-4) */
  lastReply?: ReplyTimings | null;
  /** Faster builds this machine could switch to. Empty = nothing to offer. (S-1) */
  backendOptions?: BackendOption[];
  speed?: EngineSpeedSettings;
}

export type EngineInstallProgress =
  | { kind: 'download'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'verify' }
  | { kind: 'unpack' }
  | { kind: 'done'; version: string; backend: EngineBackend }
  | { kind: 'error'; message: string };

/** Per-model residency, read from GET /models `status.value` (llama-server b9992).
 *  'sleeping' = auto-slept by --sleep-idle-seconds (memory freed, wakes on next
 *  request). 'unloaded' = not resident (never loaded, LRU-evicted, or a cache
 *  scan while the engine is off). See docs/engine-dependencies.md. */
export type EngineModelState = 'unloaded' | 'loading' | 'loaded' | 'sleeping';

/** One GGUF the engine can serve — from GET /models when running, else a cache scan. */
export interface EngineModel {
  id: string;              // what /v1/chat/completions expects in its "model" field
  sizeBytes: number | null;
  loaded: boolean;         // convenience: state === 'loaded'. False from a cache scan.
  state: EngineModelState; // 'unloaded' when derived from a cache scan (engine not running)
  /** While state === 'loading': bytes of the model resident in RAM so far (the
   *  model child's VmRSS, monotonic + clamped to sizeBytes) — drives the "N GB /
   *  M GB" progress bar. Undefined off Linux or when not loading. */
  loadedBytes?: number;
}
