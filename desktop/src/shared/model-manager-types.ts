// Model-manager shapes — Phase 1 Plan C (spec 2026-07-10-phase1-engine-providers-design.md §4).
// Shared between main and renderer; keep free of Node/Electron imports.

// Three tiers (Amendment 2026-07-14 A). No 'coder' tier. This union, the
// validList allowlist in curated-catalog.ts, and the panel's tier headers are
// the THREE coupled spots — change them together.
export type ModelTier = 'small' | 'everyday' | 'large';

/** Spec §4.1 entry shape. NO baked sizes (Amendment 2026-07-14 D): fit is
 *  computed from LIVE models.quants(hfRepo) sizes, so the seed carries only
 *  what can't be derived. quantDefault names the quant the card downloads and
 *  sizes/fits against. */
export interface CuratedModel {
  id: string;             // stable curated id, e.g. 'qwen35-4b'
  label: string;          // display name, e.g. 'Qwen3.5 4B'
  hfRepo: string;         // 'unsloth/Qwen3.5-4B-GGUF'
  quantDefault: string;   // e.g. 'UD-Q4_K_XL'
  contextLength?: number; // model's trained context (informational; engine -c governs)
  tier: ModelTier;
  notes?: string;         // one plain-language line shown on the card
}

/** One downloadable quant variant of an HF repo, after filename parsing. */
export interface QuantOption {
  quant: string;              // 'Q4_K_M', 'UD-Q4_K_XL', 'F16', …
  description: string;        // plain language: 'Recommended balance of quality and size'
  files: string[];            // repo-relative paths, multi-part sets in order
  totalSizeBytes: number;
  sha256ByFile: Record<string, string | null>; // from lfs.oid; null when HF omits it
}

export type FitLabel = 'fits' | 'tight' | 'too-large';
export interface FitEstimate {
  fit: FitLabel;
  // Every label is an EXPLICIT estimate (spec §4.3 — no fake precision).
  // GPU-aware (Amendment 2026-07-14 F): the label wording differs for a
  // fully-GPU-offloaded fit ("Runs fast — fits on your GPU") vs a GPU+RAM split
  // vs a RAM-only machine. See fit-estimator.ts for the exact strings.
  label: string;
}

/** Best-effort dedicated-GPU probe result (gpu-detector.ts). Both null when no
 *  dedicated GPU is confidently detected — the estimator then falls back to
 *  RAM-only. Integrated GPUs report null vram on purpose (shared system RAM). */
export interface GpuInfo {
  name: string | null;             // e.g. 'NVIDIA GeForce RTX 4090' — captured for diagnostics/future display (not shown in v1)
  totalVramBytes: number | null;   // dedicated VRAM; null = unknown/none → RAM-only fit
}

export interface HFSearchHit { repo: string; downloads: number; likes: number; }

export type DownloadState = 'downloading' | 'verifying' | 'done' | 'error' | 'cancelled';
export interface DownloadProgress {
  downloadId: string;
  repo: string;
  quant: string;
  state: DownloadState;
  receivedBytes: number;      // across ALL parts
  totalBytes: number;
  currentPart: number;        // 1-based
  parts: number;
  message?: string;           // plain language, present for state 'error'
}

// lastUsedAt + defaultForTier were CUT from v1 (Amendment 2026-07-14 G).
export interface InstalledLocalModel {
  id: string;                 // the router-served model id (filename minus .gguf)
  sizeBytes: number;          // summed across all parts for a split model
  quant: string | null;       // parsed from filename; null when unrecognized
  quantDescription: string | null;
  parts: number;              // 1 for single-file models
}

export interface DetectedEndpoint {
  kind: 'ollama' | 'lmstudio';
  label: string;              // 'Ollama (local)' / 'LM Studio (local)'
  baseUrl: string;            // the /v1 URL to store on the provider entry
  modelCount: number | null;
  alreadyAdded: boolean;      // an enabled openai-compatible provider with this baseUrl exists
}
