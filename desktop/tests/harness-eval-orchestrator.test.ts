import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { graderRoot as srcGraderRoot, harnessRoot as srcHarnessRoot } from '../src/main/harness/eval/paths';

const DESKTOP = path.resolve(__dirname, '..');
const COMPILED_PATHS = path.join(DESKTOP, 'dist/main/harness/eval/paths.js');
const requireCjs = createRequire(import.meta.url);

/**
 * Every grader-side module the orchestrator loads from its OWN dist. If any is
 * missing the CLI cannot even print a grid, so the whole suite depends on them.
 */
const REQUIRED_DIST_MODULES = [
  COMPILED_PATHS,
  path.join(DESKTOP, 'dist/main/harness/eval/matrix.js'),
  path.join(DESKTOP, 'dist/main/harness/eval/cases/index.js'),
  path.join(DESKTOP, 'dist/main/harness/eval/battery.js'),
];

/**
 * Build dist/ when the tree has not been built.
 *
 * BUILD DEPENDENCY — and why this BUILDS instead of skipping.
 * Fix (review round 2, IMPORTANT 1): the grader-isolation assertions need the
 * COMPILED module (see that describe), and .github/workflows/desktop-ci.yml
 * runs `npm ci` (line 48) -> `npm test` (51) -> knip -> lint -> `npm run build`
 * (92, Linux only). `npm test` is bare `vitest` with no pretest hook and dist/
 * is gitignored, so dist/ NEVER exists when CI runs this file, and Windows
 * never builds at all. Skipping would mean the invariant that stops a
 * branch-vs-master eval from silently comparing two GRADERS as well as two
 * harnesses is checked on no platform, ever.
 *
 * Fix (Task 8 Step 0, 2026-08-12): this used to compile paths.ts ALONE, which
 * was faithful only while paths.ts was the orchestrator's single dist import.
 * The integration made it load matrix.js, cases/index.js and battery.js from
 * the same dist, and cases/index.js transitively pulls in run-case.ts and the
 * whole harness — not a single-file compile any more. So run the project's own
 * build instead of a hand-rolled tsc invocation, which also removes the risk of
 * this helper's flags drifting from what `npm run build:main` produces.
 * Measured at ~11s on a cold tree; an already-built tree pays nothing.
 */
function ensureBuiltGraders(): void {
  const missing = REQUIRED_DIST_MODULES.filter((file) => !fs.existsSync(file));
  if (missing.length === 0) return;
  try {
    execFileSync(process.execPath, [requireCjs.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json'], {
      cwd: DESKTOP,
      stdio: 'pipe',
    });
  } catch (err) {
    // Fix (review round 3, MINOR 4): stdio 'pipe' means tsc's diagnostics land
    // on err.stdout and execFileSync's own message is only
    // "Command failed: .../tsc ...". Re-thrown WITH the real output attached —
    // the workspace rule against replacing a real error with a summary of it
    // applies to test harnesses too, and this is a hook a non-developer will
    // hit on a fresh checkout.
    const e = err as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
    throw new Error([
      `Could not build dist/ for the harness-eval tests (they need ${missing.join(', ')}).`,
      e.message,
      String(e.stdout ?? '').trim(),
      String(e.stderr ?? '').trim(),
    ].filter(Boolean).join('\n'));
  }
  const stillMissing = REQUIRED_DIST_MODULES.filter((file) => !fs.existsSync(file));
  if (stillMissing.length) {
    throw new Error(`tsc reported success but these are still missing: ${stillMissing.join(', ')}`);
  }
}

// The build is a whole-project tsc, so give the hook room; the default 10s
// hook timeout would fail on a cold tree for no reason but the clock.
const BUILD_TIMEOUT_MS = 300_000;

describe('grader isolation', () => {
  // WHY the COMPILED module and not just the TypeScript source: paths.ts
  // resolves its answer from `__dirname`, so the source answers
  // `<desktop>/src/...` under vitest and the compiled copy answers
  // `<desktop>/dist` — only the latter is what production actually produces. A
  // test that only imports the source cannot observe the value the orchestrator
  // will use. The build-on-demand rationale lives on ensureBuiltGraders().
  let compiled: { graderRoot: (c: { dist: string }) => string; harnessRoot: (c: { dist: string }) => string };

  beforeAll(() => {
    ensureBuiltGraders();
    // createRequire, not import(): dist/ is CommonJS (package.json is
    // "type": "commonjs") and this loads it exactly the way Node does for the
    // .mjs entry points, with no vite transform in between.
    compiled = requireCjs(COMPILED_PATHS);
  }, BUILD_TIMEOUT_MS);

  it('resolves graders against its own checkout, never the dist under test', () => {
    // Exact value, not a not-toContain: `return "/"` would have passed the
    // original assertion while breaking every grader load.
    expect(compiled.graderRoot({ dist: '/somewhere/else/dist' })).toBe(path.join(DESKTOP, 'dist'));
  });

  it('resolves the harness under test against the given dist', () => {
    expect(compiled.harnessRoot({ dist: '/somewhere/else/dist' })).toBe('/somewhere/else/dist');
  });

  it('ignores its argument entirely (two different dists, one answer)', () => {
    expect(compiled.graderRoot({ dist: '/a/dist' })).toBe(compiled.graderRoot({ dist: '/b/dist' }));
    // The source module is held to the same invariant, so that a future edit to
    // paths.ts fails here even before anything is rebuilt. (Its exact value
    // differs from the compiled copy's — src/ vs dist/ — which is precisely why
    // the assertions above have to run against the compiled module.)
    expect(srcGraderRoot({ dist: '/a/dist' })).toBe(srcGraderRoot({ dist: '/b/dist' }));
    expect(srcHarnessRoot({ dist: '/a/dist' })).toBe('/a/dist');
  });

  it('loads the case registry and the matrix from its own dist, not a cell dist', async () => {
    // Regression pin (Task 8 Step 0): the orchestrator now imports matrix.js,
    // cases/index.js and battery.js at run time. Every one of them must come
    // from graderRoot() — a grader loaded from the cell's dist would make a
    // branch-vs-master run compare two graders as well as two harnesses, which
    // is a silently uninterpretable diff rather than a crash.
    const { loadGraders } = await import('../test-engine/harness-eval.mjs');
    const graders = await loadGraders();
    // The registry answers with THIS checkout's cases, and the roster with this
    // checkout's roster file — observable proof the imports resolved locally.
    expect(graders.allCaseIds()).toContain('harness-battery');
    expect(graders.roster.map((r: { label: string }) => r.label)).toContain('Claude Opus 5');
    expect(graders.graderRoot({ dist: '/some/cell/dist' })).toBe(path.join(DESKTOP, 'dist'));
  }, BUILD_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------

const CLI = path.join(DESKTOP, 'test-engine/harness-eval.mjs');

function writePlan(plan: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-plan-'));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  return file;
}

// Fix (Task 8 Step 0): REAL ids. `validatePlan` cross-checks `cases` against
// the case registry and `models` against the roster's labels, which is the
// entire reason the orchestrator's own throwaway validator was deleted — so a
// fixture plan full of invented ids ("case-a", "vendor/model-1") would now be
// rejected before reaching the rule each test is actually about.
const BASE_PLAN = {
  name: 'unit-test-plan',
  cases: ['harness-battery'],
  instructions: [{ id: 'baseline', file: null }],
  models: ['Claude Opus 5'],
};

describe('plan validation goes through matrix.ts validatePlan', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  it('rejects a case id that is not in the registry — which the deleted local validator never did', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // The reason Step 0 exists at all: two validators had merged cleanly and the
    // orchestrator's own one never looked at case ids or roster labels, so a
    // plan naming a case that does not exist expanded happily and would have
    // been billed as a real matrix.
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, cases: ['confgi-investigation'] })))
      .rejects.toThrow(/Unknown case id "confgi-investigation"\. Known case ids: harness-battery/);
  });

  it('rejects a model that is not a roster label', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, models: ['anthropic/claude-opus-5'] })))
      .rejects.toThrow(/Unknown model "anthropic\/claude-opus-5"\. Known models: .*Claude Opus 5/);
  });

  it('names the plan file, which validatePlan itself cannot know', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({ ...BASE_PLAN, cases: ['nope'] });
    await expect(readPlanFile(file)).rejects.toThrow(new RegExp(`plan "${file.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}" is invalid`));
  });

  it('rejects a build arm with no dist, naming the arm', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({
      ...BASE_PLAN,
      builds: [{ id: 'current', dist: '/a/dist' }, { id: 'master' }],
    });
    // Regression pin: this plan used to expand and exit 0, with the "master"
    // arm silently running this checkout's own build.
    await expect(readPlanFile(file)).rejects.toThrow(/Build arm "master" has an invalid "dist"/);
  });

  it('accepts build arms that all name a dist', async () => {
    const { readPlanFile, expandPlanFile } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({
      ...BASE_PLAN,
      builds: [{ id: 'current', dist: '/a/dist' }, { id: 'master', dist: '/b/dist' }],
    });
    const cells = await expandPlanFile(await readPlanFile(file));
    expect(cells.map((c: { dist: string }) => c.dist)).toEqual(['/a/dist', '/b/dist']);
  });

  it('resolves a relative build dist against the plan file, not the cwd', async () => {
    // Fix (Task 8 Step 0): matrix.ts is a pure module, so its default build arm
    // is the RELATIVE `dist: '.'`. A relative dist reaching the worker resolves
    // against whatever cwd that worker inherits, i.e. "which harness am I
    // testing" would depend on where you were standing when you typed the
    // command. Resolution happens once, in the orchestrator, against the plan.
    const { readPlanFile, expandPlanFile } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({ ...BASE_PLAN, builds: [{ id: 'master', dist: 'sibling/dist' }] });
    const cells = await expandPlanFile(await readPlanFile(file));
    expect(cells[0].dist).toBe(path.join(path.dirname(file), 'sibling/dist'));
  });

  it('defaults to an ABSOLUTE current build when the plan names none', async () => {
    const { readPlanFile, expandPlanFile } = await import('../test-engine/harness-eval.mjs');
    const cells = await expandPlanFile(await readPlanFile(writePlan(BASE_PLAN)));
    expect(cells[0].buildId).toBe('current');
    expect(cells[0].dist).toBe(path.join(DESKTOP, 'dist'));
  });

  it('rejects a non-positive-integer repeats in the plan file', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, repeats: 0 })))
      .rejects.toThrow(/"repeats" must be a positive integer/);
  });

  it('rejects an instruction arm that omits "file", naming the arm', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 3, IMPORTANT 2): `[{id:'baseline'},{id:'terse'}]`
    // — one forgotten key — used to expand into two arms that were byte-identical
    // to a legitimate baseline. Both downstream guards stay silent for it (there
    // is no unresolved file to complain about), so N paid runs of ONE task got
    // reported as an instructions comparison.
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'terse' }],
    });
    await expect(readPlanFile(file)).rejects.toThrow(/Instruction arm "terse" has an invalid "file": undefined/);
  });

  it('rejects an instruction arm whose "file" is neither a path nor null', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // '' would be carried as a falsy instructionsFile, i.e. treated downstream
    // as "baseline, nothing to resolve" — the same silent collapse by another
    // route. matrix.ts's validator accepted '' until Step 0 carried this rule
    // over from the deleted local one (`typeof '' === 'string'` passed).
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'terse', file: '' }],
    });
    await expect(readPlanFile(file)).rejects.toThrow(/Instruction arm "terse" has an invalid "file": ""/);
  });

  it('rejects two baseline arms, which are not a comparison', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // Also carried over from the deleted local validator — matrix.ts had no
    // equivalent rule, so two `"file": null` arms validated cleanly and would
    // have run one task twice, billed as an instructions comparison.
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'control', file: null }],
    });
    await expect(readPlanFile(file)).rejects.toThrow(/all set "file": null/);
  });

  it('rejects a non-string entry in cases or models', async () => {
    const { readPlanFile } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 3, MINOR 5): only array-non-emptiness was
    // checked, so `cases: [null]` produced a cell id reading "null|baseline|...".
    // validatePlan catches the same class through membership: a non-string can
    // never be a known case id or roster label.
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, cases: [null] })))
      .rejects.toThrow(/Unknown case id null/);
    await expect(readPlanFile(writePlan({ ...BASE_PLAN, models: ['Claude Opus 5', 7] })))
      .rejects.toThrow(/Unknown model 7/);
  });
});

describe('CLI flag parsing', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  // Spawned rather than imported: the flag is parsed in main(), and the point
  // of the fix is the process's exit code, which only a real process has.
  function run(args: string[]): { status: number | null; stderr: string } {
    try {
      execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', stdio: 'pipe' });
      return { status: 0, stderr: '' };
    } catch (err) {
      const e = err as { status: number | null; stderr: string };
      return { status: e.status, stderr: e.stderr };
    }
  }

  it('rejects a non-numeric value instead of printing "Repeats: NaN" and exiting 0', () => {
    const file = writePlan(BASE_PLAN);
    const { status, stderr } = run(['--plan', file, '--repeats', 'abc']);
    expect(status).toBe(2);
    expect(stderr).toContain('--repeats must be a positive integer (got "abc")');
  });

  it('rejects zero', () => {
    const file = writePlan(BASE_PLAN);
    expect(run(['--plan', file, '--repeats', '0']).status).toBe(2);
  });

  it('rejects a flag given no value instead of eating the next flag', () => {
    // Regression pin (review round 2, MINOR 2): `--plan --dry-run` used to set
    // planPath = "--dry-run" and fail with `could not read plan "--dry-run"`,
    // naming a flag as if it were a filename the user had typed.
    const { status, stderr } = run(['--plan', '--dry-run']);
    expect(status).toBe(2);
    expect(stderr).toContain('--plan needs a value, but the next argument is the flag "--dry-run"');
    expect(stderr).not.toContain('could not read plan');
  });

  it('rejects a trailing flag with nothing after it', () => {
    const { status, stderr } = run(['--plan']);
    expect(status).toBe(2);
    expect(stderr).toContain('--plan needs a value, but nothing followed it');
  });

  it('does not advertise models a --only run will not touch', () => {
    // Regression pin (review round 3, MINOR 6): printGrid read its axis lines
    // off the PLAN while main() filtered the CELLS, so a one-cell run printed
    // "Models: m1, m2" above a single row.
    //
    // The discriminating axis is MODELS rather than cases (Task 8 Step 0):
    // validatePlan now requires every case id to be in the registry, and the
    // registry currently holds exactly one case, so a two-case plan is no
    // longer constructible. Two roster labels are.
    const file = writePlan({ ...BASE_PLAN, models: ['Claude Opus 5', 'Grok 4.5'] });
    const out = execFileSync(
      process.execPath,
      [CLI, '--plan', file, '--only', 'harness-battery|baseline|Claude Opus 5|current|0', '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(out).toContain('Models: Claude Opus 5\n');
    expect(out).toContain('1 cell:');
    expect(out).not.toContain('Grok 4.5');
    // ...and an UNFILTERED run of the same plan still lists both.
    const all = execFileSync(process.execPath, [CLI, '--plan', file, '--dry-run'], { encoding: 'utf8' });
    expect(all).toContain('Models: Claude Opus 5, Grok 4.5\n');
  });

  it('accepts a positive integer and expands that many repeats', () => {
    const file = writePlan(BASE_PLAN);
    const out = execFileSync(process.execPath, [CLI, '--plan', file, '--repeats', '3', '--dry-run'], {
      encoding: 'utf8',
      // No key in the environment at all — --dry-run must not need one.
      env: { ...process.env, OPENROUTER_API_KEY: undefined } as NodeJS.ProcessEnv,
    });
    expect(out).toContain('3 cells');
    // Repeats is a COUNT of distinct indices, not max(repeat): matrix.js
    // numbers repeats from 0, so a max would have printed "Repeats: 2" here.
    expect(out).toContain('Repeats: 3\n');
  });
});

describe('every path derived from a cell goes through cellFilename', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  // The characters that make a raw cell id unusable as a filename. '|' is
  // Windows-reserved and the model axis carries roster LABELS ("Claude Opus
  // 5"), so a real cell id contains both a reserved character and spaces.
  const UNSAFE = /[|\s]/;

  it('produces a result path with no "|" and no space, from a real plan', async () => {
    const { readPlanFile, expandPlanFile, cellResultPath } = await import('../test-engine/harness-eval.mjs');
    const cells = await expandPlanFile(await readPlanFile(writePlan(BASE_PLAN)));
    // Proof the input really did contain both hazards — otherwise this test
    // could pass by them never having been there at all.
    expect(cells[0].id).toMatch(/\|/);
    expect(cells[0].id).toMatch(/\s/);
    const resolved = await cellResultPath('/runs', cells[0]);
    expect(path.basename(resolved)).not.toMatch(UNSAFE);
    // ...and it is not merely a sanitised id: the digest suffix is what keeps
    // two cells whose readable slugs collapse to the same slug distinct.
    expect(path.basename(resolved)).toMatch(/^harness-battery_baseline_claude-opus-5_current_0_[0-9a-f]{16}\.json$/);
  });

  it('is the path the CLI actually prints, not just an unused helper', () => {
    // WHY this one exists on top of the unit test above: a helper nothing calls
    // proves nothing about the orchestrator. This asserts the example filename
    // in the CLI's own output — the end-to-end route from plan file, through
    // matrix.js's expandPlan, to a filesystem name.
    const file = writePlan({ ...BASE_PLAN, models: ['Claude Opus 5'] });
    const out = execFileSync(process.execPath, [CLI, '--plan', file, '--dry-run'], { encoding: 'utf8' });
    const line = out.split('\n').find((l) => l.trim().startsWith('e.g. '));
    expect(line).toBeDefined();
    const printed = line!.trim().replace(/^e\.g\. /, '').replace(/ \(one file per cell\)$/, '');
    expect(printed).not.toMatch(UNSAFE);
    expect(printed).toMatch(/^harness-battery_baseline_claude-opus-5_current_0_[0-9a-f]{16}\.json$/);
  });
});

describe('runCell refuses to run a cell it cannot run honestly', () => {
  // runCell() imports its graders from dist/ before it spawns, so this suite
  // has the same build dependency the grader-isolation one declares. It used to
  // have it silently: on an unbuilt tree it only passed because the FIRST
  // describe's hook had already compiled the file. See ensureBuiltGraders().
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  // A real case id and a real roster label (Task 8 Step 0): runCell now looks
  // both up, so an invented pair would fail on the lookup rather than on the
  // guard each test is about.
  const cell = {
    id: 'harness-battery|baseline|Claude Opus 5|current|0',
    caseId: 'harness-battery',
    instructionsId: 'baseline',
    instructionsFile: null as string | null,
    model: 'Claude Opus 5',
    buildId: 'current',
    dist: '/a/dist',
    repeat: 0,
  };

  it('throws when the cell names a case that is not in the registry', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // Regression pin, rewired: the case body used to be a caller-supplied
    // argument and an absent one made runCase() fall back to the harness-review
    // battery, so every cell in the matrix ran the same task under a different
    // label. The body now comes from the registry, so the hole closes one level
    // up — an unknown caseId cannot produce a body at all, and says so by name.
    await expect(runCell({ ...cell, caseId: 'nope' }, { apiKey: 'sk-fake' }))
      .rejects.toThrow(/Unknown case "nope"\. Known cases: harness-battery/);
  });

  it('throws when the cell has no dist, naming the build arm', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    await expect(runCell({ ...cell, dist: '' }, { apiKey: 'sk-fake' }))
      .rejects.toThrow(/build arm "current"\) has no "dist"/);
  });

  it('throws when the cell names a model that is not a roster label', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // A plan's `models` are roster LABELS; OpenRouter needs the model ID. This
    // orchestrator used to send `cell.model` straight through as `modelId`, so
    // after the switch to a label-validated plan the provider would have
    // rejected "Claude Opus 5" as unknown — AFTER the fixture was seeded.
    await expect(runCell({ ...cell, model: 'Claude Opus 9' }, { apiKey: 'sk-fake' }))
      .rejects.toThrow(/names model "Claude Opus 9", which is not a label in .*review-roster\.json/);
  });

  it('throws when an instruction arm names a file nobody resolved, naming the arm', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 2): the case axis was guarded and the
    // instructions axis was not, so two arms produced byte-identical configs
    // differing only in the cell id — N paid runs of one task, reported as a
    // matrix.
    await expect(runCell(
      { ...cell, instructionsId: 'terse', instructionsFile: 'instructions/terse.md' },
      { apiKey: 'sk-fake' },
    )).rejects.toThrow(/instruction arm "terse" declares a file \("instructions\/terse\.md"\)/);
  });

  it('does not throw for the baseline arm, and delivers the config over stdin', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // Two things at once, and the SECOND one is why this assertion is worded
    // the way it is.
    //
    // 1. `file: null` has nothing to resolve, so it must NOT be blocked — the
    //    guard has to be about an unread file, not about instructions being
    //    absent. It still fails, but on the worker side, which proves it got
    //    past the pre-flight checks rather than being refused by them.
    //
    // 2. Fix (review round 3, IMPORTANT 1): this is the ONLY regression pin on
    //    the stdin config channel (the detector that verified that fix was a
    //    throwaway script, deliberately kept out of the repo). It used to assert
    //    `result.error === 'worker exited 1 (see its stderr above)'` — and exit
    //    1 is what the worker returns for EVERY guard path, including "stdin
    //    closed without a config". So deleting `child.stdin.end(config)` would
    //    have left this test green while the channel was dead. Measured: with
    //    the payload dropped the worker said "stdin closed without a config"
    //    and the old assertion still passed.
    //
    //    "could not load the harness under test from /a/dist" is a message ONLY
    //    a DELIVERED config can produce: the worker reaches the dist import only
    //    after reading stdin to EOF, parsing the JSON, and passing every
    //    required-field check — and the path it names is one that exists
    //    nowhere but inside the config this call wrote. (runCell pipes and
    //    captures the worker's stderr now; with stdio[2]: 'inherit' the caller
    //    could not see WHICH error occurred, which is what made the weak
    //    assertion the only one available.)
    const result = await runCell({ ...cell, instructionsFile: null }, { apiKey: 'sk-fake' });
    expect(result.error).toContain('could not load the harness under test from "/a/dist"');
    // The non-delivery messages, named explicitly so this test fails loudly
    // rather than confusingly if the config ever stops arriving.
    expect(result.error).not.toContain('stdin closed without a config');
    expect(result.error).not.toContain('is not valid JSON');
    // ...and the config it delivered carried the case body from the registry
    // rather than nothing: a config with no prompt is refused by the worker
    // BEFORE it ever tries the dist import, with a different message.
    expect(result.error).not.toContain('has no "prompt"');
  }, 15_000);
});

describe('expandPlan carries the instruction arm file onto every cell', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  it('copies arm.file so runCell can tell "nothing to load" from "not loaded yet"', async () => {
    const { readPlanFile, expandPlanFile } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'terse', file: 'instructions/terse.md' }],
    });
    const cells = await expandPlanFile(await readPlanFile(file));
    expect(cells.map((c: { instructionsFile: string | null }) => c.instructionsFile))
      .toEqual([null, 'instructions/terse.md']);
  });
});

describe('worker stderr is redacted before it can reach a transcript', () => {
  beforeAll(ensureBuiltGraders, BUILD_TIMEOUT_MS);

  // Regression pin (review round 4): runCell captures the worker's stderr tail
  // verbatim into `result.error`, and `result` is what the caller writes to disk
  // as a transcript. That is a FOURTH channel in this branch's long-running
  // credential-leak story (argv, then the environment, then /proc/environ one
  // process up). No current failure path prints the key, so this guards the
  // future: an uncaught throw or a provider-SDK warning would otherwise be filed
  // verbatim.
  it('replaces every occurrence of the key, anywhere in the text', async () => {
    const { redactKey } = await import('../test-engine/harness-eval.mjs');
    const key = 'sk-or-v1-CANARY';
    const out = redactKey(`boom ${key} mid ${key}\ntrailing ${key}`, key);
    expect(out).not.toContain(key);
    expect(out.match(/\[REDACTED credential\]/g)).toHaveLength(3);
  });

  it('scrubs a real worker run, not just the helper in isolation', async () => {
    // WHY this one exists on top of the unit tests above: those pin redactKey
    // itself, and a first draft of them passed with the call site DELETED —
    // exactly the tautological-test shape this branch's reviews have caught
    // twice. This exercises the wiring instead.
    //
    // The trick is getting the key into real worker stderr without any code
    // that prints it: the worker's dist-load failure interpolates the `dist`
    // path it was given, so a path CONTAINING the canary makes the worker emit
    // the canary in its own words, through the same stderr -> result.error ->
    // transcript route a provider-SDK warning would take.
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    const key = 'sk-or-v1-CANARY-IN-A-PATH';
    const result = await runCell(
      {
        id: 'harness-battery|baseline|Claude Opus 5|current|0',
        caseId: 'harness-battery',
        instructionsId: 'baseline',
        instructionsFile: null,
        model: 'Claude Opus 5',
        buildId: 'current',
        dist: `/nonexistent/${key}/dist`,
        repeat: 0,
      },
      { apiKey: key },
    );
    // Proof the worker really did echo the path back (otherwise this test could
    // pass by the key never having been there at all).
    expect(result.error).toContain('could not load the harness under test');
    expect(result.error).toContain('[REDACTED credential]');
    expect(result.error).not.toContain(key);
  }, 15_000);

  it('is a no-op when there is no key, so --dry-run takes the same path', async () => {
    const { redactKey } = await import('../test-engine/harness-eval.mjs');
    expect(redactKey('plain text', undefined)).toBe('plain text');
    expect(redactKey('plain text', '')).toBe('plain text');
  });

  it('survives a key containing regex metacharacters', async () => {
    const { redactKey } = await import('../test-engine/harness-eval.mjs');
    // WHY this case: building a RegExp from the key would throw on an unbalanced
    // bracket, or silently match the wrong span. split/join cannot.
    const key = 'sk-a+b[c).*d';
    expect(redactKey(`x ${key} y`, key)).toBe('x [REDACTED credential] y');
  });
});

describe('the worker environment is an allowlist, not the operator shell', () => {
  it('drops unrelated credentials and keeps what the harness needs', async () => {
    const { workerEnv } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 2, MINOR 1): the worker used to get
    // `{ ...process.env }`, and the model's Bash tool spawns ITS children from
    // that same env — so every secret in the operator's shell reached a tool
    // subprocess and, via run.events, a saved transcript on disk.
    const saved = { ...process.env };
    try {
      process.env.ANTHROPIC_API_KEY = 'canary-anthropic';
      process.env.GITHUB_TOKEN = 'canary-github';
      process.env.OPENROUTER_API_KEY = 'canary-openrouter';
      const env = workerEnv();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(env.GITHUB_TOKEN).toBeUndefined();
      // The OpenRouter key travels in the stdin config now — not here.
      expect(env.OPENROUTER_API_KEY).toBeUndefined();
      expect(Object.values(env)).not.toContain('canary-openrouter');
      expect(env.PATH).toBe(process.env.PATH);
    } finally {
      process.env = saved;
    }
  });
});

describe('the worker refuses a config on argv', () => {
  it('names the stdin channel and the reason instead of running', () => {
    const worker = path.join(DESKTOP, 'test-engine/harness-eval-worker.mjs');
    let stderr = '';
    let status: number | null = 0;
    try {
      execFileSync(process.execPath, [worker, '{"cellId":"c1"}'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      const e = err as { status: number | null; stderr: string };
      status = e.status;
      stderr = e.stderr;
    }
    expect(status).toBe(1);
    expect(stderr).toContain('read from STDIN, not argv');
    expect(stderr).toContain('/proc/<pid>/cmdline');
  });
});
