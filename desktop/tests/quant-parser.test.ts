import { describe, it, expect } from 'vitest';
import { parseGgufName, groupQuantOptions, quantDescription } from '../src/main/models/quant-parser';

describe('parseGgufName', () => {
  it('parses standard quants', () => {
    expect(parseGgufName('Qwen3-4B-Instruct-2507-Q4_K_M.gguf')).toEqual({
      base: 'Qwen3-4B-Instruct-2507', quant: 'Q4_K_M', dynamic: false, part: null,
    });
    expect(parseGgufName('gemma-3-12b-it-Q8_0.gguf')?.quant).toBe('Q8_0');
    expect(parseGgufName('model-IQ2_XXS.gguf')?.quant).toBe('IQ2_XXS');
    expect(parseGgufName('model-F16.gguf')?.quant).toBe('F16');
    expect(parseGgufName('model-BF16.gguf')?.quant).toBe('BF16');
    // MXFP4 / MXFP4_MOE — gpt-oss / MoE native format (Amendment 2026-07-14 E).
    expect(parseGgufName('gpt-oss-20b-MXFP4.gguf')?.quant).toBe('MXFP4');
    expect(parseGgufName('gemma-4-26B-A4B-it-MXFP4_MOE.gguf')?.quant).toBe('MXFP4_MOE');
  });

  it('parses unsloth dynamic quants (UD- prefix)', () => {
    expect(parseGgufName('Qwen3-14B-UD-Q4_K_XL.gguf')).toEqual({
      base: 'Qwen3-14B', quant: 'UD-Q4_K_XL', dynamic: true, part: null,
    });
    expect(parseGgufName('gemma-3-27b-it-UD-IQ2_XXS.gguf')?.quant).toBe('UD-IQ2_XXS');
  });

  it('parses multi-part split suffixes', () => {
    expect(parseGgufName('Llama-4-Scout-17B-16E-Instruct-UD-Q4_K_XL-00001-of-00002.gguf')).toEqual({
      base: 'Llama-4-Scout-17B-16E-Instruct', quant: 'UD-Q4_K_XL', dynamic: true,
      part: { index: 1, of: 2 },
    });
  });

  it('DENYLISTS aux files — vision projectors + MTP draft models (real shapes)', () => {
    // Real repos ship UPPERCASE mmproj projectors next to the chat model. The
    // old regex parsed 'mmproj-BF16.gguf' as a "BF16" quant AND collided with
    // the real '<model>-BF16.gguf', dropping BOTH. Denylist by basename prefix.
    expect(parseGgufName('mmproj-BF16.gguf')).toBeNull();
    expect(parseGgufName('mmproj-F16.gguf')).toBeNull();
    expect(parseGgufName('mmproj-F32.gguf')).toBeNull();
    // MTP speculative-decode draft models — in an 'MTP/' subfolder and/or an
    // 'mtp-' basename. Not chat models. Basename check catches both.
    expect(parseGgufName('MTP/mtp-gemma-4-12B-it-Q4_0.gguf')).toBeNull();
    expect(parseGgufName('mtp-gemma-4-12B-it.gguf')).toBeNull();
    // Unrecognized / non-gguf → null (drop silently — Amendment 2026-07-14 E).
    expect(parseGgufName('README.md')).toBeNull();
  });
});

describe('groupQuantOptions', () => {
  // Real tree shape for ONE model: single quants at root, a multi-part set
  // under a per-quant subfolder (gpt-oss convention), an mmproj projector
  // (uppercase — must be excluded), and a README.
  const files = [
    { path: 'M-Q4_K_M.gguf', size: 9_000, sha256: 'a'.repeat(64) },
    { path: 'M-BF16.gguf', size: 30_000, sha256: 'd'.repeat(64) },
    { path: 'Q8_0/M-Q8_0-00001-of-00002.gguf', size: 5_000, sha256: 'c'.repeat(64) },
    { path: 'Q8_0/M-Q8_0-00002-of-00002.gguf', size: 4_000, sha256: null },
    { path: 'mmproj-BF16.gguf', size: 500, sha256: 'e'.repeat(64) },   // aux — must be excluded
    { path: 'README.md', size: 10, sha256: null },
  ];

  it('groups by quant, orders multi-part sets, sums sizes, excludes aux', () => {
    const opts = groupQuantOptions(files);
    // Multi-part set grouped in order, sizes summed.
    const q8 = opts.find((o) => o.quant === 'Q8_0')!;
    expect(q8.files).toEqual([
      'Q8_0/M-Q8_0-00001-of-00002.gguf',
      'Q8_0/M-Q8_0-00002-of-00002.gguf',
    ]);
    expect(q8.totalSizeBytes).toBe(9_000);
    expect(q8.sha256ByFile['Q8_0/M-Q8_0-00002-of-00002.gguf']).toBeNull();
    expect(opts.find((o) => o.quant === 'Q4_K_M')!.totalSizeBytes).toBe(9_000);
    // The REAL BF16 survives — mmproj-BF16 was denylisted, NOT merged into it
    // (the collision that dropped both in the pre-hardening parser).
    const bf16 = opts.find((o) => o.quant === 'BF16')!;
    expect(bf16.files).toEqual(['M-BF16.gguf']);
    expect(bf16.totalSizeBytes).toBe(30_000);
    expect(opts.some((o) => o.quant === 'README')).toBe(false);
    expect(opts.every((o) => !o.files.some((f) => f.includes('mmproj')))).toBe(true);
  });

  it('drops INCOMPLETE multi-part sets (a missing part = undownloadable)', () => {
    const partial = [{ path: 'M-UD-Q4_K_XL-00002-of-00002.gguf', size: 1, sha256: null }];
    expect(groupQuantOptions(partial)).toEqual([]);
  });
});

describe('quantDescription', () => {
  it('maps quant families to plain language', () => {
    expect(quantDescription('Q8_0')).toMatch(/highest quality/i);
    expect(quantDescription('UD-Q4_K_XL')).toMatch(/recommended/i);
    expect(quantDescription('IQ2_XXS')).toMatch(/smallest/i);
    expect(quantDescription('F16')).toMatch(/original/i);
    expect(quantDescription('MXFP4')).toMatch(/native/i);
    expect(quantDescription('MXFP4_MOE')).toMatch(/native/i);
  });
});
