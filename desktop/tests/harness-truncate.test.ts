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
});
