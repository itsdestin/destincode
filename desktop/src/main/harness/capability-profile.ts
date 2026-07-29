// Capability profiles (spec §4.1, decisions 2/9). Resolved in THREE layers so a
// known model gets curated tuning, an unknown one gets a safe fallback, and the
// harness NEVER branches on a model-name string (only the registry matcher does).
import { KNOWN_MODELS, matchKnownModel, type KnownModelEntry } from './known-models';

export type ToolPresentation = 'full' | 'simplified';
export type PromptVariant = 'anthropic' | 'gpt' | 'default' | 'local-small';

export interface CapabilityProfile {
  maxToolPresentation: ToolPresentation;   // simplified = compact descriptions + serial calls
  promptVariant: PromptVariant;            // which steering overlay to append
  doomLoopThreshold: number;               // identical-call repeats that trip the ask (2 for small)
  supportsParallelToolCalls: boolean;      // may the model emit >1 tool call per step?
  constrainToolArgs: boolean;              // inject the llama.cpp serial/grammar hook (local only)
  supportsTools: boolean;                  // false → run as plain chat (no tools attached)
  /** May the model-invoked Skill tool be attached? Its description carries every
   *  installed skill's id + one-liner on EVERY turn (~1–2k tokens with a normal
   *  install), so a small window cannot afford it — those sessions reach skills
   *  through the user-invoked /skill-name path instead. */
  exposeSkillCatalog: boolean;
  /** Ceiling for content injected as messages mid-session (skill bodies, rule
   *  text, nested project instructions). Sized from the REAL window, not the
   *  provider: a 128k local model has more room than a 32k hosted one. */
  injectionBudgetTokens: number;
}

export type ProfileProviderType =
  | 'local-engine' | 'openrouter' | 'openai-compatible'
  | 'anthropic' | 'openai' | 'google';

// LAYER 1 — discovered truth (a later task fills contextLength from the real engine).
export interface DiscoveredModel { providerType: ProfileProviderType; modelId: string; contextLength: number | null }

const SMALL_LOCAL_CONTEXT = 32_768;

export const CLOUD_DEFAULT: CapabilityProfile = {
  maxToolPresentation: 'full', promptVariant: 'default',
  doomLoopThreshold: 3, supportsParallelToolCalls: true,
  constrainToolArgs: false, supportsTools: true,
  exposeSkillCatalog: true, injectionBudgetTokens: 20_000,
};

function cloudVariant(t: ProfileProviderType): PromptVariant {
  if (t === 'anthropic') return 'anthropic';
  if (t === 'openai') return 'gpt';
  return 'default';
}

// Hosted providers whose window is large by construction. We never DISCOVER their
// context length, so `contextLength: null` from one of these means "not measured",
// not "small" — sizing them down would starve the primary use case.
//
// 'openai-compatible' is deliberately NOT here: provider-registry documents it as
// the Ollama / LM Studio shape, so an unmeasured one is a local model in disguise
// and gets the conservative treatment.
const FRONTIER_PROVIDERS: ReadonlySet<ProfileProviderType> = new Set(['anthropic', 'openai', 'google', 'openrouter']);

/** M3 item 5 — how much may be injected, and may the skill catalog ride at all.
 *  A function of the WINDOW rather than the provider, so a 128k local model is
 *  treated as roomier than a 32k hosted one. An unmeasured window is small: we
 *  never assume room we could not verify (the same conservative posture the rest
 *  of the three-layer resolution takes). */
/** The tool presentation this model will actually run with — registry overlay
 *  first, then the window-tiered fallback. Extracted because injectionSizing
 *  needs it BEFORE the profile object is assembled, and duplicating the
 *  precedence here would be a second place for it to drift. */
function presentationFor(d: DiscoveredModel, registry: KnownModelEntry[]): ToolPresentation {
  if (d.providerType !== 'local-engine') return CLOUD_DEFAULT.maxToolPresentation;
  const known = matchKnownModel(d.modelId, registry);
  return known?.maxToolPresentation ?? localFallback(d.contextLength).maxToolPresentation;
}

function injectionSizing(d: DiscoveredModel, registry: KnownModelEntry[]): Pick<CapabilityProfile, 'exposeSkillCatalog' | 'injectionBudgetTokens'> {
  if (FRONTIER_PROVIDERS.has(d.providerType)) {
    return { exposeSkillCatalog: true, injectionBudgetTokens: CLOUD_DEFAULT.injectionBudgetTokens };
  }
  // The EFFECTIVE window, not the raw one — a small model loaded at a large -c
  // must not be judged roomy just because llama-server was told a big number.
  const window = effectiveContextForModel(d.contextLength, d.modelId, registry);
  // Two DIFFERENT questions, and the window only answers one of them.
  //
  //   "can it AFFORD the catalog?" -> window size.
  //   "should it be CHOOSING skills on its own?" -> model capability.
  //
  // Gating on window alone conflated them: a Qwen 3.5 2B launched with
  // `-c 128000` has ample room, got the full catalog, and spent its turn
  // reciting all twelve skills instead of doing anything (Destin, 2026-07-28).
  // `maxToolPresentation` is the capability signal the profile already carries —
  // 'simplified' is exactly "this model needs the schema kept small and simple" —
  // so a model marked simplified never gets autonomous skill selection, whatever
  // its window. Those sessions still reach every skill through /skill-name.
  const capable = presentationFor(d, registry) === 'full';
  return {
    exposeSkillCatalog: capable && window != null && window >= SMALL_LOCAL_CONTEXT,
    injectionBudgetTokens: window == null ? 2_000
      : window >= 100_000 ? 20_000
      : window >= SMALL_LOCAL_CONTEXT ? 6_000
      : 2_000,
  };
}

// LAYER 3 — conservative fallback for an UNKNOWN local model, tiered by the REAL
// context window. Constrained args + serial-only are the safe llama-server default
// at every size; presentation/variant/doom-loop tighten for a small window.
// Returns the BEHAVIORAL layers only. Sizing (exposeSkillCatalog /
// injectionBudgetTokens) is computed separately by injectionSizing and spread on
// by resolveProfile, because it depends on the window rather than on which layer
// won. Typing that honestly keeps tsc able to catch a missing field at every
// construction site instead of letting a spread paper over it.
type BehavioralProfile = Omit<CapabilityProfile, 'exposeSkillCatalog' | 'injectionBudgetTokens'>;

function localFallback(ctx: number | null): BehavioralProfile {
  const small = ctx == null || ctx <= SMALL_LOCAL_CONTEXT;
  return {
    maxToolPresentation: small ? 'simplified' : 'full',
    promptVariant: small ? 'local-small' : 'default',
    doomLoopThreshold: small ? 2 : 3,
    supportsParallelToolCalls: false,
    constrainToolArgs: true,
    supportsTools: true,   // assume yes; the registry marks known tool-less models false
  };
}

// The context window a session should ACTUALLY use: the real loaded window (from
// the engine, Task 4) further clamped to a KNOWN model's documented trained ceiling
// (the registry's maxContextWindow). Without this, a small model loaded at a large
// -c would be sized past its real ceiling and silently degrade — the GGUF-header
// reader that would catch this generically isn't built, so the registry ceiling is
// the pragmatic stand-in for known models. Unknown models / cloud models (no
// registry match) pass through unchanged.
export function effectiveContextForModel(loadedContext: number | null, modelId: string, registry: KnownModelEntry[] = KNOWN_MODELS): number | null {
  const ceiling = matchKnownModel(modelId, registry)?.maxContextWindow;
  if (loadedContext == null) return ceiling ?? null;
  return ceiling ? Math.min(loadedContext, ceiling) : loadedContext;
}

export function resolveProfile(d: DiscoveredModel, registry: KnownModelEntry[] = KNOWN_MODELS): CapabilityProfile {
  // Sizing is orthogonal to the behavioral layers below — it depends only on the
  // window — so it is computed once and spread onto whichever base is returned.
  const sizing = injectionSizing(d, registry);
  if (d.providerType !== 'local-engine') {
    return { ...CLOUD_DEFAULT, promptVariant: cloudVariant(d.providerType), ...sizing };
  }
  const base = localFallback(d.contextLength);
  const known = matchKnownModel(d.modelId, registry);   // LAYER 2 overlay
  if (!known) return { ...base, ...sizing };
  return {
    maxToolPresentation: known.maxToolPresentation ?? base.maxToolPresentation,
    promptVariant: known.promptVariant ?? base.promptVariant,
    doomLoopThreshold: known.doomLoopThreshold ?? base.doomLoopThreshold,
    supportsParallelToolCalls: known.supportsParallelToolCalls ?? base.supportsParallelToolCalls,
    constrainToolArgs: base.constrainToolArgs,           // always true for local
    supportsTools: known.supportsTools ?? base.supportsTools,
    ...sizing,
  };
}
