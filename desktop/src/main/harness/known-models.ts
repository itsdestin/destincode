// Curated known-model capability registry (spec §4.1, decision 4). Keyed by model
// FAMILY via a case-insensitive regex on the modelId — this is the ONLY place a
// model name influences behavior. Carries the BEHAVIORAL tuning that GGUF metadata
// can't (prompt variant, doom-loop, parallel safety, presentation, tool support).
// Context windows are NOT the source of truth here — a later task reads the real
// window from the engine; maxContextWindow below is only a documented sanity ceiling.
//
// NOT exhaustive by design: the families people actually run, everything else falls
// to the fallback. The FACTUAL fields (maxContextWindow, supportsTools) are VERIFIED
// in a later task from model cards + GGUF metadata — the seed values here are the
// conservative behavioral tuning we can reason about now.
export interface KnownModelEntry {
  match: string;                         // case-insensitive regex tested against modelId
  label: string;                         // human name (logs/UI)
  maxToolPresentation?: import('./capability-profile').ToolPresentation;
  promptVariant?: import('./capability-profile').PromptVariant;
  doomLoopThreshold?: number;
  supportsParallelToolCalls?: boolean;
  supportsTools?: boolean;               // verified in a later task
  maxContextWindow?: number;             // documented trained max (sanity ceiling; discovery wins)
}

// Seed entries — behavioral tuning only; a later task verifies/fills the factual fields.
export const KNOWN_MODELS: KnownModelEntry[] = [
  // Qwen 3.6 MoE (35B-class): capable — full presentation, standard doom-loop.
  { match: 'qwen\\W?3\\.6.*(35b|moe|a\\d+b)', label: 'Qwen 3.6 MoE', maxToolPresentation: 'full', doomLoopThreshold: 3 },
  // Qwen 3.5 dense small (≈9B): simplified presentation, tighter doom-loop.
  { match: 'qwen\\W?3\\.5.*9b', label: 'Qwen 3.5 9B', maxToolPresentation: 'simplified', doomLoopThreshold: 2 },
  // Qwen 3.5 dense large (≈122B): full presentation.
  { match: 'qwen\\W?3\\.5.*(70b|122b)', label: 'Qwen 3.5 (large)', maxToolPresentation: 'full', doomLoopThreshold: 3 },
  // Gemma 4 line: full presentation (verify tool support later).
  { match: 'gemma\\W?4', label: 'Gemma 4', maxToolPresentation: 'full', doomLoopThreshold: 3 },
  // Gemma 3n small (E2B/E4B effective): tiny — simplified, tightest doom-loop.
  { match: 'gemma\\W?3n|gemma.*e[24]b', label: 'Gemma 3n (E2B/E4B)', maxToolPresentation: 'simplified', doomLoopThreshold: 2 },
];

export function matchKnownModel(modelId: string, registry: KnownModelEntry[] = KNOWN_MODELS): KnownModelEntry | undefined {
  return registry.find((e) => { try { return new RegExp(e.match, 'i').test(modelId); } catch { return false; } });
}
