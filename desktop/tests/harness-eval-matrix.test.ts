import { describe, it, expect, vi } from 'vitest';
import { expandPlan, validatePlan, cellFilename, type Cell } from '../src/main/harness/eval/matrix';

// Fix pass 1 (2026-08-12 review, IMPORTANT 2): `builds` is now spelled out
// here. expandPlan used to fall back to `[{ id: 'current', dist: '.' }]` — a
// RELATIVE path the worker would resolve against whatever cwd it inherited, so
// "which build am I testing" depended on where the command was typed. There is
// no default any more; the caller that knows an absolute path must supply one.
const PLAN = {
  name: 'x',
  cases: ['a', 'b'],
  instructions: [{ id: 'none', file: null }, { id: 'draft', file: 'd.md' }],
  models: ['M1', 'M2'],
  builds: [{ id: 'current', dist: '/abs/dist' }],
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
  it('carries the named build arm onto every cell', () => {
    expect(expandPlan(PLAN as any).every((c) => c.buildId === 'current' && c.dist === '/abs/dist')).toBe(true);
  });

  // Fix pass 1 (2026-08-12 review, IMPORTANT 2). This replaces a test called
  // "defaults to a single current build" — the default it pinned was
  // `dist: '.'`, and a relative dist reaching a worker means the run silently
  // tests whichever build the working directory happened to point at, while the
  // report names the arm. A pure module cannot produce an absolute default, so
  // the default is gone and its absence is what is pinned now.
  it.each([
    ['absent', {}],
    ['undefined', { builds: undefined }],
    ['an empty array', { builds: [] }],
  ])('refuses to expand a plan whose builds are %s, rather than defaulting to a relative dist', (_label, override) => {
    const { builds: _drop, ...withoutBuilds } = PLAN;
    expect(() => expandPlan({ ...withoutBuilds, ...override } as any))
      .toThrow(/"builds" is required by expandPlan/);
    // The message has to say WHY, not just refuse: the reader is the person who
    // hand-wrote the plan, and "add builds" without the cwd explanation invites
    // them to write `"dist": "."` and reproduce the exact bug.
    expect(() => expandPlan({ ...withoutBuilds, ...override } as any))
      .toThrow(/working directory it inherits/);
  });
  // Fix (Task 8 Step 0, 2026-08-12 integration): a runner holds a Cell, not a
  // plan, and has to tell the deliberate baseline arm (null) apart from an arm
  // that names a file nobody has read yet — the second must refuse to run.
  it('copies each instruction arm\'s file onto its cells', () => {
    const byArm = new Map(expandPlan(PLAN as any).map((c) => [c.instructionsId, c.instructionsFile]));
    expect(byArm.get('none')).toBeNull();
    expect(byArm.get('draft')).toBe('d.md');
  });
  it('carries null for an arm with no file key at all, rather than undefined', () => {
    const plan = { ...PLAN, instructions: [{ id: 'none' }] };
    expect(expandPlan(plan as any).every((c) => c.instructionsFile === null)).toBe(true);
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

  // Both of the next two rules were carried over in Task 8 Step 0 from the
  // orchestrator's own local validator, which was deleted in that integration.
  // matrix.ts did not enforce either one, so dropping the local copy would have
  // dropped review-round-earned coverage silently.
  it('rejects an empty-string instruction arm file, which reads downstream as "baseline"', () => {
    // `typeof '' === 'string'` used to pass here. An empty file is carried onto
    // the cell as a FALSY instructionsFile, which every downstream guard treats
    // as "the baseline arm, nothing to resolve" — so the arm silently collapses
    // into a second copy of the baseline and gets billed as a comparison.
    expect(() => validatePlan(
      { ...PLAN, instructions: [{ id: 'none', file: null }, { id: 'draft', file: '' }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/Instruction arm "draft" has an invalid "file": ""/);
  });

  // Fix pass 1 (2026-08-12 review, MINOR 1): a MISSING "file" key gets its own
  // message rather than the generic invalid-file one, because it is the
  // format's highest-stakes mistake and the only one whose consequence is
  // silence: an omitted key is indistinguishable from `null` (the deliberate
  // baseline) downstream, so it does not fail — it turns the instructions axis
  // into the same task run once per arm and bills it as a comparison.
  it('rejects an instruction arm with no "file" key, and says why that is dangerous', () => {
    expect(() => validatePlan(
      { ...PLAN, instructions: [{ id: 'none', file: null }, { id: 'draft' }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/Instruction arm "draft" has no "file" key/);
    expect(() => validatePlan(
      { ...PLAN, instructions: [{ id: 'none', file: null }, { id: 'draft' }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/cannot be told apart from a deliberate null baseline/);
  });

  it('rejects a plan where every arm forgot "file", naming the first', () => {
    // The scenario the plan format is most likely to meet in the wild: an
    // author who never learned the key exists, so the whole instructions axis
    // is one task repeated.
    expect(() => validatePlan(
      { ...PLAN, instructions: [{ id: 'none' }, { id: 'draft' }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/Instruction arm "none" has no "file" key/);
  });

  it('rejects two arms that both set file: null, which is not a comparison', () => {
    expect(() => validatePlan(
      { ...PLAN, instructions: [{ id: 'none', file: null }, { id: 'control', file: null }] },
      ['a', 'b'], ['M1', 'M2'],
    )).toThrow(/all set "file": null/);
  });

  it('still accepts exactly one baseline arm', () => {
    expect(() => validatePlan(PLAN, ['a', 'b'], ['M1', 'M2'])).not.toThrow();
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
    instructionsFile: null,
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
      builds: [{ id: 'current', dist: '/abs/dist' }],
    };
    const names = expandPlan(plan as any).map(cellFilename);
    expect(new Set(names).size).toBe(names.length);
  });

  // Fix pass 2 (2026-08-12 review): the old full-hex suffix was provably
  // injective but measured ~214 characters on a realistic cell -- combined
  // with the ~80-character directory prefix the review measured for
  // docs/active/investigations/harness-eval-runs/<date>/, that blows past
  // Windows' 260-character whole-path MAX_PATH. The fix bounds every
  // readable field to MAX_FIELD_CHARS (20) and replaces the full-hex id
  // with a fixed 16-hex-char SHA-256 digest, so the worst case is
  // computable regardless of how long the real caseId/instructionsId/
  // model/buildId/repeat values are:
  //   5 fields * 20 chars + 4 '_' separators between them
  //   + 1 '_' before the digest + 16 hex digest chars = 121 chars.
  // 121 (filename) + 5 ('.json') + 80 (measured directory prefix) = 206,
  // comfortably under 260 with ~54 characters of headroom to spare.
  it('stays within the 121-char worst-case bound even with maximally long fields, leaving headroom under Windows MAX_PATH', () => {
    const WORST_CASE_FILENAME_CHARS = 121;
    const DIRECTORY_PREFIX_CHARS = 80; // measured by the review for docs/active/investigations/harness-eval-runs/<date>/
    const EXTENSION_CHARS = '.json'.length;
    const WINDOWS_MAX_PATH = 260;

    const veryLongField = 'x'.repeat(500);
    const cell: Cell = {
      id: `${veryLongField}|${veryLongField}|${veryLongField}|${veryLongField}|999999999999999999`,
      caseId: veryLongField,
      instructionsId: veryLongField,
      instructionsFile: null,
      model: veryLongField,
      buildId: veryLongField,
      dist: '.',
      // eslint-disable-next-line no-loss-of-precision -- deliberately past 2^53: the point is a worst-case-length repeat field, and String() of the rounded value is the same 18 digits.
      repeat: 999999999999999999,
    };
    const filename = cellFilename(cell);
    expect(filename.length).toBeLessThanOrEqual(WORST_CASE_FILENAME_CHARS);
    expect(filename.length + EXTENSION_CHARS + DIRECTORY_PREFIX_CHARS).toBeLessThan(WINDOWS_MAX_PATH);
  });
});

describe('expandPlan filename collision detection', () => {
  // A genuine SHA-256 collision cannot be constructed through the public
  // API -- finding two different cell ids whose first 16 hex chars of
  // SHA-256 match is computationally infeasible (that infeasibility is the
  // whole reason the hash is trusted). To exercise assertUniqueFilenames's
  // throw path for real, this test mocks node:crypto so createHash returns
  // a FIXED digest for every input, then reuses the "a-b" vs "a_b" caseId
  // pair (which the tests above already prove collide on the READABLE
  // slug). With both the digest and the readable slug forced equal,
  // cellFilename produces byte-identical output for two cells with
  // different ids -- the exact scenario assertUniqueFilenames exists to
  // catch. Production code is untouched; only this test's module instance
  // sees the mocked hash.
  it('throws naming both colliding cells when two cells would produce the same filename', async () => {
    vi.resetModules();
    vi.doMock('node:crypto', () => ({
      createHash: () => ({
        update: () => ({
          digest: () => '0'.repeat(64),
        }),
      }),
    }));
    try {
      const mocked = await import('../src/main/harness/eval/matrix');
      const plan = {
        name: 'x',
        cases: ['a-b', 'a_b'],
        instructions: [{ id: 'none', file: null }],
        models: ['M1'],
        builds: [{ id: 'current', dist: '/abs/dist' }],
      };
      expect(() => mocked.expandPlan(plan as any)).toThrow(
        /a-b\|none\|M1\|current\|0.*a_b\|none\|M1\|current\|0|a_b\|none\|M1\|current\|0.*a-b\|none\|M1\|current\|0/s,
      );
    } finally {
      vi.doUnmock('node:crypto');
      vi.resetModules();
    }
  });
});
