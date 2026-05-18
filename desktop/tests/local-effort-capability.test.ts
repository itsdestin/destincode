import { describe, it, expect } from 'vitest';
import {
  getSupportedEffortLevels,
  clampEffortToSupported,
  getModelCapability,
} from '../src/shared/local-effort-capability';

describe('getSupportedEffortLevels', () => {
  it('returns Off-only for qwen3.5 family — known-flaky on Ollama', () => {
    // 5+ open Ollama bugs against qwen3.5 (#14748, 14759, 14745, 14621, 14867):
    // model-runner crashes, OCR hangs, tool-call leakage. Until upstream
    // stabilizes, expose Off-only so users don't trigger known-broken paths.
    expect([...getSupportedEffortLevels('qwen3.5:9b')]).toEqual(['none']);
    expect([...getSupportedEffortLevels('qwen3.5:4b')]).toEqual(['none']);
    expect([...getSupportedEffortLevels('qwen3.5:9b@on')]).toEqual(['none']);
  });

  it('returns binary on/off for qwen3 family — Ollama translates effort→think:bool', () => {
    // Updated 2026-05-11 after research: low/med/high all collapse to
    // think:true upstream. UI exposes Off/On only.
    expect([...getSupportedEffortLevels('qwen3:8b')].sort()).toEqual(['none', 'on']);
    expect([...getSupportedEffortLevels('qwen3:14b@on')].sort()).toEqual(['none', 'on']);
  });

  it('returns binary on/off for gemma 4 family', () => {
    // Verified by probe 2026-05-06: low/med/high produce ~1700 char reasoning
    // regardless of level (no depth scaling). Per Ollama docs only gpt-oss
    // honors tiered budgets.
    expect([...getSupportedEffortLevels('gemma4:e2b')].sort()).toEqual(['none', 'on']);
    expect([...getSupportedEffortLevels('gemma4:e4b')].sort()).toEqual(['none', 'on']);
    expect([...getSupportedEffortLevels('gemma4:e2b@on')].sort()).toEqual(['none', 'on']);
  });

  it('returns binary on/off for deepseek-r1 — reasoning specialist', () => {
    // DeepSeek-R1 distills always think; the chip still exposes On/Off so
    // users can see the toggle, even though Off doesn't fully disable
    // thinking on this model.
    expect([...getSupportedEffortLevels('deepseek-r1:8b')].sort()).toEqual(['none', 'on']);
  });

  it('returns Off-only for non-thinking models (default)', () => {
    // Conservative allowlist — most Ollama models don't support thinking
    // at all, and exposing On would produce errors or hangs.
    expect([...getSupportedEffortLevels('gemma3:4b')]).toEqual(['none']);
    expect([...getSupportedEffortLevels('llama3.1:8b')]).toEqual(['none']);
    expect([...getSupportedEffortLevels('llama3.2:3b')]).toEqual(['none']);
    expect([...getSupportedEffortLevels('phi4-mini:3.8b')]).toEqual(['none']);
    expect([...getSupportedEffortLevels('mistral:7b')]).toEqual(['none']);
    expect([...getSupportedEffortLevels('qwen2.5:7b')]).toEqual(['none']);
    expect([...getSupportedEffortLevels('qwen2.5-coder:7b')]).toEqual(['none']);
  });

  it('returns On/Off for empty/unknown — defensive only', () => {
    // The form might call this before a model is selected; we don't want
    // to flash all-disabled buttons. Empty-input falls through to the
    // permissive default (binary). Real model ids fall through to the
    // conservative allowlist default (['none']).
    expect([...getSupportedEffortLevels('')].sort()).toEqual(['none', 'on']);
  });
});

describe('getModelCapability', () => {
  it('marks qwen3 as variant-mechanism', () => {
    const cap = getModelCapability('qwen3:8b');
    expect(cap.mechanism).toBe('variant');
  });

  it('marks qwen3.5 as variant-mechanism (Off-only in practice)', () => {
    // Mechanism is still 'variant' because the @on encoding is preserved
    // for parsing parity, even though only 'none' is exposed in the UI.
    // If upstream stabilizes the qwen3.5 bugs, bumping levels is a 1-line
    // change with no SessionManager logic shift.
    const cap = getModelCapability('qwen3.5:9b');
    expect(cap.mechanism).toBe('variant');
  });

  it('marks gemma4 as variant mechanism (reasoning_effort via opencode.json variants)', () => {
    const cap = getModelCapability('gemma4:e2b');
    expect(cap.mechanism).toBe('variant');
  });

  it('marks deepseek-r1 as variant mechanism', () => {
    const cap = getModelCapability('deepseek-r1:8b');
    expect(cap.mechanism).toBe('variant');
  });

  it('marks unknown / non-thinking models with none-mechanism', () => {
    expect(getModelCapability('llama3.1:8b').mechanism).toBe('none');
    expect(getModelCapability('qwen2.5:7b').mechanism).toBe('none');
    expect(getModelCapability('mistral:7b').mechanism).toBe('none');
  });
});

describe('clampEffortToSupported', () => {
  it('passes through supported effort unchanged', () => {
    expect(clampEffortToSupported('qwen3:8b', 'on')).toBe('on');
    expect(clampEffortToSupported('gemma4:e2b', 'on')).toBe('on');
    expect(clampEffortToSupported('qwen3.5:9b', 'none')).toBe('none');
  });

  it('clamps unsupported effort to none', () => {
    // qwen3.5 doesn't expose 'on' currently — clamp On→Off.
    expect(clampEffortToSupported('qwen3.5:9b', 'on')).toBe('none');
    // Non-thinking model: any non-none effort clamps to none.
    expect(clampEffortToSupported('llama3.1:8b', 'on')).toBe('none');
    expect(clampEffortToSupported('qwen2.5:7b', 'on')).toBe('none');
  });

  it('preserves "none" universally — every model supports Off', () => {
    expect(clampEffortToSupported('qwen3:8b', 'none')).toBe('none');
    expect(clampEffortToSupported('gemma4:e2b', 'none')).toBe('none');
    expect(clampEffortToSupported('llama3.1:8b', 'none')).toBe('none');
    expect(clampEffortToSupported('', 'none')).toBe('none');
  });
});
