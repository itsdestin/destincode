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
