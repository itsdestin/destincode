// desktop/tests/native-model-label.test.ts
import { describe, it, expect } from 'vitest';
import { nativeModelLabel } from '../src/renderer/components/native-model-label';

describe('nativeModelLabel', () => {
  it('strips the vendor prefix and the redundant leading "claude"', () => {
    expect(nativeModelLabel('anthropic/claude-sonnet-5')).toBe('Sonnet 5');
    expect(nativeModelLabel('anthropic/claude-opus-4-8')).toBe('Opus 4.8');
  });

  it('title-cases plain hyphenated slugs', () => {
    expect(nativeModelLabel('google/gemini-3-pro')).toBe('Gemini 3 Pro');
    expect(nativeModelLabel('my-custom-endpoint-model')).toBe('My Custom Endpoint Model');
  });

  it('upper-cases known acronyms', () => {
    expect(nativeModelLabel('openai/gpt-5.2')).toBe('GPT 5.2');
    expect(nativeModelLabel('x-ai/grok-4.5')).toBe('Grok 4.5');
  });

  it('preserves author casing on tokens that already carry case or digits', () => {
    expect(nativeModelLabel('Qwen3-30B-A3B')).toBe('Qwen3 30B A3B');
    expect(nativeModelLabel('meta-llama/llama-4-70b-instruct')).toBe('Llama 4 70b Instruct');
  });

  it('drops weight-file extensions and quantization suffixes (local GGUF)', () => {
    expect(nativeModelLabel('Qwen3-30B-A3B-Q4_K_M.gguf')).toBe('Qwen3 30B A3B');
    expect(nativeModelLabel('mistral-7b-instruct-IQ4_XS.gguf')).toBe('Mistral 7b Instruct');
    expect(nativeModelLabel('llama-3-8b-BF16.safetensors')).toBe('Llama 3 8b');
  });

  it('handles a local absolute-path-ish id by using the final segment', () => {
    expect(nativeModelLabel('/models/local/phi-4-mini.gguf')).toBe('Phi 4 Mini');
  });

  // Guard the degenerate cases: the chip must never render blank for a bound
  // model, because a blank chip is indistinguishable from "no session".
  it('falls back to the bare tail when every token is noise', () => {
    expect(nativeModelLabel('Q4_K_M.gguf')).toBe('Q4_K_M');
  });

  it('returns empty string only for a genuinely absent id', () => {
    expect(nativeModelLabel(undefined)).toBe('');
    expect(nativeModelLabel(null)).toBe('');
    expect(nativeModelLabel('')).toBe('');
  });

  it('keeps a non-leading vendor word', () => {
    expect(nativeModelLabel('foo-claude')).toBe('Foo Claude');
  });
});
