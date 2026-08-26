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

  // Task 15 pin (deferred from the 1a review): every case above hands
  // parentRemainingTokens in already-subtracted. The REAL caller —
  // native-session-host.ts's formatSpecialistReport, at delivery — derives it
  // as `window - used` (both read off the live parent session) and, since
  // plan 1b's background delivery loop can inject several reports in one
  // pass, calls this with concurrentReporters > 1 for real (1a's foreground
  // flow only ever passed 1). This case pins that exact shape — a window/used
  // pair fed through the same subtraction, split three ways — so a future
  // edit to that call site (e.g. swapping the subtraction order, or dropping
  // the per-reporter division) shows up here even though it lives in a
  // different file. specialist-run.test.ts's own "formatted at DELIVERY time
  // with concurrentReporters" test additionally exercises the real call site
  // end-to-end; this is the unit-level companion the 1a review asked for.
  it('the window-minus-used case with concurrentReporters > 1 — the real delivery-time call shape', () => {
    const window = 32_000;
    const used = 12_000;
    const remaining = window - used; // 20,000 — exactly what formatSpecialistReport computes
    const budget = computeReportBudget({ staticCapTokens: 4_000, parentRemainingTokens: remaining, concurrentReporters: 3 });
    expect(budget).toBe(Math.floor((remaining * 0.5) / 3)); // 3,333 — headroom half, split three ways
  });
});
