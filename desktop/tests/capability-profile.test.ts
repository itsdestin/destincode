import { describe, it, expect } from 'vitest';
import { resolveProfile, effectiveContextForModel, CLOUD_DEFAULT, type DiscoveredModel } from '../src/main/harness/capability-profile';
import type { KnownModelEntry } from '../src/main/harness/known-models';

const local = (modelId: string, contextLength: number | null): DiscoveredModel => ({ providerType: 'local-engine', modelId, contextLength });

describe('resolveProfile — Layer selection', () => {
  it('cloud provider → full presentation, variant by type, no local constraint', () => {
    const a = resolveProfile({ providerType: 'anthropic', modelId: 'x', contextLength: 200_000 });
    expect(a.maxToolPresentation).toBe('full');
    expect(a.promptVariant).toBe('anthropic');
    expect(a.constrainToolArgs).toBe(false);
    expect(a.supportsTools).toBe(true);
    expect(resolveProfile({ providerType: 'openai', modelId: 'x', contextLength: 128_000 }).promptVariant).toBe('gpt');
    expect(resolveProfile({ providerType: 'openrouter', modelId: 'x', contextLength: 128_000 }).promptVariant).toBe('default');
  });

  it('unknown local model → conservative fallback tiered by REAL context window', () => {
    const small = resolveProfile(local('mystery-3b', 8_192));
    expect(small.maxToolPresentation).toBe('simplified');
    expect(small.promptVariant).toBe('local-small');
    expect(small.doomLoopThreshold).toBe(2);
    expect(small.supportsParallelToolCalls).toBe(false);
    expect(small.constrainToolArgs).toBe(true);

    const large = resolveProfile(local('mystery-120b', 131_072));
    expect(large.maxToolPresentation).toBe('full');
    expect(large.promptVariant).toBe('default');
    expect(large.doomLoopThreshold).toBe(3);
  });

  it('a KNOWN local model overlays registry tuning on the fallback (MoE ≠ dense at the same window)', () => {
    const registry: KnownModelEntry[] = [
      { match: 'qwen3\\.6.*35b.*moe', label: 'Qwen 3.6 35B MoE', maxToolPresentation: 'full', doomLoopThreshold: 3, supportsTools: true },
      { match: 'qwen3\\.5.*9b',       label: 'Qwen 3.5 9B',      maxToolPresentation: 'simplified', doomLoopThreshold: 2, supportsTools: true },
    ];
    const moe = resolveProfile(local('qwen3.6-35b-moe-q4', 32_768), registry);
    const dense = resolveProfile(local('qwen3.5-9b-q4', 32_768), registry);
    expect(moe.maxToolPresentation).toBe('full');
    expect(dense.maxToolPresentation).toBe('simplified');
    expect(moe.constrainToolArgs).toBe(true);
  });

  it('a registry entry marking supportsTools:false runs the model as plain chat', () => {
    const registry: KnownModelEntry[] = [{ match: 'no-tools-model', label: 'X', supportsTools: false }];
    expect(resolveProfile(local('no-tools-model', 8_192), registry).supportsTools).toBe(false);
  });

  it('null/unknown context is treated as small (conservative)', () => {
    expect(resolveProfile(local('x', null)).maxToolPresentation).toBe('simplified');
  });
});

describe('effectiveContextForModel', () => {
  const reg = [{ match: 'tiny-model', label: 'Tiny', maxContextWindow: 8192, supportsTools: true }];
  it('clamps a loaded window down to a known model ceiling', () => {
    expect(effectiveContextForModel(32_768, 'tiny-model-q4', reg)).toBe(8192);
  });
  it('passes through when loaded is under the ceiling or the model is unknown', () => {
    expect(effectiveContextForModel(4096, 'tiny-model-q4', reg)).toBe(4096);
    expect(effectiveContextForModel(32_768, 'unknown-model', reg)).toBe(32_768);
  });
  it('uses the ceiling when the loaded window is unknown', () => {
    expect(effectiveContextForModel(null, 'tiny-model-q4', reg)).toBe(8192);
    expect(effectiveContextForModel(null, 'unknown-model', reg)).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// M3 item 5 — capability-gated injection.
//
// Two new fields decide how much the model may be handed mid-session: whether
// the Skill tool's catalog (which rides the tool schema on EVERY turn) is
// affordable at all, and how many tokens a single injection may occupy.
// ---------------------------------------------------------------------------
describe('capability profile — injection sizing (M3 item 5)', () => {
  it('a large local window gets the skill catalog and a generous budget', () => {
    const p = resolveProfile(local('qwen3.6-122b', 128_000));
    expect(p.exposeSkillCatalog).toBe(true);
    expect(p.injectionBudgetTokens).toBeGreaterThan(10_000);
  });

  it('a small local window does NOT — the catalog rides every single turn', () => {
    const p = resolveProfile(local('gemma-3n', 8_192));
    expect(p.exposeSkillCatalog).toBe(false);
    expect(p.injectionBudgetTokens).toBeLessThan(4_000);
  });

  it('a mid local window gets the catalog but a tighter injection budget', () => {
    const p = resolveProfile(local('some-35b', 64_000));
    expect(p.exposeSkillCatalog).toBe(true);
    expect(p.injectionBudgetTokens).toBeLessThan(10_000);
  });

  it('an UNMEASURED local window is treated as small — never assume room', () => {
    const p = resolveProfile(local('mystery', null));
    expect(p.exposeSkillCatalog).toBe(false);
  });

  it('an openai-compatible endpoint is sized like local — it is usually Ollama', () => {
    // provider-registry documents this type as "Ollama / LM Studio run keyless".
    // Treating an unmeasured one as roomy would hand a 4k model a skill catalog.
    const p = resolveProfile({ providerType: 'openai-compatible', modelId: 'whatever', contextLength: null });
    expect(p.exposeSkillCatalog).toBe(false);
  });

  it('a FRONTIER provider stays generous even with no measured window', () => {
    // We never discover Anthropic's window, so null there means "not measured",
    // not "small" — sizing it down would break the main use case.
    for (const providerType of ['anthropic', 'openai', 'google', 'openrouter'] as const) {
      const p = resolveProfile({ providerType, modelId: 'm', contextLength: null });
      expect(p.exposeSkillCatalog, providerType).toBe(true);
      expect(p.injectionBudgetTokens, providerType).toBeGreaterThan(10_000);
    }
  });

  it('the registry ceiling sizes a model loaded past its real window', () => {
    // A 8k model loaded at -c 128000 must not be judged roomy: sizing runs on the
    // EFFECTIVE window, the same clamp the rest of the profile uses.
    const reg = [{ match: 'tiny-model', label: 'Tiny', maxContextWindow: 8192, supportsTools: true }];
    const p = resolveProfile(local('tiny-model-q4', 128_000), reg);
    expect(p.exposeSkillCatalog).toBe(false);
  });

  it('the cloud default carries the catalog and a large budget', () => {
    expect(CLOUD_DEFAULT.exposeSkillCatalog).toBe(true);
    expect(CLOUD_DEFAULT.injectionBudgetTokens).toBeGreaterThan(10_000);
  });
});

// ---------------------------------------------------------------------------
// Capability vs room. Destin ran Qwen 3.5 2B with `-c 128000`, and it got the
// full Skill catalog and spent its turn reciting all twelve skills. Window size
// answers "can it afford the catalog?", not "should it be choosing skills?".
// ---------------------------------------------------------------------------
describe('capability gating — a big window does not make a small model capable', () => {
  it('a 2B model with a 128k window does NOT get the skill catalog', () => {
    const p = resolveProfile(local('Qwen3.5-2B-Q8_0', 128_000));
    expect(p.maxToolPresentation).toBe('simplified');
    expect(p.exposeSkillCatalog).toBe(false);
  });

  it('a model marked simplified never gets it, however much room it has', () => {
    const reg = [{ match: 'weak-model', label: 'Weak', maxToolPresentation: 'simplified' as const, supportsTools: true }];
    expect(resolveProfile(local('weak-model-q8', 1_000_000), reg).exposeSkillCatalog).toBe(false);
  });

  it('a capable local model with room still gets it', () => {
    const reg = [{ match: 'strong-model', label: 'Strong', maxToolPresentation: 'full' as const, supportsTools: true }];
    expect(resolveProfile(local('strong-model-q8', 128_000), reg).exposeSkillCatalog).toBe(true);
  });

  it('a capable model with a SMALL window still does not — room is still required', () => {
    const reg = [{ match: 'strong-model', label: 'Strong', maxToolPresentation: 'full' as const, supportsTools: true }];
    expect(resolveProfile(local('strong-model-q8', 8_192), reg).exposeSkillCatalog).toBe(false);
  });

  it('the injection BUDGET still tracks the window, not capability', () => {
    // A weak model with a big window can still be handed a long skill body by
    // /skill-name — it just is not trusted to pick one unprompted.
    const p = resolveProfile(local('Qwen3.5-2B-Q8_0', 128_000));
    expect(p.injectionBudgetTokens).toBeGreaterThan(10_000);
  });

  it('cloud models are unaffected', () => {
    expect(resolveProfile({ providerType: 'anthropic', modelId: 'm', contextLength: null }).exposeSkillCatalog).toBe(true);
  });
});
