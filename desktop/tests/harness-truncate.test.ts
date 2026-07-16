import { describe, it, expect } from 'vitest';
import { truncateOutput } from '../src/main/harness/tools/truncate';

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
    expect(r.text).toContain('[truncated');
    expect(r.text).toContain('50000 chars total');
  });
  it('caps line count too', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const r = truncateOutput(many, { maxChars: 1_000_000, maxLines: 100 });
    expect(r.text.split('\n').length).toBeLessThanOrEqual(102); // 100 + trailer
    expect(r.text).toContain('[truncated');
  });
  it('never grows the output at tiny caps (slice(-0) guard)', () => {
    // maxChars <= 4 => Math.floor(maxChars*0.2) === 0; slice(-0) would return
    // the WHOLE string and make output larger than the input. Must stay shorter.
    const big = 'y'.repeat(100);
    const r = truncateOutput(big, { maxChars: 3 });
    expect(r.truncated).toBe(true);
    const trailerLen = r.text.length - r.text.indexOf('\n[truncated');
    expect(r.text.length - trailerLen).toBeLessThan(big.length);

    // maxLines <= 4 => same defect on the line path.
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const r2 = truncateOutput(many, { maxChars: 1_000_000, maxLines: 2 });
    expect(r2.truncated).toBe(true);
    const trailer2 = r2.text.length - r2.text.indexOf('\n[truncated');
    expect(r2.text.length - trailer2).toBeLessThan(many.length);
  });
});
