import { describe, it, expect } from 'vitest';
import {
  emptyTotals, addTurnUsage, addSubagentUsage, addPatchLines,
} from '../src/renderer/state/session-totals';

const hunk = (lines: string[]) => [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }];

describe('session totals', () => {
  it('starts at zero with no pricing verdict either way', () => {
    const t = emptyTotals();
    expect(t).toEqual({
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      costUsd: 0, anyPriced: false, anyUnpriced: false, anyFree: false,
      linesAdded: 0, linesRemoved: 0, specialistRuns: 0, specialistCostUsd: 0,
    });
  });

  it('sums tokens across turns', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 5, cacheCreationTokens: 2 });
    t = addTurnUsage(t, { inputTokens: 250, outputTokens: 40, cacheReadTokens: 200, cacheCreationTokens: 0 });
    expect(t.inputTokens).toBe(350);
    expect(t.outputTokens).toBe(50);
    expect(t.cacheReadTokens).toBe(205);
    expect(t.cacheCreationTokens).toBe(2);
  });

  it('adds cost only when a price was known, and records that it was', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 1, outputTokens: 1, costUsd: 0.25 });
    expect(t.costUsd).toBeCloseTo(0.25, 10);
    expect(t.anyPriced).toBe(true);
    expect(t.anyUnpriced).toBe(false);
  });

  it('records an explicitly unpriced turn without inventing a zero', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 1, outputTokens: 1, costUsd: null });
    expect(t.costUsd).toBe(0);
    expect(t.anyPriced).toBe(false);
    expect(t.anyUnpriced).toBe(true);
  });

  it('ignores pricing entirely when the field is absent (a Claude Code turn)', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 1, outputTokens: 1 });
    expect(t.anyPriced).toBe(false);
    expect(t.anyUnpriced).toBe(false);
  });

  // "Free to run" is a THIRD state, not a spelling of unpriced: a local engine
  // costs nothing (anyFree), while a metered model with no published rate costs
  // an unknown something (anyUnpriced). The bar and the Customize menu word the
  // two differently, so the totals must keep them apart.
  it('records free-to-run work without touching either pricing verdict', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 10, outputTokens: 1, free: true });
    expect(t.anyFree).toBe(true);
    expect(t.anyPriced).toBe(false);
    expect(t.anyUnpriced).toBe(false);
    expect(t.costUsd).toBe(0);
  });

  // Task 21 — `costUsd: null` has TWO causes and only ONE of them is
  // "unpriced". Main stamps a local-engine turn as `costUsd: null, free: true`
  // because a local model has no rate card at all; that is FREE, not "metered
  // at a rate we can't see". Before this, every purely local session came out
  // of here with anyUnpriced === true and the bar drew "Cost: not listed".
  it('a costUsd: null turn that is FREE is free, not unpriced', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 1200, outputTokens: 340, costUsd: null, free: true });
    expect(t.anyFree).toBe(true);
    expect(t.anyUnpriced).toBe(false);
    expect(t.anyPriced).toBe(false);
    expect(t.costUsd).toBe(0);
  });

  it('a costUsd: null turn that is NOT free is still unpriced', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 1200, outputTokens: 340, costUsd: null });
    expect(t.anyUnpriced).toBe(true);
    expect(t.anyFree).toBe(false);
  });

  // The same rule on the specialist path: a free LOCAL specialist must not
  // drag its parent session into "not listed" either.
  it('a free local specialist run leaves the parent session priced-verdict-free', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 10, outputTokens: 1, costUsd: null, free: true });
    t = addSubagentUsage(t, { inputTokens: 90, outputTokens: 9, costUsd: null, free: true });
    expect(t.anyUnpriced).toBe(false);
    expect(t.anyFree).toBe(true);
    expect(t.specialistRuns).toBe(1);
    expect(t.specialistCostUsd).toBe(0);
  });

  it('a priced parent turn is not specialist spend', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 1, outputTokens: 1, costUsd: 0.5 });
    expect(t.costUsd).toBeCloseTo(0.5, 10);
    expect(t.specialistCostUsd).toBe(0);
  });

  it('a priced specialist run counts into BOTH the session cost and specialist spend', () => {
    let t = emptyTotals();
    t = addSubagentUsage(t, { inputTokens: 1, outputTokens: 1, costUsd: 0.5 });
    expect(t.costUsd).toBeCloseTo(0.5, 10);
    expect(t.specialistCostUsd).toBeCloseTo(0.5, 10);
  });

  it('an unpriced specialist run adds no specialist spend, only a run', () => {
    let t = emptyTotals();
    t = addSubagentUsage(t, { inputTokens: 1, outputTokens: 1, costUsd: null });
    expect(t.specialistCostUsd).toBe(0);
    expect(t.specialistRuns).toBe(1);
    expect(t.anyUnpriced).toBe(true);
  });

  it('folds a specialist run into the same totals and counts it', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 100, outputTokens: 10, costUsd: 0.1 });
    t = addSubagentUsage(t, { inputTokens: 900, outputTokens: 90, costUsd: 0.9 });
    expect(t.inputTokens).toBe(1000);
    expect(t.outputTokens).toBe(100);
    expect(t.costUsd).toBeCloseTo(1.0, 10);
    expect(t.specialistRuns).toBe(1);
  });

  it('a paid specialist under a free parent still marks the session priced', () => {
    let t = emptyTotals();
    t = addTurnUsage(t, { inputTokens: 10, outputTokens: 1, costUsd: null });   // local parent
    t = addSubagentUsage(t, { inputTokens: 90, outputTokens: 9, costUsd: 0.42 }); // metered child
    expect(t.anyPriced).toBe(true);
    expect(t.costUsd).toBeCloseTo(0.42, 10);
  });

  it('counts added and removed lines, ignoring context lines', () => {
    let t = emptyTotals();
    t = addPatchLines(t, hunk([' context', '-old', '+new', '+extra', ' more']));
    expect(t.linesAdded).toBe(2);
    expect(t.linesRemoved).toBe(1);
  });

  it('treats an empty or malformed hunk list as nothing to count', () => {
    let t = emptyTotals();
    t = addPatchLines(t, []);
    t = addPatchLines(t, [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines: undefined as any }]);
    expect(t.linesAdded).toBe(0);
    expect(t.linesRemoved).toBe(0);
  });

  // Referential-identity tests: the reducer's next task calls
  // addTurnUsage(session.totals, action.usage ?? {}) on every completed turn,
  // and useSyncExternalStore requires an unchanged value to keep the SAME
  // object reference or React re-render-loops. These pin that contract.
  it('returns the same reference on a no-op addTurnUsage call', () => {
    const t = emptyTotals();
    const next = addTurnUsage(t, {});
    expect(next).toBe(t);
  });

  it('returns the same reference on a no-op addPatchLines call', () => {
    const t = emptyTotals();
    const next = addPatchLines(t, []);
    expect(next).toBe(t);
  });

  it('returns a different reference when a call actually changes something', () => {
    const t = emptyTotals();
    const next = addTurnUsage(t, { inputTokens: 1 });
    expect(next).not.toBe(t);
  });

  // THE TRAP: every turn of a local session carries free: true, so if `free`
  // allocated a new lookalike object each time, the useSyncExternalStore
  // snapshot would churn on every turn — the exact failure the no-op guard
  // above exists to prevent. A free flag that changes nothing must be a no-op.
  it('returns the same reference when free: true is already recorded', () => {
    const t = addTurnUsage(emptyTotals(), { free: true });
    expect(t.anyFree).toBe(true);
    const next = addTurnUsage(t, { free: true });
    expect(next).toBe(t);
  });

  it('returns the same reference for free: false, which says nothing new', () => {
    const t = emptyTotals();
    expect(addTurnUsage(t, { free: false })).toBe(t);
  });

  it('returns a different reference the FIRST time free: true is recorded', () => {
    const t = emptyTotals();
    const next = addTurnUsage(t, { free: true });
    expect(next).not.toBe(t);
    expect(next.anyFree).toBe(true);
  });

  // Identity, Task 21 side: a free turn's `costUsd: null` says nothing new
  // once anyFree is latched, so a second one with no tokens must return the
  // SAME object — the useSyncExternalStore contract this file's header
  // describes. (Before the fix it set anyUnpriced and so allocated a lookalike
  // copy on every local turn.)
  it('returns the same reference for a repeated zero-token free turn (costUsd: null)', () => {
    const t = addTurnUsage(emptyTotals(), { costUsd: null, free: true });
    expect(t.anyFree).toBe(true);
    expect(t.anyUnpriced).toBe(false);
    expect(addTurnUsage(t, { costUsd: null, free: true })).toBe(t);
  });

  it('returns a different reference for an explicitly unpriced turn (costUsd: null)', () => {
    const t = emptyTotals();
    const next = addTurnUsage(t, { costUsd: null });
    expect(next).not.toBe(t);
    expect(next.anyUnpriced).toBe(true);
  });

  it('addSubagentUsage always returns a different reference and counts the run, even with no usage', () => {
    const t = emptyTotals();
    const next = addSubagentUsage(t, {});
    expect(next).not.toBe(t);
    expect(next.specialistRuns).toBe(1);
  });

  it('never mutates the totals object handed to it', () => {
    const t = emptyTotals();
    const snapshot = { ...t };
    addTurnUsage(t, { inputTokens: 5, outputTokens: 5, costUsd: 0.5 });
    addSubagentUsage(t, { inputTokens: 5 });
    addPatchLines(t, hunk(['+new', '-old']));
    expect(t).toEqual(snapshot);
  });
});
