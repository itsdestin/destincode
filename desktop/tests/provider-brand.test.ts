// desktop/tests/provider-brand.test.ts
import { describe, it, expect } from 'vitest';
import { resolveModelBrand } from '../src/renderer/components/provider-brand';

describe('resolveModelBrand', () => {
  it('detects Qwen from model IDs containing version numbers or suffixes', () => {
    expect(resolveModelBrand('qwen2.5-coder:14b')?.icon).toBe('qwen');
    expect(resolveModelBrand('qwen3-30b-a3b')?.icon).toBe('qwen');
    expect(resolveModelBrand('qwen/qwen-2.5-72b-instruct')?.icon).toBe('qwen');
    expect(resolveModelBrand('qwq-32b-preview')?.icon).toBe('qwen');
  });

  it('detects OpenAI / GPT models', () => {
    expect(resolveModelBrand('openai/gpt-5.6-sol')?.icon).toBe('openai');
    expect(resolveModelBrand('gpt-4o')?.icon).toBe('openai');
    expect(resolveModelBrand('o3-mini')?.icon).toBe('openai');
  });

  it('detects Anthropic / Claude models', () => {
    expect(resolveModelBrand('anthropic/claude-sonnet-4-6')?.icon).toBe('anthropic');
    expect(resolveModelBrand('claude-3-5-sonnet-20241022')?.icon).toBe('anthropic');
    expect(resolveModelBrand('opus')?.icon).toBe('anthropic');
    expect(resolveModelBrand('claude-sonnet-4-6')?.color).toBe('var(--brand-claude)');
  });

  it('detects Google / Gemini / Gemma models', () => {
    expect(resolveModelBrand('google/gemini-2.5-flash')?.icon).toBe('google');
    expect(resolveModelBrand('gemma-2-9b-it')?.icon).toBe('google');
    expect(resolveModelBrand('google/gemini-2.5-flash')?.color).toBe('var(--brand-google)');
  });

  it('detects Grok / xAI models', () => {
    expect(resolveModelBrand('x-ai/grok-3')?.icon).toBe('grok');
    expect(resolveModelBrand('grok-2-1212')?.icon).toBe('grok');
    expect(resolveModelBrand('grok-beta')?.color).toBe('var(--brand-grok)');
  });

  it('detects Kimi / Moonshot models', () => {
    expect(resolveModelBrand('moonshot/kimi-k1.5')?.icon).toBe('kimi');
    expect(resolveModelBrand('kimi-latest')?.icon).toBe('kimi');
    expect(resolveModelBrand('moonshot-v1-8k')?.color).toBe('var(--brand-kimi)');
  });

  it('detects DeepSeek models', () => {
    expect(resolveModelBrand('deepseek/deepseek-r1')?.icon).toBe('deepseek');
    expect(resolveModelBrand('deepseek-chat')?.icon).toBe('deepseek');
    expect(resolveModelBrand('deepseek-v3')?.color).toBe('var(--brand-deepseek)');
  });

  it('detects Meta / Llama models', () => {
    expect(resolveModelBrand('meta-llama/llama-3-70b-instruct')?.icon).toBe('meta');
    expect(resolveModelBrand('llama-3.3-70b')?.icon).toBe('meta');
    expect(resolveModelBrand('meta-llama/llama-4')?.color).toBe('var(--brand-meta)');
  });

  it('detects Mistral / Codestral models', () => {
    expect(resolveModelBrand('mistral/codestral-2501')?.icon).toBe('mistral');
    expect(resolveModelBrand('mistral-large-2411')?.icon).toBe('mistral');
    expect(resolveModelBrand('pixtral-12b')?.color).toBe('var(--brand-mistral)');
  });

  it('detects Perplexity models', () => {
    expect(resolveModelBrand('perplexity/sonar-reasoning')?.icon).toBe('perplexity');
    expect(resolveModelBrand('sonar-pro')?.color).toBe('var(--brand-perplexity)');
  });

  it('detects Cohere models', () => {
    expect(resolveModelBrand('cohere/command-r-plus')?.icon).toBe('cohere');
    expect(resolveModelBrand('command-r')?.color).toBe('var(--brand-cohere)');
  });

  it('falls back to null for unrecognized models', () => {
    expect(resolveModelBrand('custom-endpoint-unknown-model-xyz')).toBeNull();
    expect(resolveModelBrand(undefined)).toBeNull();
  });
});
