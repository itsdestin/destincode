// Per-model thinking-effort capability map for the local (OpenCode/Ollama)
// runtime. Determines which buttons the chip exposes AND which mechanism
// SessionManager uses to actually trigger thinking.
//
// Lives in `shared/` because both the main process (SessionManager dispatch)
// and the renderer (new-session form button rendering) need to consult it.
//
// ─── The reality of "graduated reasoning" on Ollama ──────────────────────
//
// Earlier iterations of this map exposed Off/Low/Medium/High for "graduated
// thinking" models and Off/On for binary. After comprehensive research
// (2026-05-11) the conclusion is: **graduated tiers are a fiction** at every
// model in our catalog. Ollama's OpenAI-compat layer translates the
// `reasoning_effort` field to its native `think: bool` parameter — all of
// low/medium/high collapse to `think: true`, only `none` maps to `think:
// false`. Empirical Gemma 4 probes confirmed this (low/med/high produced
// effectively identical ~1700 char reasoning lengths). Only `gpt-oss`
// (which we don't ship) honors the three tiers as distinct trace budgets.
//
// So the entire catalog is now binary on/off. The capability map stays
// generic — future models that DO honor graduated tiers (gpt-oss, future
// model releases) can be added back without touching consumers.
//
// 'variant' mechanism: thinking ON encodes as the `@on` suffix on the model
// id (e.g. `qwen3:8b@on`). opencode.json registers a variant entry sharing
// the canonical `id:` with `options.reasoningEffort: "medium"`. Off uses the
// bare canonical id. SessionManager passes the full suffixed id through.
//
// 'none' mechanism: model doesn't support thinking. Any suffix is stripped
// defensively but the chip should never have allowed setting one.
//
// ─── How to add a model ──────────────────────────────────────────────────
// Probe it via curl + reasoning_effort: "medium". If the response carries
// a non-empty `reasoning` field separate from `content` (and doesn't hang
// or error), the model honors thinking and goes in THINKING_CAPABLE_MODELS.
//
//   curl http://localhost:11434/v1/chat/completions \
//     -d '{"model":"<name>","messages":[...],"reasoning_effort":"medium"}'

export type EffortLevel = 'none' | 'on';

/** What underlying mechanism enables thinking for this model. */
export type ThinkingMechanism = 'variant' | 'none';

export interface ModelThinkingCapability {
  /** Effort levels the chip should expose. Always includes 'none'. */
  levels: ReadonlySet<EffortLevel>;
  /** How SessionManager actually triggers thinking when 'on' is selected. */
  mechanism: ThinkingMechanism;
}

const BINARY_ON_OFF: ReadonlySet<EffortLevel> = new Set(['none', 'on']);
const NONE_ONLY: ReadonlySet<EffortLevel> = new Set(['none']);

/**
 * Allowlist of models verified to honor `reasoning_effort` (via Ollama's
 * OpenAI-compat translation to `think:true`). Prefix match against the
 * model's base name (size tag + @on suffix stripped).
 *
 * Updated 2026-05-11 after research + empirical probes. Removed:
 *   - 'qwen3-bigctx', 'qwen3-nothink', 'qwen3-coder' — internal variants,
 *     not in the user-visible catalog
 * Kept:
 *   - 'qwen3'  — confirmed working with reasoning_effort:"none" (off) and
 *                with "medium" (on, embedded reasoning OR separate field
 *                depending on Ollama renderer version)
 *   - 'gemma4' — confirmed working end-to-end via probe; reasoning field
 *                separates cleanly from content
 *   - 'deepseek-r1' — known reasoning specialist; thinking is ALWAYS on
 *                    regardless of the effort field. Listed here so the
 *                    chip's On state is enabled; callers should still
 *                    expect reasoning even with Off.
 */
const THINKING_CAPABLE_MODELS: readonly string[] = [
  'qwen3',
  'gemma4',
  'deepseek-r1',
];

/**
 * Strip the `@on` variant suffix and the model size tag, returning a
 * normalized base name suitable for capability lookup.
 *
 *   "qwen3:8b@on"     → "qwen3"
 *   "qwen3.5:9b"      → "qwen3.5"
 *   "gemma4:e2b@on"   → "gemma4"
 */
function baseName(modelId: string): string {
  const noVariant = modelId.split('@')[0];
  const noTag = noVariant.split(':')[0];
  return noTag;
}

/**
 * Returns the thinking capability for a model — the levels the UI should
 * expose AND the mechanism SessionManager uses to trigger them.
 */
export function getModelCapability(modelId: string): ModelThinkingCapability {
  if (!modelId) return { levels: BINARY_ON_OFF, mechanism: 'variant' };
  const base = baseName(modelId);

  // Qwen 3.5 family — accepts reasoning_effort syntactically but the
  // current Ollama implementation has 5+ open bugs against this exact model
  // (#14748, #14759, #14745, #14621, #14867). Empirically: basic chat hangs,
  // multimodal probes crash the runner. Until upstream stabilizes, expose
  // Off-only so users don't trigger known-broken codepaths.
  if (base.startsWith('qwen3.5')) {
    return { levels: NONE_ONLY, mechanism: 'variant' };
  }

  // Thinking-capable allowlist — binary on/off.
  for (const prefix of THINKING_CAPABLE_MODELS) {
    if (base === prefix || base.startsWith(prefix + '-')) {
      return { levels: BINARY_ON_OFF, mechanism: 'variant' };
    }
  }

  // Default: no thinking. Conservative — most Ollama models don't support
  // thinking at all and exposing 'on' would produce errors or hangs.
  return { levels: NONE_ONLY, mechanism: 'none' };
}

/**
 * Convenience wrapper for renderer button-rendering. Equivalent to
 * `getModelCapability(modelId).levels` for callers that don't care about
 * the underlying mechanism.
 */
export function getSupportedEffortLevels(modelId: string): ReadonlySet<EffortLevel> {
  return getModelCapability(modelId).levels;
}

/**
 * If the selected effort isn't supported by this model, return the closest
 * supported fallback ('none'). Used when the user switches models
 * mid-form so the form doesn't keep an impossible setting selected.
 */
export function clampEffortToSupported(modelId: string, effort: EffortLevel): EffortLevel {
  if (getSupportedEffortLevels(modelId).has(effort)) return effort;
  return 'none';
}
