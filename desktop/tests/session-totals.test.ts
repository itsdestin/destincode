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
      costUsd: 0, anyPriced: false, anyUnpriced: false,
      linesAdded: 0, linesRemoved: 0, specialistRuns: 0,
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
