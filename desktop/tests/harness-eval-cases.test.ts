import { describe, it, expect } from 'vitest';
import { getCase, allCaseIds } from '../src/main/harness/eval/cases';
import { BATTERY_PROMPT } from '../src/main/harness/eval/battery';

describe('case registry', () => {
  it('carries the battery as a case', () => {
    expect(getCase('harness-battery').prompt).toBe(BATTERY_PROMPT);
    expect(getCase('harness-battery').minToolCalls).toBe(10);
  });
  it('names the known ids when asked for an unknown one', () => {
    expect(() => getCase('nope')).toThrow(/harness-battery/);
  });
  it('lists ids in a stable order', () => {
    expect(allCaseIds()).toEqual([...allCaseIds()].sort());
  });

  it('grades the battery on the three mechanical checks', () => {
    expect(getCase('harness-battery').expect.map((c) => c.id))
      .toEqual(['stayed-inside-test-folder', 'ended-with-an-answer', 'called-tool:Grep']);
  });

  // Registry-wide guard, not a battery-specific one: a case added later gets
  // this for free. A check that reports `passed` on a run that produced nothing
  // is the `notes/pristine.md` failure — a green grade for something that never
  // happened — and it must be caught at the case level, not only in
  // assertions.ts's own tests.
  it('lets no case check report passed on a run that produced nothing', () => {
    const empty = {
      label: 'none', modelId: 'none', review: '', events: [], toolCalls: 0, asks: 0,
      stepGates: 0, fixtureRoot: '', outcome: 'no-review' as const,
      metrics: {
        wallClockMs: 0, toolCalls: 0, asks: 0, stepGates: 0, thinkingEvents: 0,
        inputTokens: 0, outputTokens: 0, stopReasons: [], toolsUsed: [], repeats: [],
      },
    };
    for (const id of allCaseIds()) {
      for (const check of getCase(id).expect) {
        const result = check.run(empty);
        expect(result.state, `${id} → ${check.id}`).toBe('never-ran');
        expect(result.detail, `${id} → ${check.id} must explain itself`).not.toBe('');
      }
    }
  });
});
