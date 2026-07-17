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
};

function cloudVariant(t: ProfileProviderType): PromptVariant {
  if (t === 'anthropic') return 'anthropic';
  if (t === 'openai') return 'gpt';
  return 'default';
}

// LAYER 3 — conservative fallback for an UNKNOWN local model, tiered by the REAL
// context window. Constrained args + serial-only are the safe llama-server default
// at every size; presentation/variant/doom-loop tighten for a small window.
function localFallback(ctx: number | null): CapabilityProfile {
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
  if (d.providerType !== 'local-engine') {
    return { ...CLOUD_DEFAULT, promptVariant: cloudVariant(d.providerType) };
  }
  const base = localFallback(d.contextLength);
  const known = matchKnownModel(d.modelId, registry);   // LAYER 2 overlay
  if (!known) return base;
  return {
    maxToolPresentation: known.maxToolPresentation ?? base.maxToolPresentation,
    promptVariant: known.promptVariant ?? base.promptVariant,
    doomLoopThreshold: known.doomLoopThreshold ?? base.doomLoopThreshold,
    supportsParallelToolCalls: known.supportsParallelToolCalls ?? base.supportsParallelToolCalls,
    constrainToolArgs: base.constrainToolArgs,           // always true for local
    supportsTools: known.supportsTools ?? base.supportsTools,
  };
}
