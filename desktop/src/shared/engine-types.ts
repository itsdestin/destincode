// Engine-layer shapes — Phase 1 Plan B (spec 2026-07-10-phase1-engine-providers-design.md §3).
// Shared between main and renderer; keep free of Node/Electron imports.

export type EngineBackend = 'vulkan' | 'cpu' | 'metal' | 'cuda';

export type EngineRunState = 'not-installed' | 'stopped' | 'starting' | 'running' | 'error';

export interface EngineStatus {
  installed: boolean;
  installedVersion: string | null;   // e.g. 'b9986' once installed
  pinnedVersion: string;             // what engine-pin.ts currently wants (differs after a pin bump)
  backend: EngineBackend | null;     // backend of the installed build
  state: EngineRunState;
  errorMessage?: string;             // plain language; present when state === 'error'
  cacheDir: string;                  // where GGUF models live (LLAMA_CACHE)
  port: number;
}

export type EngineInstallProgress =
  | { kind: 'download'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'verify' }
  | { kind: 'unpack' }
  | { kind: 'done'; version: string; backend: EngineBackend }
  | { kind: 'error'; message: string };

/** One GGUF the engine can serve — from GET /models when running, else a cache scan. */
export interface EngineModel {
  id: string;              // what /v1/chat/completions expects in its "model" field
  sizeBytes: number | null;
  loaded: boolean;         // always false when derived from a cache scan (engine not running)
}
