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

  // Registry-wide guards, not battery-specific ones: a case added later gets
  // them for free. A check that reports a verdict about the MODEL on a run the
  // model never got to take part in is the `notes/pristine.md` failure shape —
  // a grade for something that never happened — and it must be caught at the
  // case level, not only in assertions.ts's own tests.
  //
  // WHY these runs carry a `user-message` event: `session.send()` emits one
  // synchronously before the provider is ever called (harness-session.ts
  // beginTurn) and run-case.ts pushes every event into `events`, so `events: []`
  // — what this test used to pass — is a shape `runCase` cannot produce. The old
  // version was green against an impossible input while the real one (below)
  // reported `failed`.
  const baseRun = {
    label: 'none', modelId: 'none', review: '', toolCalls: 0, asks: 0,
    stepGates: 0, fixtureRoot: '', outcome: 'no-review' as const,
    metrics: {
      wallClockMs: 0, toolCalls: 0, asks: 0, stepGates: 0, thinkingEvents: 0,
      inputTokens: 0, outputTokens: 0, stopReasons: [], toolsUsed: [], repeats: [],
    },
  };
  const event = (type: 'user-message' | 'session-error', text: string) =>
    ({ type, sessionId: 'eval', uuid: `u-${type}`, timestamp: 1, data: { text } }) as const;

  it('lets no case check report passed on a run where the model never took a step', () => {
    const nothingHappened = { ...baseRun, events: [event('user-message', 'do the task')] };
    for (const id of allCaseIds()) {
      for (const check of getCase(id).expect) {
        const result = check.run(nothingHappened);
        expect(result.state, `${id} → ${check.id}`).toBe('never-ran');
        expect(result.detail, `${id} → ${check.id} must explain itself`).not.toBe('');
      }
    }
  });

  it('lets no case check blame the model when the provider failed on the first step', () => {
    // The real round-8 shape: a 402 before the model ever produced a step.
    const err = 'You requested up to 65536 tokens, but can only afford 63293';
    const provider402 = {
      ...baseRun,
      outcome: 'error' as const,
      error: err,
      events: [event('user-message', 'do the task'), event('session-error', err)],
    };
    for (const id of allCaseIds()) {
      for (const check of getCase(id).expect) {
        const result = check.run(provider402);
        expect(result.state, `${id} → ${check.id} on a first-step 402`).toBe('never-ran');
      }
    }
  });
});
