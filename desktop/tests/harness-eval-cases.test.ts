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
});
