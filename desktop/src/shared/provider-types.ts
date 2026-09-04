// Provider-layer shapes — Phase 1 Plan A (spec 2026-07-10-phase1-engine-providers-design.md §2.2).
// Shared between main and renderer; keep free of Node/Electron imports.

export type ProviderType =
  | 'local-engine'        // supervised llama-server (registered in Plan B; entry exists from day one)
  | 'openai-compatible'   // Ollama, LM Studio, custom endpoints
  | 'openrouter'
  | 'anthropic' | 'openai' | 'google'   // direct-key providers
  // Sign in with ChatGPT: the user's own plan, reached through OpenAI's sign-in
  // rather than a key. Keyless like 'local-engine' — `ready` means signed in.
  // shared/chatgpt-types.ts carries the account state.
  | 'chatgpt';

export interface ProviderConfig {
  id: string;             // 'local' | 'openrouter' | ulid for user-created entries
  type: ProviderType;
  label: string;
  baseUrl?: string;       // openai-compatible + overrides
  secretRef?: string;     // pointer into the userData secrets store; never the key itself
  enabled: boolean;
}

/** What a native session is bound to: one model on one provider. */
export interface ModelBinding { providerId: string; modelId: string; }

export interface CatalogModel {
  id: string;             // provider-native model id (what the API expects)
  providerId: string;
  label: string;
  contextLength?: number;
  supportsTools?: boolean;
  supportsReasoning?: boolean;
  // Whether this catalog row's model accepts image input, per the SOURCE's own
  // modality data (currently only OpenRouter's `architecture.input_modalities`
  // — see model-catalog.ts's openrouterModels()). `undefined` means "this
  // source does not know" (models.dev rows, local-engine rows, or a malformed
  // OpenRouter row) — a caller must NOT read that as `false`. Only an actual
  // `false` means the source affirmatively says the model can't see images.
  supportsVision?: boolean;
  // USD per 1M tokens — terse to mirror per-1M-token convention; `in` is a JS
  // keyword — destructure as `{ in: input }`.
  /** USD per 1,000,000 tokens. `cacheRead`/`cacheWrite` are optional because
   *  not every provider publishes them; absent means "not published", never
   *  "free" (see the catalog's never-guess rule). Modelling them is what keeps
   *  the session-cost chip from over-reporting a cached session (spec §5). */
  pricing?: { in: number; out: number; cacheRead?: number; cacheWrite?: number };
  // Local-engine models only (Plan B/C). fit is Plan C's estimator; Plan B
  // fills sizeBytes/quant('unknown')/installed(true) from the cache scan.
  local?: { sizeBytes: number; quant: string; installed: boolean; fit?: 'fits' | 'tight' | 'too-large';
            state?: import('./engine-types').EngineModelState };
}

/** provider:list row — config + derived status, never the key.
 *  Do NOT pass a status row back into provider:upsert — handlers must pick
 *  ProviderConfig keys only, or the derived fields (builtIn/hasKey/ready)
 *  get persisted. */
export interface ProviderStatus extends ProviderConfig {
  builtIn: boolean;       // 'local' and 'openrouter' cannot be removed
  hasKey: boolean;        // a secret exists for secretRef
  ready: boolean;         // enabled AND (keyless type OR hasKey); 'local' stays false until Plan B
}
