// Pins the split-GGUF id rules. A split set is ONE model addressed through part
// 00001; the 2026-08-27 bug was the picker offering parts 2..4 as their own
// models, each of which 500'd on selection.
import { describe, it, expect } from 'vitest';
import { isFollowerPart, stripSplitSuffix } from '../src/shared/gguf-split';

describe('isFollowerPart', () => {
  it('is false for the first part — that is the whole model address', () => {
    expect(isFollowerPart('Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004')).toBe(false);
  });

  it('is true for every later part', () => {
    for (const n of ['00002', '00003', '00004']) {
      expect(isFollowerPart(`Qwen3.8-Flash-Next-UD-Q4_K_XL-${n}-of-00004`)).toBe(true);
    }
  });

  it('is false for a single-file model', () => {
    expect(isFollowerPart('Qwen3.8-27B-UD-Q8_K_XL')).toBe(false);
    expect(isFollowerPart('gemma-4-E2B-it-Q8_0')).toBe(false);
  });

  it('ignores part-shaped text that is not the trailing suffix', () => {
    expect(isFollowerPart('weird-00002-of-00004-model')).toBe(false);
  });

  it('needs the exact five-digit shape', () => {
    expect(isFollowerPart('model-2-of-4')).toBe(false);
    expect(isFollowerPart('model-000002-of-000004')).toBe(false);
  });
});

describe('stripSplitSuffix', () => {
  it('drops the part marker', () => {
    expect(stripSplitSuffix('Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004'))
      .toBe('Qwen3.8-Flash-Next-UD-Q4_K_XL');
  });

  it('leaves a single-file id alone', () => {
    expect(stripSplitSuffix('Qwen3.5-9B-Q8_0')).toBe('Qwen3.5-9B-Q8_0');
  });

  it('never returns empty — an id that is ONLY a part marker keeps itself', () => {
    expect(stripSplitSuffix('-00001-of-00004')).toBe('-00001-of-00004');
  });
});
