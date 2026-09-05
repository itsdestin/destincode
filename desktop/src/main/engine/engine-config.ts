// Engine section of ~/.youcoded/config.json (Phase 0 §1: the GGUF cache path is
// recorded in config.json). The engine VERSION pin deliberately lives in CODE
// (engine-pin.ts), not here: config.json is a syncable per-user file while
// engine binaries are per-machine — a synced pin would tell machine B to trust
// a binary it never verified. All writes go through NativeHome's locked
// mutateJson (dev instance + built app share ~/.youcoded).
import * as path from 'path';
import * as os from 'os';
import { NativeHome } from '../native-home';
import type { EngineBackend } from '../../shared/engine-types';

const FILE = 'config.json';

export interface EngineConfig {
  cacheDir: string;              // LLAMA_CACHE — where GGUFs live
  backend: EngineBackend | null; // null = platform default (engine-pin defaultBackend)
  contextSize: number;           // -c for llama-server; inherited by every model instance
}

// 32768 sits well above llama-server's 4096 default (the silent-truncation trap
// ADR 007 calls out in Ollama) without allocating the monster KV cache a
// 128k+ default would. User-tunable in Plan C's Local Models panel.
export const DEFAULT_CONTEXT_SIZE = 32768;

export function defaultCacheDir(homedir: string = os.homedir()): string {
  // llama.cpp's own default when LLAMA_CACHE is unset — sharing it means models
  // the user already pulled with llama-cli/-hf appear in YouCoded and vice versa
  // (spec §4.4 / Phase 0 §1 "GGUF models" note).
  return path.join(homedir, '.cache', 'llama.cpp');
}

// Every member of EngineBackend, and the reason this list has to be complete:
// readEngineConfig drops a backend that is not in it and reports `null`, which
// the rest of the app reads as "on the platform default". So a backend missing
// here does not fail loudly — the user picks it, it saves, and the next launch
// silently runs Vulkan again. Kept honest by engine-config.test.ts, which
// round-trips one saved value per member and will not compile if a member is
// added to the type and not to that test.
const BACKENDS: ReadonlySet<string> = new Set(['vulkan', 'cpu', 'metal', 'cuda', 'rocm']);

export function readEngineConfig(home: NativeHome): EngineConfig {
  const cfg = home.readJson(FILE) as any;
  const e = cfg && typeof cfg === 'object' ? (cfg as any).engine : null;
  return {
    cacheDir: typeof e?.cacheDir === 'string' && e.cacheDir ? e.cacheDir : defaultCacheDir(),
    backend: typeof e?.backend === 'string' && BACKENDS.has(e.backend) ? (e.backend as EngineBackend) : null,
    contextSize: typeof e?.contextSize === 'number' && Number.isFinite(e.contextSize) && e.contextSize > 0
      ? Math.floor(e.contextSize) : DEFAULT_CONTEXT_SIZE,
  };
}

/** Drop one model's per-model settings from `engine.models` (design §E2 —
 *  deleteModel prunes it). WHY it matters: a section for a model that no longer
 *  exists renders a ghost row in the router's preset file that can never load
 *  and cannot be removed from the app (model-presets.ts says so), and a
 *  re-download of the same model would silently inherit the deleted copy's
 *  context length and flags. No-op when there is nothing to prune. */
export async function removeModelSettings(home: NativeHome, modelId: string): Promise<void> {
  await home.mutateJson(FILE, (cur) => {
    const file = (cur && typeof cur === 'object' ? cur : { v: 1 }) as any;
    const models = file?.engine?.models;
    if (!models || typeof models !== 'object' || !(modelId in models)) return file;
    delete models[modelId];
    return file;
  });
}

export async function updateEngineConfig(home: NativeHome, patch: Partial<EngineConfig>): Promise<void> {
  await home.mutateJson(FILE, (cur) => {
    // Preserve sibling top-level keys — config.json will grow other sections
    // (Plan C model stats, later phases). Only the engine object is merged.
    const file = (cur && typeof cur === 'object' ? cur : { v: 1 }) as any;
    if (typeof file.v !== 'number') file.v = 1;
    file.engine = { ...(file.engine ?? {}), ...patch };
    return file;
  });
}
