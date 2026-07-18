// Per-model step budget for the native runtime's agentic turn loop.
//
// Each turn runs tool → result → tool … until the model stops. After N steps
// without a pause the runtime shows the "Continue?" gate (harness-session.ts) so
// a runaway loop can't silently burn a paid provider's credits. That N is not
// one-size-fits-all: frontier models sustain long, coherent multi-step runs and
// hit the gate needlessly at 25, while weaker models are exactly the ones a low
// ceiling protects. So frontier families get a higher budget; everything else
// keeps the conservative default.
//
// This is the SINGLE place a modelId is inspected for step budget — a family-
// keyed regex registry, mirroring the known-models.ts convention. It is a
// deliberate stopgap: ROADMAP is to fold `allowedSteps` into the per-model
// CapabilityProfile once that layer lands, at which point this file collapses
// into a profile field. The patterns are heuristics (web-sourced model names),
// not a guarantee — an unknown model simply falls back to the safe default.

/** Steps a frontier model may take before the "Continue?" gate. */
export const FRONTIER_STEP_BUDGET = 50;
/** Conservative default for unknown / less-capable models. */
export const DEFAULT_STEP_BUDGET = 25;

// Matched against the raw provider modelId (e.g. OpenRouter's
// "moonshotai/kimi-k3", "anthropic/claude-opus-4-8", "x-ai/grok-4.5"). Kept
// broad on purpose — a family match, not an exact version, so a point-release
// doesn't silently drop back to 25.
const FRONTIER_MODEL_PATTERNS: RegExp[] = [
  /opus/i,                 // Claude Opus (4.x, incl. the [1m] variants)
  /\bfable\b/i,            // Claude Fable 5
  /luna|terra|sol/i,       // ChatGPT frontier tiers (Luna / Terra / Sol)
  /kimi[-\s]?k?\s?3/i,     // Kimi K3
  /minimax[-\s]?3/i,       // MiniMax 3
  /grok[-\s]?4\.5/i,       // Grok 4.5
];

/** Steps allowed before the budget gate, chosen by model tier. Unknown or
 *  undefined models get the conservative default. Pure — no I/O. */
export function stepBudgetFor(modelId: string | undefined): number {
  if (modelId && FRONTIER_MODEL_PATTERNS.some((re) => re.test(modelId))) {
    return FRONTIER_STEP_BUDGET;
  }
  return DEFAULT_STEP_BUDGET;
}
