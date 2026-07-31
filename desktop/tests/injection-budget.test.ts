// A 600-word rule can blow a small model's window (program §4 item 5). Injected
// content is therefore bounded by the profile, and when it is cut the model is
// TOLD it was cut — silently truncated instructions are worse than none, because
// the model follows half a procedure believing it has the whole thing.
import { describe, it, expect } from 'vitest';
import { fitInjection } from '../src/main/harness/injection/injection-budget';

describe('fitInjection', () => {
  it('passes short content through untouched', () => {
    const r = fitInjection('short', 1000);
    expect(r.text).toBe('short');
    expect(r.truncated).toBe(false);
  });

  it('cuts content that exceeds the budget', () => {
    const r = fitInjection('x'.repeat(40_000), 1_000);   // ~10k tokens against a 1k budget
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(40_000);
  });

  it('SAYS it was cut — a silent cut makes the model follow half a procedure', () => {
    expect(fitInjection('x'.repeat(40_000), 1_000).text).toMatch(/truncated/i);
  });

  it('keeps the result within the budget, notice included', () => {
    // The notice must not be what pushes the payload back over the line.
    const budgetTokens = 1_000;
    const r = fitInjection('x'.repeat(40_000), budgetTokens);
    expect(r.text.length).toBeLessThanOrEqual(budgetTokens * 4);
  });

  it('a zero budget still yields the notice, never a bare empty string', () => {
    const r = fitInjection('x'.repeat(1000), 0);
    expect(r.text).toMatch(/truncated/i);
    expect(r.truncated).toBe(true);
  });

  it('a negative budget is treated as zero rather than producing a huge slice', () => {
    const r = fitInjection('x'.repeat(1000), -50);
    expect(r.truncated).toBe(true);
    expect(r.text).toMatch(/truncated/i);
  });

  it('keeps the BEGINNING of the content — procedures start with step one', () => {
    const r = fitInjection('FIRST-LINE' + 'x'.repeat(40_000), 1_000);
    expect(r.text.startsWith('FIRST-LINE')).toBe(true);
  });
});
