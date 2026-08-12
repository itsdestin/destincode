import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { graderRoot as srcGraderRoot, harnessRoot as srcHarnessRoot } from '../src/main/harness/eval/paths';

const DESKTOP = path.resolve(__dirname, '..');
const COMPILED_PATHS = path.join(DESKTOP, 'dist/main/harness/eval/paths.js');

// WHY the COMPILED module and not just the TypeScript source: paths.ts resolves
// its answer from `__dirname`, so the source answers `<desktop>/src/...` under
// vitest and the compiled copy answers `<desktop>/dist` — only the latter is
// what production actually produces. A test that only imports the source cannot
// observe the value the orchestrator will use.
//
// BUILD DEPENDENCY, stated rather than papered over: this needs `npm run
// build:main` (or `npm run build`) to have run at least once. If it hasn't, the
// test fails with the command to run instead of a confusing module-not-found.
// That is the same order desktop CI already uses (build, then test), and the
// same precondition the two .mjs entry points have at runtime — they import
// from dist/ too, so a checkout where this test can't run is a checkout where
// the orchestrator can't run either.
let compiled: { graderRoot: (c: { dist: string }) => string; harnessRoot: (c: { dist: string }) => string };

beforeAll(() => {
  if (!fs.existsSync(COMPILED_PATHS)) {
    throw new Error(
      `${COMPILED_PATHS} does not exist. Run "npm run build:main" in desktop/ first — this test deliberately `
      + 'exercises the compiled module, because __dirname resolves differently in src/ than in dist/.',
    );
  }
  // createRequire, not import(): dist/ is CommonJS (package.json is
  // "type": "commonjs") and this loads it exactly the way Node does for the
  // .mjs entry points, with no vite transform in between.
  compiled = createRequire(import.meta.url)(COMPILED_PATHS);
});

describe('grader isolation', () => {
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
});

// ---------------------------------------------------------------------------

const CLI = path.join(DESKTOP, 'test-engine/harness-eval.mjs');

function writePlan(plan: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-eval-plan-'));
  const file = path.join(dir, 'plan.json');
  fs.writeFileSync(file, JSON.stringify(plan));
  return file;
}

const BASE_PLAN = {
  name: 'unit-test-plan',
  cases: ['case-a'],
  instructions: [{ id: 'baseline', file: null }],
  models: ['vendor/model-1'],
};

describe('loadPlan validation', () => {
  it('rejects a build arm with no dist, naming the arm', async () => {
    const { loadPlan } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({
      ...BASE_PLAN,
      builds: [{ id: 'current', dist: '/a/dist' }, { id: 'master' }],
    });
    // Regression pin: this plan used to expand and exit 0, with the "master"
    // arm silently running this checkout's own build.
    expect(() => loadPlan(file)).toThrowError(/build arm "master" needs a non-empty "dist"/);
  });

  it('accepts build arms that all name a dist', async () => {
    const { loadPlan, expandPlan } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({
      ...BASE_PLAN,
      builds: [{ id: 'current', dist: '/a/dist' }, { id: 'master', dist: '/b/dist' }],
    });
    const cells = expandPlan(loadPlan(file));
    expect(cells.map((c: { dist: string }) => c.dist)).toEqual(['/a/dist', '/b/dist']);
  });

  it('rejects a non-positive-integer repeats in the plan file', async () => {
    const { loadPlan } = await import('../test-engine/harness-eval.mjs');
    expect(() => loadPlan(writePlan({ ...BASE_PLAN, repeats: 0 }))).toThrowError(/"repeats" must be a positive integer/);
  });
});

describe('--repeats flag', () => {
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

  it('accepts a positive integer and expands that many repeats', () => {
    const file = writePlan(BASE_PLAN);
    const out = execFileSync(process.execPath, [CLI, '--plan', file, '--repeats', '3', '--dry-run'], {
      encoding: 'utf8',
      // No key in the environment at all — --dry-run must not need one.
      env: { ...process.env, OPENROUTER_API_KEY: undefined } as NodeJS.ProcessEnv,
    });
    expect(out).toContain('3 cells');
  });
});

describe('runCell refuses to run a cell it cannot run honestly', () => {
  const cell = {
    id: 'case-a|baseline|vendor/model-1|current|1',
    caseId: 'case-a',
    instructionsId: 'baseline',
    model: 'vendor/model-1',
    buildId: 'current',
    dist: '/a/dist',
    repeat: 1,
  };

  it('throws when no case body is supplied, naming the case', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // Regression pin: without this, runCase() defaults the prompt to the
    // harness-review battery and every cell in the matrix runs the same task.
    await expect(runCell(cell, { apiKey: 'sk-fake', caseBody: undefined }))
      .rejects.toThrow(/no case body was supplied for case "case-a"/);
  });

  it('throws when the cell has no dist, naming the build arm', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    await expect(runCell({ ...cell, dist: '' }, { apiKey: 'sk-fake', caseBody: { prompt: 'hi' } }))
      .rejects.toThrow(/build arm "current"\) has no "dist"/);
  });
});
