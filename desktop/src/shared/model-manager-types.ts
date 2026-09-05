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
  /** The repo's vision projector (`mmproj-*.gguf`), downloaded WITH the model into a
   *  folder of its own so the engine pairs them (deck Q-3, pick c — always; S-3 for
   *  models already on disk). Null/absent = a text-only model. Size is the F16 file. */
  visionBytes?: number | null;
}

export type FitLabel = 'fits' | 'tight' | 'too-large';
export interface FitEstimate {
  fit: FitLabel;
  // Every label is an EXPLICIT estimate (spec §4.3 — no fake precision).
  // GPU-aware (Amendment 2026-07-14 F): the label wording differs for a
  // fully-GPU-offloaded fit ("Runs fast — fits on your GPU") vs a GPU+RAM split
  // vs a RAM-only machine. See fit-estimator.ts for the exact strings.
  label: string;
  /** 2026-09-05 (deck S-2): the two numbers behind the verdict, so the label can read
   *  "9 GB model + 16 GB for 128k context" instead of a bare verdict. contextBytes is
   *  computed from the model file's own header (layers × kv-heads × head size) at the
   *  context length that will be used for THIS model — the per-model setting when there
   *  is one, else the engine's. visionBytes is the projector file, when the model has one.
   *  Absent from an older main → the UI shows the verdict alone. */
  breakdown?: {
    modelBytes: number;
    contextBytes: number;
    contextLength: number;
    visionBytes?: number;
  };
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

/** What state a download on disk is in. A model is only usable when every
 *  declared part is published — see docs/active/specs/2026-08-26-model-download-resume-design.md.
 *    complete    — every part present; the ordinary case
 *    unfinished  — short of parts (a .partial, or nothing but a manifest yet),
 *                  WITH an UNSTAMPED manifest → resumable
 *    untraceable — short of parts, no usable manifest (downloaded before
 *                  manifests existed, or the record is unreadable) → we cannot
 *                  know where it came from, so no Resume
 *  A manifest stamped `completedAt` describes a download that already landed,
 *  so it never makes a row 'unfinished' — see download-manifest.ts. */
export type LocalModelStatus = 'complete' | 'unfinished' | 'untraceable';

export interface InstalledLocalModel {
  id: string;                 // the router-served model id (filename minus .gguf)
  sizeBytes: number;          // bytes ON DISK: published parts, plus the .partial when unfinished
  // From the manifest when there is one (the exact string Hugging Face used,
  // which is what live download-progress events carry), else parsed from the
  // filename; null when unrecognized. WHY: the renderer matches a live download
  // to its row on repo + quant, so the row must carry the same quant string.
  quant: string | null;
  quantDescription: string | null;
  parts: number;              // declared part count; 1 for single-file models
  status: LocalModelStatus;
  partsPresent: number;       // published .gguf files found for this set
  // From the manifest — null for 'complete' (not needed) and 'untraceable' (unknown).
  // WHY totalSizeBytes may be null: an untraceable row must show NO percentage.
  // A denominator we cannot know would be a fabricated number in a shipping UI.
  totalSizeBytes: number | null;
  repo: string | null;        // e.g. 'unsloth/Qwen3.8-Flash-Next-GGUF'
  /** 2026-09-05 (deck S-3). 'ready' = model + projector sit in their own folder and the
   *  engine reports image input; 'available' = the repo has a projector this download
   *  never fetched (the row offers "Add vision"); 'none' = a text-only model. Absent from
   *  an older main → treated as 'none'. */
  vision?: 'ready' | 'available' | 'none';
  visionBytes?: number | null;
}

/** Per-model engine settings (deck Q-2, pick a) — written to the router's preset file
 *  so each model loads with its own values. Every field has a "use the engine's
 *  default" state so an untouched model behaves exactly as today. */
export interface ModelSettings {
  contextLength: number | null;   // null = the engine-wide context length
  keepLoaded: boolean;            // true = never auto-sleep this model
  gpuLayers: number | 'auto';     // how many layers live on the graphics chip
  extraFlags: string;             // raw llama-server flags, power users only
}

/** A downloaded model's vision projector (the `mmproj-*.gguf` file that lets a
 *  model look at images) as the manifest records it. */
export interface ManifestVisionFile {
  path: string;                                 // repo-relative path
  size: number;
  sha256: string | null;                        // HF lfs.oid when the repo publishes one
}

/** Written next to a download BEFORE its first byte, so a leftover .partial can
 *  still be resumed after a crash. Carries the whole QuantOption, not just the
 *  repo name, so resume needs no Hugging Face round trip — the interruption
 *  that stranded the download is often the network itself.
 *
 *  WHY it now OUTLIVES the download: the manifest is the only record of which
 *  Hugging Face repo a model came from and whether that repo ships a vision
 *  projector, and a finished model still needs both. So completion stamps
 *  `completedAt` instead of deleting the file, and "a manifest exists" no
 *  longer means "this download is unfinished" — `completedAt` is the test. */
export interface DownloadManifest {
  v: 1;
  repo: string;
  quant: string;
  files: string[];                              // repo-relative paths, part 1 first
  totalSizeBytes: number;
  sha256ByFile: Record<string, string | null>;
  startedAt: number;                            // epoch ms
  completedAt?: number;                         // epoch ms; absent = still unfinished
  visionFile?: ManifestVisionFile;              // absent = this repo has no projector
}

export interface DetectedEndpoint {
  kind: 'ollama' | 'lmstudio';
  label: string;              // 'Ollama (local)' / 'LM Studio (local)'
  baseUrl: string;            // the /v1 URL to store on the provider entry
  modelCount: number | null;
  alreadyAdded: boolean;      // an enabled openai-compatible provider with this baseUrl exists
}
