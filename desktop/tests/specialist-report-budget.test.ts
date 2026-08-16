import { describe, it, expect } from 'vitest';
import { computeReportBudget } from '../src/main/harness/specialists/report-budget';

// The headroom-aware report cap (spec §3, Task 7). The whole point of the
// formula is that a child's report is sized against what the PARENT can still
// afford, not against a fixed number — see report-budget.ts for the Hermes
// fan-out blowout this prevents.
describe('computeReportBudget', () => {
  it('caps at the static budget when the parent has room', () =>
    expect(computeReportBudget({ staticCapTokens: 2000, parentRemainingTokens: 50_000, concurrentReporters: 1 })).toBe(2000));

  it('shrinks with parent headroom divided across reporters', () =>
    expect(computeReportBudget({ staticCapTokens: 2000, parentRemainingTokens: 8_000, concurrentReporters: 4 }))
      .toBe(Math.floor((8_000 * 0.5) / 4)));   // fraction 0.5, spec §3 (Hermes)

  it('never returns below a floor of 200 tokens', () =>
    expect(computeReportBudget({ staticCapTokens: 2000, parentRemainingTokens: 400, concurrentReporters: 4 })).toBe(200));

  // The host passes Infinity when it cannot measure the parent's occupancy
  // (no step has reported usage yet) — "unknown headroom" must degrade to the
  // static cap, never to the 200-token floor, or an unmeasurable parent would
  // silently truncate every report to a stub.
  it('falls back to the static cap when the parent headroom is unknown (Infinity)', () =>
    expect(computeReportBudget({ staticCapTokens: 2000, parentRemainingTokens: Infinity, concurrentReporters: 1 })).toBe(2000));

  // A parent already over its window reports negative remaining. The floor is
  // what keeps that from becoming a zero/negative budget (which truncateOutput
  // would render as an empty report with a notice — worse than a short answer).
  it('floors a negative headroom rather than returning zero', () =>
    expect(computeReportBudget({ staticCapTokens: 2000, parentRemainingTokens: -5_000, concurrentReporters: 1 })).toBe(200));
});
