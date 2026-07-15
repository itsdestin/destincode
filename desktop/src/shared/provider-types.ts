// Provider-layer shapes — Phase 1 Plan A (spec 2026-07-10-phase1-engine-providers-design.md §2.2).
// Shared between main and renderer; keep free of Node/Electron imports.

export type ProviderType =
  | 'local-engine'        // supervised llama-server (registered in Plan B; entry exists from day one)
  | 'openai-compatible'   // Ollama, LM Studio, custom endpoints
  | 'openrouter'
  | 'anthropic' | 'openai' | 'google';  // direct-key providers

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
  // USD per 1M tokens — terse to mirror per-1M-token convention; `in` is a JS
  // keyword — destructure as `{ in: input }`.
  pricing?: { in: number; out: number };
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
