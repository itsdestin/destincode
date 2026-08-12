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

/**
 * Compile src/main/harness/eval/paths.ts to its production path when the tree
 * has not been built.
 *
 * BUILD DEPENDENCY — and why this COMPILES instead of skipping.
 * Fix (review round 2, IMPORTANT 1): the grader-isolation assertions need the
 * COMPILED module (see that describe), and .github/workflows/desktop-ci.yml
 * runs `npm ci` (line 48) -> `npm test` (51) -> knip -> lint -> `npm run build`
 * (92, Linux only). `npm test` is bare `vitest` with no pretest hook and dist/
 * is gitignored, so dist/ NEVER exists when CI runs this file, and Windows
 * never builds at all. Skipping would mean the invariant that stops a
 * branch-vs-master eval from silently comparing two GRADERS as well as two
 * harnesses is checked on no platform, ever. Compiling one file costs ~2s,
 * needs no project build, and lands it at exactly the production path so the
 * exact-value assertions stay real. An already-built tree pays nothing.
 *
 * Fix (review round 3, MINOR 3): this is a module-scope function rather than
 * one describe's beforeAll, because runCell() also imports
 * dist/main/harness/eval/paths.js and therefore has the same dependency. It
 * only ever passed on an unbuilt tree by accident — the grader-isolation
 * beforeAll happened to run first and left the file behind. Filter that
 * describe away (`npx vitest run -t 'baseline arm'`) and the runCell test blew
 * up with a raw ERR_MODULE_NOT_FOUND instead. Both suites now declare it.
 */
function ensureCompiledPaths(): void {
  if (fs.existsSync(COMPILED_PATHS)) return;
  // target/module are read from tsconfig.json rather than hardcoded, so an
  // on-demand compile can never drift from what `npm run build:main` produces.
  // paths.ts imports nothing but `path`, which is what makes a single-file
  // compile faithful here.
  const tsconfig = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'tsconfig.json'), 'utf8'));
  try {
    execFileSync(process.execPath, [
      requireCjs.resolve('typescript/bin/tsc'),
      SOURCE_PATHS,
      '--outDir', path.dirname(COMPILED_PATHS),
      '--target', tsconfig.compilerOptions.target,
      '--module', tsconfig.compilerOptions.module,
    ], { cwd: DESKTOP, stdio: 'pipe' });
  } catch (err) {
    // Fix (review round 3, MINOR 4): stdio 'pipe' means tsc's diagnostics land
    // on err.stdout and execFileSync's own message is only
    // "Command failed: .../tsc ...". Re-thrown WITH the real output attached —
    // the workspace rule against replacing a real error with a summary of it
    // applies to test harnesses too, and this is a hook a non-developer will
    // hit on a fresh checkout.
    const e = err as { message?: string; stdout?: Buffer | string; stderr?: Buffer | string };
    throw new Error([
      `Could not compile ${SOURCE_PATHS} for the harness-eval tests (they need the compiled paths.js at ${COMPILED_PATHS}).`,
      e.message,
      String(e.stdout ?? '').trim(),
      String(e.stderr ?? '').trim(),
    ].filter(Boolean).join('\n'));
  }
}

describe('grader isolation', () => {
  // WHY the COMPILED module and not just the TypeScript source: paths.ts
  // resolves its answer from `__dirname`, so the source answers
  // `<desktop>/src/...` under vitest and the compiled copy answers
  // `<desktop>/dist` — only the latter is what production actually produces. A
  // test that only imports the source cannot observe the value the orchestrator
  // will use. The compile-on-demand rationale lives on ensureCompiledPaths().
  let compiled: { graderRoot: (c: { dist: string }) => string; harnessRoot: (c: { dist: string }) => string };

  beforeAll(() => {
    ensureCompiledPaths();
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

  it('rejects an instruction arm that omits "file", naming the arm', async () => {
    const { loadPlan } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 3, IMPORTANT 2): `[{id:'baseline'},{id:'terse'}]`
    // — one forgotten key — used to expand into two arms that were byte-identical
    // to a legitimate baseline. Both downstream guards stay silent for it (there
    // is no unresolved file to complain about), so N paid runs of ONE task got
    // reported as an instructions comparison.
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline' }, { id: 'terse' }],
    });
    expect(() => loadPlan(file)).toThrowError(/instruction arm "terse" must state "file" explicitly/);
  });

  it('rejects an instruction arm whose "file" is neither a path nor null', async () => {
    const { loadPlan } = await import('../test-engine/harness-eval.mjs');
    // '' would be carried as a falsy instructionsFile, i.e. treated downstream
    // as "baseline, nothing to resolve" — the same silent collapse by another route.
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'terse', file: '' }],
    });
    expect(() => loadPlan(file)).toThrowError(/instruction arm "terse" has an invalid "file"/);
  });

  it('rejects two baseline arms, which are not a comparison', async () => {
    const { loadPlan } = await import('../test-engine/harness-eval.mjs');
    const file = writePlan({
      ...BASE_PLAN,
      instructions: [{ id: 'baseline', file: null }, { id: 'control', file: null }],
    });
    expect(() => loadPlan(file)).toThrowError(/all set "file": null — only one arm can be the no-instructions baseline/);
  });

  it('rejects a non-string entry in cases or models, naming the index', async () => {
    const { loadPlan } = await import('../test-engine/harness-eval.mjs');
    // Regression pin (review round 3, MINOR 5): only array-non-emptiness was
    // checked, so `cases: [null]` produced a cell id reading "null|baseline|...".
    expect(() => loadPlan(writePlan({ ...BASE_PLAN, cases: [null] })))
      .toThrowError(/"cases\[0\]" must be a non-empty string \(got null\)/);
    expect(() => loadPlan(writePlan({ ...BASE_PLAN, models: ['ok', 7] })))
      .toThrowError(/"models\[1\]" must be a non-empty string \(got 7\)/);
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

  it('does not advertise cases a --only run will not touch', () => {
    // Regression pin (review round 3, MINOR 6): printGrid read its axis lines
    // off the PLAN while main() filtered the CELLS, so a one-cell run printed
    // "Cases: case-a, case-b" above a single row.
    const file = writePlan({ ...BASE_PLAN, cases: ['case-a', 'case-b'] });
    const out = execFileSync(
      process.execPath,
      [CLI, '--plan', file, '--only', 'case-a|baseline|vendor/model-1|current|1', '--dry-run'],
      { encoding: 'utf8' },
    );
    expect(out).toContain('Cases: case-a\n');
    expect(out).toContain('1 cell:');
    expect(out).not.toContain('case-b');
    // ...and an UNFILTERED run of the same plan still lists both.
    const all = execFileSync(process.execPath, [CLI, '--plan', file, '--dry-run'], { encoding: 'utf8' });
    expect(all).toContain('Cases: case-a, case-b\n');
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
  // runCell() imports dist/main/harness/eval/paths.js before it spawns, so this
  // suite has the same build dependency the grader-isolation one declares. It
  // used to have it silently: on an unbuilt tree it only passed because the
  // FIRST describe's hook had already compiled the file. See ensureCompiledPaths().
  beforeAll(ensureCompiledPaths);

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
    const result = await runCell(
      { ...cell, instructionsFile: null },
      { apiKey: 'sk-fake', caseBody: { prompt: 'hi' } },
    );
    expect(result.error).toContain('could not load the harness under test from "/a/dist"');
    // The non-delivery messages, named explicitly so this test fails loudly
    // rather than confusingly if the config ever stops arriving.
    expect(result.error).not.toContain('stdin closed without a config');
    expect(result.error).not.toContain('is not valid JSON');
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

describe('worker stderr is redacted before it can reach a transcript', () => {
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
        id: 'c1', caseId: 'a', instructionsId: 'baseline', instructionsFile: null,
        model: 'vendor/model-1', buildId: 'current', dist: `/nonexistent/${key}/dist`, repeat: 1,
      },
      { apiKey: key, caseBody: { prompt: 'hi' } },
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
