#!/usr/bin/env node
// Orchestrator skeleton for the harness evaluator.
//
//   node test-engine/harness-eval.mjs --plan <file> --dry-run
//   node test-engine/harness-eval.mjs --plan <file> --only <cellId>
//
// WHY a skeleton and not the full CLI yet: this task (Task 7 of the harness
// evaluator plan, docs/active/plans/2026-08-12-harness-evaluator.md in the
// youcoded-dev workspace) only has to prove the per-cell WORKER PROCESS model
// and the grader-isolation invariant it depends on (src/main/harness/eval/
// paths.ts). Estimate + the hard spend cap are Task 8's deliverable, and
// building them here would mean designing spend logic against numbers this
// task was never asked to get right. So today: load a plan, validate it,
// expand it into cells, print the grid. Nothing below that spends money or
// needs an API key — --dry-run and a plain invocation currently print the
// same thing, because there is nothing yet to gate.
//
// WHY this file does NOT import src/main/harness/eval/matrix.ts or cases/:
// both are sibling deliverables being built concurrently in other worktrees
// (this worktree only owns paths.ts + the two test-engine/*.mjs files). This
// file defines its own minimal, self-contained plan-shape validation and
// expansion instead of reaching into modules that don't exist on this branch
// yet. A later integration task replaces the local `loadPlan`/`expandPlan`
// below with the real ones from matrix.ts — the Cell shape here is written to
// match that module's documented interface (docs/active/plans/
// 2026-08-12-harness-evaluator.md, Task 6) so that swap is a like-for-like
// replacement, not a redesign.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const WORKER = path.join(HERE, 'harness-eval-worker.mjs');

// -- flag parsing -----------------------------------------------------------

function parseArgs(argv) {
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    dryRun: argv.includes('--dry-run'),
    confirmed: argv.includes('--yes'),
    planPath: flagValue('--plan'),
    maxSpend: flagValue('--max-spend'),
    only: flagValue('--only'),
    repeatsFlag: flagValue('--repeats'),
  };
}

// -- minimal local plan shape (see the file header WHY) ---------------------

/**
 * @typedef {{ id: string, file: string | null }} InstructionArm
 * @typedef {{ id: string, dist: string }} BuildArm
 * @typedef {{
 *   name: string, cases: string[], instructions: InstructionArm[],
 *   models: string[], builds?: BuildArm[], judge?: string | null, repeats?: number,
 * }} EvalPlan
 * @typedef {{
 *   id: string, caseId: string, instructionsId: string, model: string,
 *   buildId: string, dist: string, repeat: number,
 * }} Cell
 */

/** The default build arm when a plan names none: this checkout's own current
 *  build. Same physical path graderRoot() resolves to (own checkout), but a
 *  DIFFERENT role — this is the harness UNDER TEST for the 'current' arm,
 *  resolved once here and then threaded through exactly like any other
 *  --dist. It is never treated as "the grader root" anywhere downstream. */
const CURRENT_BUILD = { id: 'current', dist: path.join(DESKTOP, 'dist') };

/** True only for a whole number >= 1. Shared by the plan's `repeats` field and
 *  the `--repeats` flag so the two can never disagree about what is valid —
 *  before this, the flag path was unchecked and `--repeats abc` printed
 *  "Repeats: NaN" and 0 cells while exiting 0. */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

/** Load + validate a plan file. Deliberately narrow: real cross-checking
 *  against known case ids / roster labels is matrix.ts's `validatePlan` job
 *  (Task 6, a sibling worktree's deliverable) — this only guards the shape
 *  the expansion loop below actually reads, so a malformed plan fails with a
 *  clear message instead of a confusing crash mid-expansion.
 *
 *  THROWS rather than calling process.exit so the validation is reachable
 *  from a test (main() below turns the throw into the same exit code 2 and
 *  the same stderr text a user saw before). */
function loadPlan(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`harness-eval: could not read plan "${filePath}": ${err.message}`);
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (err) {
    throw new Error(`harness-eval: plan "${filePath}" is not valid JSON: ${err.message}`);
  }

  const problems = [];
  if (typeof plan.name !== 'string' || !plan.name) problems.push('"name" must be a non-empty string');
  if (!Array.isArray(plan.cases) || plan.cases.length === 0) problems.push('"cases" must be a non-empty array');
  if (!Array.isArray(plan.instructions) || plan.instructions.length === 0) problems.push('"instructions" must be a non-empty array');
  if (!Array.isArray(plan.models) || plan.models.length === 0) problems.push('"models" must be a non-empty array');
  if (plan.instructions && Array.isArray(plan.instructions)) {
    const ids = plan.instructions.map((arm) => arm && arm.id);
    if (ids.some((id) => typeof id !== 'string' || !id)) problems.push('every instruction arm needs a non-empty "id"');
    if (new Set(ids).size !== ids.length) problems.push('instruction arm ids must be unique (duplicate found)');
  }
  if (plan.repeats !== undefined && !isPositiveInteger(plan.repeats)) {
    problems.push(`"repeats" must be a positive integer (got ${JSON.stringify(plan.repeats)})`);
  }
  if (plan.builds !== undefined) {
    if (!Array.isArray(plan.builds) || plan.builds.length === 0) problems.push('"builds" must be a non-empty array when given');
    else {
      const ids = plan.builds.map((b) => b && b.id);
      if (ids.some((id) => typeof id !== 'string' || !id)) problems.push('every build arm needs a non-empty "id"');
      if (new Set(ids).size !== ids.length) problems.push('build arm ids must be unique (duplicate found)');
      // Fix (review round 1, IMPORTANT 2): a build arm with no `dist` used to
      // pass validation and then silently fall back to this checkout's own
      // build, so "current vs master" ran the SAME harness twice while the
      // report claimed two arms. A build arm's entire purpose is naming a
      // dist, so an arm without one is invalid, not defaultable.
      for (const b of plan.builds) {
        if (!b || typeof b.dist !== 'string' || !b.dist) {
          problems.push(`build arm "${(b && b.id) || '(unnamed)'}" needs a non-empty "dist" path (got ${JSON.stringify(b && b.dist)}) — an arm without one would silently run this checkout's own build`);
        }
      }
    }
  }
  if (problems.length) {
    throw new Error([`harness-eval: plan "${filePath}" is invalid:`, ...problems.map((p) => `  - ${p}`)].join('\n'));
  }

  return /** @type {EvalPlan} */ (plan);
}

/** Cases x instructions x models x builds x repeats, outermost-to-innermost
 *  in that order — same order the design doc specifies for matrix.ts, so a
 *  report built on this stays case-by-case readable. Stable, deterministic
 *  cell ids: `${caseId}|${instructionsId}|${model}|${buildId}|${repeat}`. */
function expandPlan(plan) {
  const builds = plan.builds && plan.builds.length ? plan.builds : [CURRENT_BUILD];
  const repeats = plan.repeats ?? 1;
  const cells = [];
  for (const caseId of plan.cases) {
    for (const arm of plan.instructions) {
      for (const model of plan.models) {
        for (const build of builds) {
          for (let repeat = 1; repeat <= repeats; repeat++) {
            cells.push({
              id: `${caseId}|${arm.id}|${model}|${build.id}|${repeat}`,
              caseId, instructionsId: arm.id, model, buildId: build.id,
              dist: build.dist, repeat,
            });
          }
        }
      }
    }
  }
  return cells;
}

function printGrid(plan, cells) {
  console.log(`Plan: ${plan.name}`);
  console.log(`Cases: ${plan.cases.join(', ')}`);
  console.log(`Instructions: ${plan.instructions.map((a) => a.id).join(', ')}`);
  console.log(`Models: ${plan.models.join(', ')}`);
  console.log(`Builds: ${(plan.builds ?? [CURRENT_BUILD]).map((b) => b.id).join(', ')}`);
  console.log(`Repeats: ${plan.repeats ?? 1}`);
  console.log(`\n${cells.length} cell${cells.length === 1 ? '' : 's'}:`);
  const header = ['case', 'instructions', 'model', 'build', 'repeat'];
  const widths = header.map((h, i) => Math.max(
    h.length,
    ...cells.map((c) => String([c.caseId, c.instructionsId, c.model, c.buildId, c.repeat][i]).length),
  ));
  console.log('  ' + header.map((h, i) => h.padEnd(widths[i])).join('  '));
  for (const c of cells) {
    console.log('  ' + [c.caseId, c.instructionsId, c.model, c.buildId, c.repeat]
      .map((v, i) => String(v).padEnd(widths[i])).join('  '));
  }
}

// -- per-cell worker spawn ----------------------------------------------------

/**
 * Runs one cell in its own worker process and resolves with its parsed
 * result. Not called anywhere in this skeleton's main flow yet — Task 8 wires
 * it in behind the estimate + confirmation + spend-cap gate. It exists now so
 * that gate has something to call.
 *
 * WHY a subprocess and not an in-process call: see harness-eval-worker.mjs's
 * header — two builds of HarnessSession cannot coexist in one Node process.
 *
 * WHY `harnessRoot(cell)` and not `cell.dist` directly: this is the one place
 * this orchestrator resolves "which dist does the harness under test come
 * from," and routing it through paths.ts keeps that resolution in the same
 * place the grader-isolation invariant is defined and tested — so if a future
 * task ever needs to load a grader here too, `graderRoot()` (this checkout,
 * never `cell.dist`) sits right next to it as the obviously-correct choice
 * rather than a second ad hoc path computation.
 *
 * WHY it THROWS on a missing case body instead of running something: see the
 * `caseBody` check below. Every failure mode this function refuses to paper
 * over costs real money once Task 8's gate calls it.
 *
 * @param {Cell} cell
 * @param {{ apiKey: string, caseBody: { prompt: string, wrapUpPrompt?: string, contextLength?: number, instructions?: string } }} opts
 * @returns {Promise<{ cellId: string, run: unknown, error?: string }>}
 */
async function runCell(cell, { apiKey, caseBody }) {
  if (!apiKey) {
    throw new Error(`harness-eval: cell "${cell.id}" cannot run — no OpenRouter API key was supplied to runCell().`);
  }
  // Fix (review round 1, IMPORTANT 2): no silent `?? distRoot` fallback. A
  // cell whose build arm lost its dist must stop here, not quietly run this
  // checkout's build and be reported as some other arm. loadPlan() now rejects
  // a dist-less build arm too; this is the second half of the same guard, for
  // cells that reach here from anywhere but loadPlan (e.g. Task 6's matrix.ts).
  if (typeof cell.dist !== 'string' || !cell.dist) {
    throw new Error(`harness-eval: cell "${cell.id}" (build arm "${cell.buildId}") has no "dist" — refusing to run, because defaulting it would run this checkout's own build while the report claims build "${cell.buildId}".`);
  }
  // Fix (review round 1, IMPORTANT 1): the worker's runCase() defaults an
  // absent `prompt` to the harness-review BATTERY_PROMPT. Loading a case body
  // from `caseId` is a sibling task's deliverable (cases/, not on this
  // branch), so until that lands there is nothing to run — and running the
  // default battery N times while labelling each row with a different caseId
  // would bill a real matrix's worth of money for one repeated task.
  if (!caseBody || typeof caseBody.prompt !== 'string' || !caseBody.prompt) {
    throw new Error(
      `harness-eval: cell "${cell.id}" cannot run — no case body was supplied for case "${cell.caseId}" `
      + `(instruction arm "${cell.instructionsId}"). Loading case bodies from a caseId is not wired up on this branch yet `
      + `(it belongs to the cases/ task); running without one would silently execute the default battery prompt and bill it as case "${cell.caseId}".`,
    );
  }
  const { harnessRoot } = await import(path.join(DESKTOP, 'dist/main/harness/eval/paths.js'));
  const config = {
    cellId: cell.id,
    // Carried so the worker's own errors can name the case/arm, and so a
    // saved result is traceable back to a plan row without re-parsing the id.
    caseId: cell.caseId,
    instructionsId: cell.instructionsId,
    dist: harnessRoot(cell),
    // `model` is the Cell field (see the typedef above) and it IS the
    // OpenRouter model id — the plan's `models` array holds ids. `label` is
    // the same string today; it stays a separate field because the roster
    // format review-harness.mjs uses separates the two.
    modelId: cell.model,
    label: cell.model,
    prompt: caseBody.prompt,
    wrapUpPrompt: caseBody.wrapUpPrompt,
    contextLength: caseBody.contextLength,
    instructions: caseBody.instructions,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(config)], {
      // Only stdout is the data channel we parse (see the worker's own
      // header comment); its stderr is passed straight through so a human
      // watching the orchestrator still sees worker diagnostics live.
      stdio: ['ignore', 'pipe', 'inherit'],
      // Fix (review round 1, CRITICAL): the key goes through the ENVIRONMENT,
      // never argv. argv is readable by any descendant of the worker via
      // /proc/<pid>/cmdline, and the model under test drives a Bash tool that
      // IS such a descendant — so an argv key could be read back into the
      // saved transcript. The worker captures this and deletes it from its own
      // env before it can spawn anything (see its header).
      env: { ...process.env, OPENROUTER_API_KEY: apiKey },
    });
    // Fix (review round 1, IMPORTANT 3): decode as UTF-8 on the STREAM, not
    // per chunk. A transcript JSON is far bigger than one 64 KB chunk, and a
    // multi-byte character split across a chunk boundary decodes to U+FFFD
    // when each Buffer is coerced on its own — corrupting the JSON parse of a
    // run that already cost money.
    child.stdout.setEncoding('utf8');
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('error', (err) => {
      resolve({ cellId: cell.id, run: null, error: `could not spawn worker: ${err.message}` });
    });
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ cellId: cell.id, run: null, error: `worker exited ${code} (see its stderr above)` });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        resolve({ cellId: cell.id, run: null, error: `worker produced non-JSON stdout: ${err.message}` });
      }
    });
  });
}

// -- main ---------------------------------------------------------------------

function main(argv) {
  const { dryRun, confirmed, planPath, maxSpend, only, repeatsFlag } = parseArgs(argv);

  if (!planPath) {
    console.error('harness-eval: --plan <file> is required.');
    console.error('Usage: node test-engine/harness-eval.mjs --plan <file> [--dry-run] [--yes] [--max-spend <usd>] [--only <cellId>] [--repeats <n>]');
    process.exit(2);
  }

  let plan;
  try {
    plan = loadPlan(planPath);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (repeatsFlag !== undefined) {
    // Fix (review round 1, MINOR 2): the flag now goes through the same check
    // the plan file's own `repeats` gets. It used to be a bare Number(), so
    // `--repeats abc` printed "Repeats: NaN" / "0 cells" and exited 0.
    const parsed = Number(repeatsFlag);
    if (!isPositiveInteger(parsed)) {
      console.error(`harness-eval: --repeats must be a positive integer (got "${repeatsFlag}").`);
      process.exit(2);
    }
    plan.repeats = parsed;
  }

  let cells = expandPlan(plan);
  if (only) {
    cells = cells.filter((c) => c.id === only);
    if (!cells.length) {
      console.error(`harness-eval: --only "${only}" matched no cell in the expanded plan.`);
      process.exit(2);
    }
  }

  printGrid(plan, cells);

  // Skeleton stop point. Task 8 adds: a dollar estimate for `cells`, a
  // confirmation gate (interactive `y` or `--yes`) before the first spawn, and
  // the `--max-spend` cap checked between cells via /api/v1/key. None of that
  // exists yet, so nothing below this line ever calls runCell() or touches an
  // API key — this is deliberate per the task brief's scope discipline, not an
  // oversight. `maxSpend` and `confirmed` are parsed above only so the flags
  // already validate/round-trip for Task 8 to pick up.
  //
  // Task 8 also has to solve the OTHER half: runCell() now REFUSES to run
  // without a case body, and nothing on this branch can load one from a
  // caseId. That is deliberate — see runCell's comment.
  console.log(dryRun
    ? '\n(dry run: nothing would be spent — the estimate and spend gate are Task 8)'
    : `\n(orchestrator skeleton: nothing was run — spawning is wired to runCell() but not yet called from here; that lands behind Task 8's estimate + confirmation gate)${confirmed ? ' [--yes given, but nothing to confirm yet]' : ''}${maxSpend ? ` [--max-spend ${maxSpend} given, but no cap enforced yet]` : ''}`);
}

// Fix (review round 1, MINOR 3): only run main when this file IS the process's
// entry point. Before this, main ran at module scope, so any `await
// import(...)` of this module from a test immediately printed the usage error
// and called process.exit(2) — which made loadPlan/expandPlan/runCell
// exported-but-unreachable and the validator untestable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}

export { loadPlan, expandPlan, runCell };
