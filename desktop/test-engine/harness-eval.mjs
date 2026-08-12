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

const args = process.argv.slice(2);
function flagValue(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}
const dryRun = args.includes('--dry-run');
const confirmed = args.includes('--yes');
const planPath = flagValue('--plan');
const maxSpend = flagValue('--max-spend');
const only = flagValue('--only');
const repeatsFlag = flagValue('--repeats');

if (!planPath) {
  console.error('harness-eval: --plan <file> is required.');
  console.error('Usage: node test-engine/harness-eval.mjs --plan <file> [--dry-run] [--yes] [--max-spend <usd>] [--only <cellId>] [--repeats <n>]');
  process.exit(2);
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

/** Load + validate a plan file. Deliberately narrow: real cross-checking
 *  against known case ids / roster labels is matrix.ts's `validatePlan` job
 *  (Task 6, a sibling worktree's deliverable) — this only guards the shape
 *  the expansion loop below actually reads, so a malformed plan fails with a
 *  clear message instead of a confusing crash mid-expansion. */
function loadPlan(filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(`harness-eval: could not read plan "${filePath}": ${err.message}`);
    process.exit(2);
  }
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (err) {
    console.error(`harness-eval: plan "${filePath}" is not valid JSON: ${err.message}`);
    process.exit(2);
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
  if (plan.repeats !== undefined && (!Number.isInteger(plan.repeats) || plan.repeats < 1)) {
    problems.push('"repeats" must be a positive integer');
  }
  if (plan.builds !== undefined) {
    if (!Array.isArray(plan.builds) || plan.builds.length === 0) problems.push('"builds" must be a non-empty array when given');
    else {
      const ids = plan.builds.map((b) => b && b.id);
      if (new Set(ids).size !== ids.length) problems.push('build arm ids must be unique (duplicate found)');
    }
  }
  if (problems.length) {
    console.error(`harness-eval: plan "${filePath}" is invalid:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(2);
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
 * @param {Cell} cell
 * @param {{ distRoot: string, apiKey: string }} opts
 * @returns {Promise<{ cellId: string, run: unknown, error?: string }>}
 */
async function runCell(cell, { distRoot, apiKey }) {
  const { harnessRoot } = await import(path.join(DESKTOP, 'dist/main/harness/eval/paths.js'));
  const config = {
    cellId: cell.id,
    dist: harnessRoot({ dist: cell.dist ?? distRoot }),
    modelId: cell.modelId ?? cell.model,
    label: cell.model,
    apiKey,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER, JSON.stringify(config)], {
      // Only stdout is the data channel we parse (see the worker's own
      // header comment); its stderr is passed straight through so a human
      // watching the orchestrator still sees worker diagnostics live.
      stdio: ['ignore', 'pipe', 'inherit'],
    });
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

const plan = loadPlan(planPath);
if (repeatsFlag !== undefined) plan.repeats = Number(repeatsFlag);

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
console.log(dryRun
  ? '\n(dry run: nothing would be spent — the estimate and spend gate are Task 8)'
  : `\n(orchestrator skeleton: nothing was run — spawning is wired to runCell() but not yet called from here; that lands behind Task 8's estimate + confirmation gate)${confirmed ? ' [--yes given, but nothing to confirm yet]' : ''}${maxSpend ? ` [--max-spend ${maxSpend} given, but no cap enforced yet]` : ''}`);

export { loadPlan, expandPlan, runCell };
