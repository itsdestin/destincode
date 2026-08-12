import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'child_process';
import { graderRoot as srcGraderRoot, harnessRoot as srcHarnessRoot } from '../src/main/harness/eval/paths';

const DESKTOP = path.resolve(__dirname, '..');
const COMPILED_PATHS = path.join(DESKTOP, 'dist/main/harness/eval/paths.js');
const SOURCE_PATHS = path.join(DESKTOP, 'src/main/harness/eval/paths.ts');
const requireCjs = createRequire(import.meta.url);

describe('grader isolation', () => {
  // WHY the COMPILED module and not just the TypeScript source: paths.ts
  // resolves its answer from `__dirname`, so the source answers
  // `<desktop>/src/...` under vitest and the compiled copy answers
  // `<desktop>/dist` — only the latter is what production actually produces. A
  // test that only imports the source cannot observe the value the orchestrator
  // will use.
  //
  // BUILD DEPENDENCY — and why this hook COMPILES instead of skipping.
  // Fix (review round 2, IMPORTANT 1): this was a file-scope `beforeAll` that
  // THREW when dist/ was missing, which took down all 11 tests in this file
  // including the 8 that have no build dependency. It also justified itself
  // with "desktop CI already uses build, then test" — the opposite of what
  // .github/workflows/desktop-ci.yml does. Its real order is `npm ci` (line 48)
  // -> `npm test` (51) -> knip -> lint -> `npm run build` (92, Linux only), and
  // `npm test` is bare `vitest` with no pretest hook, so dist/ NEVER exists when
  // CI runs this file, and Windows never builds at all.
  //
  // So the choice was: skip when dist/ is absent, or compile on demand. Skipping
  // would mean this invariant — the one that stops a branch-vs-master eval from
  // silently comparing two GRADERS as well as two harnesses — is never checked
  // in CI on any platform, which is most of the value of having it. Compiling
  // just this one file costs ~2s, needs no project build, and lands it at
  // exactly the production path so the assertions below stay real. A tree that
  // has already been built is used as-is and pays nothing.
  let compiled: { graderRoot: (c: { dist: string }) => string; harnessRoot: (c: { dist: string }) => string };

  beforeAll(() => {
    if (!fs.existsSync(COMPILED_PATHS)) {
      // target/module are read from tsconfig.json rather than hardcoded, so an
      // on-demand compile can never drift from what `npm run build:main`
      // produces. paths.ts imports nothing but `path`, which is what makes a
      // single-file compile faithful here.
      const tsconfig = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'tsconfig.json'), 'utf8'));
      execFileSync(process.execPath, [
        requireCjs.resolve('typescript/bin/tsc'),
        SOURCE_PATHS,
        '--outDir', path.dirname(COMPILED_PATHS),
        '--target', tsconfig.compilerOptions.target,
        '--module', tsconfig.compilerOptions.module,
      ], { cwd: DESKTOP, stdio: 'pipe' });
    }
    // createRequire, not import(): dist/ is CommonJS (package.json is
    // "type": "commonjs") and this loads it exactly the way Node does for the
    // .mjs entry points, with no vite transform in between.
    compiled = requireCjs(COMPILED_PATHS);
  });

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

describe('CLI flag parsing', () => {
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

  it('throws when an instruction arm names a file nobody resolved, naming the arm', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 2): the case axis was guarded and the
    // instructions axis was not, so two arms produced byte-identical configs
    // differing only in the cell id — N paid runs of one task, reported as a
    // matrix.
    await expect(runCell(
      { ...cell, instructionsId: 'terse', instructionsFile: 'instructions/terse.md' },
      { apiKey: 'sk-fake', caseBody: { prompt: 'hi' } },
    )).rejects.toThrow(/instruction arm "terse" declares a file \("instructions\/terse\.md"\)/);
  });

  it('does not throw for the baseline arm, which declares no file', async () => {
    const { runCell } = await import('../test-engine/harness-eval.mjs');
    // `file: null` has nothing to resolve, so it must NOT be blocked — the
    // guard has to be about an unread file, not about instructions being absent.
    // (It still fails, but on the spawn, which is what proves it got past the
    // pre-flight checks rather than being refused by them.)
    // It also doubles as the end-to-end proof that the stdin config channel
    // works: the worker only reaches "could not load the dist" AFTER it has read
    // stdin, parsed the JSON, and passed every required-field check.
    const result = await runCell(
      { ...cell, instructionsFile: null },
      { apiKey: 'sk-fake', caseBody: { prompt: 'hi' } },
    );
    expect(result.error).toBe('worker exited 1 (see its stderr above)');
  });
});

describe('expandPlan carries the instruction arm file onto every cell', () => {
  it('copies arm.file so runCell can tell "nothing to load" from "not loaded yet"', async () => {
    const { loadPlan, expandPlan } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'terse', file: 'instructions/terse.md' }],
    });
    const cells = expandPlan(loadPlan(file));
    expect(cells.map((c: { instructionsFile: string | null }) => c.instructionsFile))
      .toEqual([null, 'instructions/terse.md']);
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
