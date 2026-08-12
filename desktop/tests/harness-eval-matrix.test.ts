import { describe, it, expect } from 'vitest';
import { expandPlan, validatePlan, cellFilename, type Cell } from '../src/main/harness/eval/matrix';

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

  // Fix 1 (2026-08-12 review): duplicate cases/models validated fine before
  // and expandPlan then emitted two cells sharing one id -- one run's result
  // silently overwrote the other's downstream.
  it('rejects duplicate case ids and names the duplicated value', () => {
    expect(() => validatePlan({ ...PLAN, cases: ['a', 'a'] }, ['a', 'b'], ['M1', 'M2']))
      .toThrow(/duplicate.*a/is);
  });

  it('rejects duplicate model labels and names the duplicated value', () => {
    expect(() => validatePlan({ ...PLAN, models: ['M1', 'M1'] }, ['a', 'b'], ['M1', 'M2']))
      .toThrow(/duplicate.*M1/is);
  });

  // Fix 3 (2026-08-12 review): whitespace-only name/judge produced a
  // blank-looking report title / a judge id that would 400 downstream.
  it('rejects a whitespace-only name', () => {
    expect(() => validatePlan({ ...PLAN, name: '   ' }, ['a', 'b'], ['M1', 'M2'])).toThrow(/name/i);
  });

  it('rejects an empty-string judge', () => {
    expect(() => validatePlan({ ...PLAN, judge: '' }, ['a', 'b'], ['M1', 'M2'])).toThrow(/judge/i);
  });

  it('rejects a whitespace-only judge', () => {
    expect(() => validatePlan({ ...PLAN, judge: '   ' }, ['a', 'b'], ['M1', 'M2'])).toThrow(/judge/i);
  });

  it('still accepts judge: null as the explicit "no judging" spelling', () => {
    const result = validatePlan({ ...PLAN, judge: null }, ['a', 'b'], ['M1', 'M2']);
    expect(result.judge).toBeNull();
  });

  // Fix 3 (2026-08-12 review): the old message dumped the whole build object
  // without saying which field was wrong.
  it('names the offending field when a build arm has a bad id', () => {
    expect(() => validatePlan(
      { ...PLAN, builds: [{ id: '', dist: 'a' }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/"id"/);
  });

  it('names the offending field when a build arm has a bad dist', () => {
    expect(() => validatePlan(
      { ...PLAN, builds: [{ id: 'x', dist: '' }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/"dist"/);
  });
});

describe('cellFilename', () => {
  const baseCell: Cell = {
    id: 'a|none|M1|current|0',
    caseId: 'a',
    instructionsId: 'none',
    model: 'M1',
    buildId: 'current',
    dist: '.',
    repeat: 0,
  };

  const FORBIDDEN = /[<>:"/\\|?*]|\s/;

  it('produces a name with none of the Windows-reserved characters and no spaces', () => {
    const cell: Cell = { ...baseCell, model: 'Claude Opus 5' };
    expect(cellFilename(cell)).not.toMatch(FORBIDDEN);
  });

  it('handles a model id containing a slash', () => {
    const cell: Cell = { ...baseCell, model: 'anthropic/claude-opus-5', id: 'a|none|anthropic/claude-opus-5|current|0' };
    expect(cellFilename(cell)).not.toMatch(FORBIDDEN);
  });

  it('handles the "|" id delimiter appearing inside a field', () => {
    const cell: Cell = { ...baseCell, caseId: 'a|b', id: 'a|b|none|M1|current|0' };
    expect(cellFilename(cell)).not.toMatch(FORBIDDEN);
  });

  it('is deterministic for the same cell', () => {
    expect(cellFilename(baseCell)).toBe(cellFilename({ ...baseCell }));
  });

  // The hazard the review called out by name: the slug transform collapses
  // a literal '-' and a literal '_' (and any other non-alphanumeric run) to
  // the same single '-', so two DIFFERENT cells can produce an IDENTICAL
  // readable slug. Proves the two full filenames still differ.
  it('stays unique when two distinct caseIds collapse to the same readable slug', () => {
    const cellA: Cell = { ...baseCell, caseId: 'a-b', id: 'a-b|none|M1|current|0' };
    const cellB: Cell = { ...baseCell, caseId: 'a_b', id: 'a_b|none|M1|current|0' };
    expect(cellFilename(cellA)).not.toBe(cellFilename(cellB));
  });

  it('stays unique across an entire expanded plan, including cells whose readable slugs collide', () => {
    const plan = {
      name: 'x',
      cases: ['a-b', 'a_b'],
      instructions: [{ id: 'none', file: null }],
      models: ['M1'],
    };
    const names = expandPlan(plan as any).map(cellFilename);
    expect(new Set(names).size).toBe(names.length);
  });
});
