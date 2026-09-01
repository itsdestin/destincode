import { describe, it, expect } from 'vitest';
import { makeOpenRouterFactory } from '../src/main/harness/eval/openrouter-factory';
import { openRouterCostExtractor } from '../src/main/harness/pricing';

// ROADMAP L161. The evaluator builds its own OpenRouter handle (never through
// provider-registry.ts — live-app-safety), so the app's pin that OpenRouter
// reads its own cost off the wire (provider-registry.test.ts) did not cover
// it. Without the extractor every cell's `metrics.providerCostUsd` is absent
// and the report falls back to saying nothing about what a round really cost.
describe('makeOpenRouterFactory', () => {
  it('asks the SDK to read OpenRouter’s own per-request cost off the wire', async () => {
    const model = await makeOpenRouterFactory('sk-or-test', 'openai/gpt-4o')({} as any);
    expect((model as any).config.metadataExtractor).toBe(openRouterCostExtractor);
  });

  it('refuses to build a handle with no key, before any request', () => {
    expect(() => makeOpenRouterFactory('', 'openai/gpt-4o')).toThrow(/OpenRouter key/);
  });
});
