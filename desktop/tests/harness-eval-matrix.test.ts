import { describe, it, expect } from 'vitest';
import { expandPlan, validatePlan } from '../src/main/harness/eval/matrix';

const PLAN = {
  name: 'x',
  cases: ['a', 'b'],
  instructions: [{ id: 'none', file: null }, { id: 'draft', file: 'd.md' }],
  models: ['M1', 'M2'],
};

describe('expandPlan', () => {
  it('produces one cell per combination', () => {
    expect(expandPlan(PLAN as any)).toHaveLength(2 * 2 * 2);
  });
  it('multiplies by repeats', () => {
    expect(expandPlan({ ...PLAN, repeats: 3 } as any)).toHaveLength(2 * 2 * 2 * 3);
  });
  it('gives every cell a unique stable id', () => {
    const ids = expandPlan(PLAN as any).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(expandPlan(PLAN as any).map((c) => c.id)).toEqual(ids); // deterministic order
  });
  it('defaults to a single current build', () => {
    expect(expandPlan(PLAN as any).every((c) => c.buildId === 'current')).toBe(true);
  });
});

describe('validatePlan', () => {
  it('rejects an unknown case id and names the known ones', () => {
    expect(() => validatePlan({ ...PLAN, cases: ['nope'] }, ['a', 'b'], ['M1', 'M2']))
      .toThrow(/nope.*a, b/s);
  });
  it('rejects an unknown model label', () => {
    expect(() => validatePlan({ ...PLAN, models: ['M9'] }, ['a', 'b'], ['M1', 'M2']))
      .toThrow(/M9/);
  });
  it('rejects duplicate instruction arm ids', () => {
    expect(() => validatePlan(
      { ...PLAN, instructions: [{ id: 'none', file: null }, { id: 'none', file: 'x.md' }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/duplicate/i);
  });

  // Beyond the brief's three cases: validatePlan's input is genuinely
  // untrusted (hand-edited JSON), so non-object shapes and the numeric edge
  // cases called out in the task brief (repeats of 0, -1, 1.5) must reject
  // cleanly rather than producing an empty or infinite matrix downstream.
  it('rejects a non-object plan', () => {
    expect(() => validatePlan(null, ['a', 'b'], ['M1', 'M2'])).toThrow(/object/i);
    expect(() => validatePlan('x', ['a', 'b'], ['M1', 'M2'])).toThrow(/object/i);
    expect(() => validatePlan(['x'], ['a', 'b'], ['M1', 'M2'])).toThrow(/object/i);
    expect(() => validatePlan(undefined, ['a', 'b'], ['M1', 'M2'])).toThrow(/object/i);
  });

  it('rejects a non-empty-string name', () => {
    expect(() => validatePlan({ ...PLAN, name: '' }, ['a', 'b'], ['M1', 'M2'])).toThrow(/name/i);
    expect(() => validatePlan({ ...PLAN, name: 5 }, ['a', 'b'], ['M1', 'M2'])).toThrow(/name/i);
  });

  it('rejects a non-array cases field', () => {
    expect(() => validatePlan({ ...PLAN, cases: 'a' }, ['a', 'b'], ['M1', 'M2'])).toThrow(/cases/i);
  });

  it.each([0, -1, 1.5])('rejects repeats of %s', (repeats) => {
    expect(() => validatePlan({ ...PLAN, repeats }, ['a', 'b'], ['M1', 'M2']))
      .toThrow(/repeats/i);
  });

  it('rejects an empty-string instruction arm id', () => {
    expect(() => validatePlan(
      { ...PLAN, instructions: [{ id: '', file: null }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/id/i);
  });

  it('rejects duplicate build ids and names them', () => {
    expect(() => validatePlan(
      { ...PLAN, builds: [{ id: 'x', dist: 'a' }, { id: 'x', dist: 'b' }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/duplicate.*x/is);
  });

  it('rejects a build missing dist', () => {
    expect(() => validatePlan(
      { ...PLAN, builds: [{ id: 'x' }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/build/i);
  });

  it('rejects a non-string, non-null judge', () => {
    expect(() => validatePlan({ ...PLAN, judge: 7 }, ['a', 'b'], ['M1', 'M2'])).toThrow(/judge/i);
  });

  it('accepts a fully-specified valid plan and passes builds/judge/repeats through', () => {
    const result = validatePlan(
      { ...PLAN, builds: [{ id: 'b1', dist: 'dist-a' }], judge: 'openrouter/judge', repeats: 2 },
      ['a', 'b'], ['M1', 'M2'],
    );
    expect(result.builds).toEqual([{ id: 'b1', dist: 'dist-a' }]);
    expect(result.judge).toBe('openrouter/judge');
    expect(result.repeats).toBe(2);
  });
});
