import { describe, it, expect } from 'vitest';
import { truncateOutput, composeNotice } from '../src/main/harness/tools/truncate';
import type { ResultBounds } from '../src/main/harness/tools/types';

describe('truncateOutput', () => {
  it('passes short output through untouched', () => {
    const r = truncateOutput('hello', { maxChars: 100 });
    expect(r.text).toBe('hello');
    expect(r.truncated).toBe(false);
  });
  it('keeps head + tail and appends an actionable trailer', () => {
    const big = 'x'.repeat(50_000);
    const r = truncateOutput(big, { maxChars: 10_000 });
    expect(r.text.length).toBeLessThan(11_000);
    expect(r.truncated).toBe(true);
    // The trailer moved to composeNotice (rendered by defineTool). truncateOutput
    // now only reports the fact; it never writes advice into the text itself.
    expect(r.totalChars).toBe(50_000);
  });
  it('caps line count too', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const r = truncateOutput(many, { maxChars: 1_000_000, maxLines: 100 });
    expect(r.text.split('\n').length).toBeLessThanOrEqual(102); // 80 (head) + 1 (omitted marker) + 20 (tail)
    expect(r.truncated).toBe(true);
  });
  it('never grows the output at tiny caps (slice(-0) guard)', () => {
    // maxChars <= 4 => Math.floor(maxChars*0.2) === 0; slice(-0) would return
    // the WHOLE string and make output larger than the input. Must stay shorter.
    const big = 'y'.repeat(100);
    const r = truncateOutput(big, { maxChars: 3 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(big.length);

    // maxLines <= 4 => same defect on the line path.
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const r2 = truncateOutput(many, { maxChars: 1_000_000, maxLines: 2 });
    expect(r2.truncated).toBe(true);
    expect(r2.text.length).toBeLessThan(many.length);
  });
});

describe('composeNotice', () => {
  const bounds: ResultBounds = { shown: 500, total: 1200, unit: 'matches', moreHint: 'narrow the pattern' };

  it('renders nothing when neither a tool bound nor a cap fired', () => {
    expect(composeNotice(undefined, null)).toBe('');
  });

  it('renders a declared bound with the tool\'s own hint', () => {
    expect(composeNotice(bounds, null)).toBe(
      '\n[showing 500 of 1200 matches — narrow the pattern]',
    );
  });

  it('renders an unknown total as "at least", never as a fabricated number', () => {
    const open: ResultBounds = { shown: 2000, total: null, unit: 'files', moreHint: 'narrow the glob' };
    expect(composeNotice(open, null)).toBe(
      '\n[showing 2000 of at least 2000 files — narrow the glob]',
    );
  });

  it('names both facts in ONE line when a tool bound and a cap both fire', () => {
    const out = composeNotice(bounds, { shown: 30_000, total: 4_200_000 });
    expect(out.split('\n').filter(Boolean)).toHaveLength(1);
    expect(out).toContain('30000 of 4200000 chars');
    expect(out).toContain('500 of 1200 matches');
    expect(out).toContain('narrow the pattern');
  });

  it('never invents advice when a cap fires and the tool declared no bounds', () => {
    const out = composeNotice(undefined, { shown: 30_000, total: 90_000 });
    expect(out).toBe('\n[output truncated: showing 30000 of 90000 chars]');
    expect(out).not.toContain('offset');
    expect(out).not.toContain('limit');
  });
});

describe('truncateOutput reports the true input size', () => {
  it('returns totalChars of the ORIGINAL text, not the retained slice', () => {
    const big = 'x'.repeat(50_000);
    const r = truncateOutput(big, { maxChars: 10_000 });
    expect(r.truncated).toBe(true);
    expect(r.totalChars).toBe(50_000);
  });

  it('no longer appends its own advice string', () => {
    const big = 'x'.repeat(50_000);
    const r = truncateOutput(big, { maxChars: 10_000 });
    expect(r.text).not.toContain('offset/limit');
    expect(r.text).not.toContain('[truncated —');
  });
});
