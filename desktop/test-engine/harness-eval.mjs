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
    if (i === -1) return undefined;
    const value = argv[i + 1];
    // Fix (review round 2, MINOR 2): a flag's value used to be "whatever the
    // next argv element is", so `--plan --dry-run` set planPath = "--dry-run"
    // and then failed with `could not read plan "--dry-run"` — an error that
    // names a FLAG as though the user had typed it as a filename, hiding the
    // real mistake (the flag was given no value) behind a confusing one.
    if (value === undefined) {
      throw new Error(`harness-eval: ${name} needs a value, but nothing followed it.`);
    }
    if (value.startsWith('--')) {
      throw new Error(`harness-eval: ${name} needs a value, but the next argument is the flag "${value}" — ${name} was given no value.`);
    }
    return value;
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
 *   id: string, caseId: string, instructionsId: string, instructionsFile: string | null,
 *   model: string, buildId: string, dist: string, repeat: number,
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
  // Fix (review round 3, MINOR 5): the ENTRIES of `cases` and `models` were
  // never type-checked — only "is this a non-empty array". `cases: [null]`
  // sailed through and produced a cell with `caseId: null` and the id
  // "null|baseline|vendor/model-1|current|1", which reads like a real case in a
  // report. Same class of hole as the instructions one below, lower stakes.
  for (const [field, values] of [['cases', plan.cases], ['models', plan.models]]) {
    if (!Array.isArray(values)) continue;
    values.forEach((value, i) => {
      if (typeof value !== 'string' || !value) {
        problems.push(`"${field}[${i}]" must be a non-empty string (got ${JSON.stringify(value)})`);
      }
    });
  }
  if (Array.isArray(plan.instructions)) {
    const ids = plan.instructions.map((arm) => arm && arm.id);
    if (ids.some((id) => typeof id !== 'string' || !id)) problems.push('every instruction arm needs a non-empty "id"');
    if (new Set(ids).size !== ids.length) problems.push('instruction arm ids must be unique (duplicate found)');
    // Fix (review round 3, IMPORTANT 2): `file` was never validated at all,
    // while expandPlan did `instructionsFile: arm.file ?? null`. So an arm that
    // simply FORGOT its file key — `instructions: [{id:'baseline'},{id:'terse'}]`
    // — became two arms that are byte-identical to a legitimate no-instructions
    // baseline. Every guard downstream stays silent, because there is no file
    // left unresolved to complain about, and you pay for N runs of ONE task
    // reported as an instructions comparison. The build axis has rejected a
    // missing `dist` by name since round 1; this is the same rule for the axis
    // next to it. So `file` must be WRITTEN OUT on every arm: a path, or an
    // explicit null meaning "this arm is the baseline, on purpose".
    for (const arm of plan.instructions) {
      if (!arm || typeof arm !== 'object') continue; // already reported by the id check above
      const name = typeof arm.id === 'string' && arm.id ? arm.id : '(unnamed)';
      if (!('file' in arm)) {
        problems.push(`instruction arm "${name}" must state "file" explicitly — a path, or null for the no-instructions baseline. An omitted "file" is indistinguishable from a deliberate baseline, so one forgotten key silently collapses the instructions axis into N runs of the same task.`);
      } else if (arm.file !== null && (typeof arm.file !== 'string' || !arm.file)) {
        problems.push(`instruction arm "${name}" has an invalid "file" (got ${JSON.stringify(arm.file)}) — it must be a non-empty path string, or null for the baseline arm`);
      }
    }
    // ...and only ONE arm may be that baseline. Two arms with no instructions
    // file run the identical task, so a plan containing two is not a comparison
    // no matter how carefully each was written out.
    const baselines = plan.instructions.filter((arm) => arm && typeof arm === 'object' && arm.file === null);
    if (baselines.length > 1) {
      problems.push(`instruction arms ${baselines.map((a) => `"${(typeof a.id === 'string' && a.id) || '(unnamed)'}"`).join(', ')} all set "file": null — only one arm can be the no-instructions baseline, because two of them send the identical config and would be billed and reported as an instructions comparison`);
    }
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
              caseId, instructionsId: arm.id,
              // Carried onto the cell (not just the plan) so runCell can tell
              // "this arm has nothing to load" (file: null — the baseline arm)
              // apart from "this arm names a file nobody read yet", which is
              // the case that must refuse to run. See runCell's guard.
              instructionsFile: arm.file ?? null,
              model, buildId: build.id,
              dist: build.dist, repeat,
            });
          }
        }
      }
    }
  }
  return cells;
}

/** Print the plan header and the table of cells.
 *
 *  Fix (review round 3, MINOR 6): every axis line is derived from `cells` — the
 *  rows that are actually going to run — and NOT from `plan`. They used to read
 *  straight off the plan, but main() applies `--only` BEFORE calling this, so a
 *  one-cell run printed "Cases: a, b / Models: m1, m2" above a single row:
 *  a summary advertising work that was not going to happen, right above the
 *  gate that will one day spend money. On an unfiltered run the output is
 *  byte-identical (expandPlan visits every axis value at least once), so the
 *  only behaviour that changed is the filtered one. */
function printGrid(plan, cells) {
  const uniq = (values) => [...new Set(values)];
  console.log(`Plan: ${plan.name}`);
  console.log(`Cases: ${uniq(cells.map((c) => c.caseId)).join(', ')}`);
  console.log(`Instructions: ${uniq(cells.map((c) => c.instructionsId)).join(', ')}`);
  console.log(`Models: ${uniq(cells.map((c) => c.model)).join(', ')}`);
  console.log(`Builds: ${uniq(cells.map((c) => c.buildId)).join(', ')}`);
  console.log(`Repeats: ${Math.max(...cells.map((c) => c.repeat))}`);
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

// -- the worker's environment -------------------------------------------------

/**
 * Fix (review round 2, MINOR 1): the worker used to be spawned with
 * `{ ...process.env, ... }` — the operator's WHOLE shell environment. The model
 * under test drives a Bash tool (src/main/harness/tools/bash.ts:511) that spawns
 * its children with `{ ...process.env, ... }` in turn, and every tool result is
 * recorded into `run.events` and saved as a transcript. So `ANTHROPIC_API_KEY`,
 * `GITHUB_TOKEN`, `AWS_*`, and anything else the operator happened to have
 * exported rode along into a file on disk the moment a case prompt said
 * `printenv`. Scrubbing only the OpenRouter key fixed one var out of hundreds.
 *
 * So: allowlist, not denylist. Everything here is either something the harness
 * demonstrably reads, or something Node / the OS / the shell cannot start
 * without. Measured, not guessed — the ONLY named env var anywhere under
 * src/main/harness is CLAUDE_CODE_GIT_BASH_PATH:
 *
 *   $ rg -o "process\.env\.[A-Za-z_0-9]+" src/main/harness/
 *   src/main/harness/tools/bash.ts:process.env.CLAUDE_CODE_GIT_BASH_PATH
 *
 * everything else below is read by a library or by the OS rather than by our
 * code, and is annotated with which. Adding to this list is the correct way to
 * fix "my tool needs $FOO" — re-forwarding the whole environment is not.
 */
const WORKER_ENV_ALLOWLIST = [
  // Command resolution: `which` (bash.ts's resolveOnPath) and every command
  // the model's Bash tool runs. Nothing works without it.
  'PATH',
  'PATHEXT', // which.sync on Windows: which extensions count as executable
  // os.homedir(). git, ssh, and shell rc files all resolve out of it, and the
  // fixture workspace deliberately sits OUTSIDE it (fixture-workspace.ts).
  'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH',
  // os.tmpdir() — fixture-workspace.ts mkdtemps every case fixture in there,
  // so a worker without these would write fixtures somewhere unexpected.
  'TMPDIR', 'TEMP', 'TMP',
  // Text decoding of tool output. Without a UTF-8 locale, subprocess output
  // comes back mangled and the model is graded on garbage.
  'LANG', 'LC_ALL', 'LC_CTYPE',
  // Read by Node itself at startup: a machine behind a corporate TLS
  // interception CA cannot reach openrouter.ai without it.
  'NODE_EXTRA_CA_CERTS',
  // The one env var our own harness code reads (bash.ts:77).
  'CLAUDE_CODE_GIT_BASH_PATH',
  // Windows can't spawn a shell at all without these: cmd/PowerShell resolve
  // themselves and their module path out of them.
  'SystemRoot', 'SystemDrive', 'windir', 'COMSPEC', 'PSModulePath',
  'LOCALAPPDATA', 'APPDATA', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
];
// Deliberately NOT forwarded, having checked rather than assumed: HTTP_PROXY /
// HTTPS_PROXY / NO_PROXY (the rg above found zero references, and Node's global
// fetch — what @ai-sdk/openai-compatible uses — does not honour them by
// default), and NODE_OPTIONS (an arbitrary-flag injection channel into the
// worker). If a proxied machine ever needs them, add them here on purpose.

/** Build the worker's environment from the allowlist above.
 *  Case-insensitive lookup because Windows env var names are case-insensitive
 *  (`Path` vs `PATH`), and a case-sensitive match there would silently hand the
 *  worker an empty PATH — which fails as "command not found" for every tool
 *  call, i.e. as a fake model result rather than an obvious crash. */
function workerEnv() {
  const byLower = new Map();
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) byLower.set(k.toLowerCase(), [k, v]);
  }
  const out = {};
  for (const name of WORKER_ENV_ALLOWLIST) {
    const hit = byLower.get(name.toLowerCase());
    if (hit) out[hit[0]] = hit[1];
  }
  return out;
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
 * WHY it THROWS on a missing case body / unresolved instruction arm instead of
 * running something: see the two checks below. Every failure mode this function
 * refuses to paper over costs real money once Task 8's gate calls it.
 *
 * WHY the config goes over STDIN: it carries the OpenRouter key, and both of
 * the WORKER's other channels (its argv and its environment) are readable by a
 * descendant of the worker — which the model's own Bash tool is. That is the
 * scope of what was measured; see harness-eval-worker.mjs's header, including
 * its "SCOPE OF THAT GUARANTEE" paragraph, which records what this does NOT
 * cover (the orchestrator's own environment, closed by a Task 8 constraint).
 *
 * @param {Cell} cell
 * @param {{ apiKey: string, caseBody: { prompt: string, wrapUpPrompt?: string, contextLength?: number, instructions?: string } }} opts
 * @returns {Promise<{ cellId: string, run: unknown, error?: string }>}
 */
/** Replace every occurrence of the credential with a marker.
 *
 *  Split/join rather than a RegExp: an API key is untrusted-shaped text, and
 *  building a pattern from it would let a key containing regex metacharacters
 *  either throw or match the wrong thing. A falsy key is a no-op so --dry-run
 *  and the tests, which have no key at all, take the same path as a real run. */
function redactKey(text, apiKey) {
  return apiKey ? text.split(apiKey).join('[REDACTED credential]') : text;
}

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
  // Fix (review round 2, IMPORTANT 2): the same hole the check above closes for
  // the CASE axis was still wide open on the INSTRUCTIONS axis. `instructionsId`
  // reaches the worker, but nothing resolves the arm's `file` to text, so two
  // instruction arms produced byte-identical worker configs differing only in
  // the cell id — N paid runs of ONE task, reported as a matrix. Resolving the
  // file belongs to a later task; refusing to run silently does not.
  // `file: null` (the baseline arm) is fine: there is nothing to resolve.
  if (cell.instructionsFile && (typeof caseBody.instructions !== 'string' || !caseBody.instructions)) {
    throw new Error(
      `harness-eval: cell "${cell.id}" cannot run — instruction arm "${cell.instructionsId}" declares a file `
      + `("${cell.instructionsFile}") but no instruction text was supplied for it. Reading instruction files is not wired up `
      + `on this branch yet; running without it would send a config identical to every other arm's, so the arms would be one `
      + `repeated task billed and reported as an instructions comparison.`,
    );
  }
  const { harnessRoot } = await import(path.join(DESKTOP, 'dist/main/harness/eval/paths.js'));
  const config = {
    cellId: cell.id,
    // The key travels in the CONFIG, and the config travels over stdin — see
    // the spawn below. It is never in argv and never in the environment.
    apiKey,
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
    // Sent so the worker can refuse the same unresolved-arm config independently
    // (a config assembled by something other than runCell, e.g. Task 6's
    // matrix.ts, must not be able to slip past the guard above).
    instructionsFile: cell.instructionsFile ?? null,
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [WORKER], {
      // Fix (review round 2, CRITICAL): the config — key included — is written
      // to the worker's STDIN, so stdio[0] is a pipe rather than 'ignore'.
      // Round 1 had the key in argv (/proc/<pid>/cmdline). Round 2 moved it to
      // the environment and deleted it in the worker, which does NOT close the
      // hole: delete/unsetenv edits the in-heap environ array, it does not
      // rewrite the mm->env_start..env_end stack region that /proc/<pid>/environ
      // exposes, so a descendant could still read the ORIGINAL environment
      // (measured: /proc/<ppid>/environ and `ps eww -p <worker>` both LEAKED).
      // The model's Bash tool is exactly such a descendant, and everything it
      // prints lands in run.events and then in a saved transcript.
      // stdin has no /proc mirror at all: it is a pipe, consumed once, never
      // re-readable by anyone.
      //
      // Fix (review round 3, IMPORTANT 1): stderr is PIPED (and mirrored to
      // ours below) instead of 'inherit'. Inheriting kept it visible to a human
      // but threw it away for this process, so EVERY worker failure came back
      // as the same opaque "worker exited 1" — empty stdin, malformed JSON, a
      // missing apiKey and a dist that would not load were indistinguishable to
      // the caller, and no test could tell whether the stdin config had been
      // delivered at all.
      stdio: ['pipe', 'pipe', 'pipe'],
      // Fix (review round 2, MINOR 1): an ALLOWLISTED environment, not the
      // operator's whole shell. See WORKER_ENV_ALLOWLIST above. Note there is
      // no OPENROUTER_API_KEY here at all any more — the key's only channel is
      // the stdin config.
      env: workerEnv(),
    });
    // Writing the config can fail with EPIPE if the worker died before reading
    // it (bad node install, worker syntax error). Swallow it deliberately: the
    // 'close' handler below already reports the real non-zero exit and the
    // worker's own stderr, and an unhandled 'error' on this stream would crash
    // the orchestrator with a message about a pipe instead.
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(config));
    // Fix (review round 1, IMPORTANT 3): decode as UTF-8 on the STREAM, not
    // per chunk. A transcript JSON is far bigger than one 64 KB chunk, and a
    // multi-byte character split across a chunk boundary decodes to U+FFFD
    // when each Buffer is coerced on its own — corrupting the JSON parse of a
    // run that already cost money.
    child.stdout.setEncoding('utf8');
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    // Capture AND mirror: the human watching still sees worker diagnostics live
    // (that was the only thing 'inherit' bought us), and the text is also kept
    // so a failure can be reported in the worker's own words instead of a guess.
    // setEncoding for the same multi-byte reason as stdout above.
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; process.stderr.write(chunk); });
    child.on('error', (err) => {
      resolve({ cellId: cell.id, run: null, error: `could not spawn worker: ${err.message}` });
    });
    child.on('close', (code, signal) => {
      if (code !== 0) {
        // The worker's OWN words, never a hardcoded guess at what went wrong.
        // Tail-capped rather than truncated from the front, because the reason a
        // process died is at the END of its stderr; the untruncated text was
        // already mirrored above for anyone watching.
        // Redact the credential before this text can reach a transcript.
        //
        // WHY, even though no CURRENT path puts it here: this branch's whole
        // review history is three rounds of the same bug — the key reached the
        // model first through argv, then through the environment, each time
        // certified clean by a check aimed at the channel it had just left.
        // Capturing arbitrary worker stderr verbatim into `result.error` opens a
        // fourth channel: `result` is what the caller writes to disk as a
        // transcript. Today's failure paths are clean (the worker's own fail()
        // messages never interpolate the key's value), but an uncaught throw, a
        // warning from the provider SDK, or a future bug in run-case.ts could all
        // land the literal key on stderr, and this code would file it. Scrubbing
        // an exact string is one line; discovering the fourth instance of this
        // bug in a saved transcript is not.
        const tail = redactKey(stderr.trim().slice(-2000), apiKey);
        const how = code === null ? `was killed by ${signal}` : `exited ${code}`;
        resolve({
          cellId: cell.id,
          run: null,
          error: tail ? `worker ${how}: ${tail}` : `worker ${how} without writing anything to stderr`,
        });
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
  let parsed;
  try {
    // parseArgs now THROWS on a flag given no value (see flagValue). Turned
    // into the same exit code 2 / stderr shape every other usage error uses.
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  const { dryRun, confirmed, planPath, maxSpend, only, repeatsFlag } = parsed;

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
    // Named `repeatsValue`, not `parsed` (review round 3, MINOR 7): `parsed` is
    // already the parseArgs result in this same function, and shadowing it on a
    // line that decides how many paid runs happen is exactly where a confusing
    // name costs money.
    const repeatsValue = Number(repeatsFlag);
    if (!isPositiveInteger(repeatsValue)) {
      console.error(`harness-eval: --repeats must be a positive integer (got "${repeatsFlag}").`);
      process.exit(2);
    }
    plan.repeats = repeatsValue;
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

export { loadPlan, expandPlan, runCell, workerEnv, redactKey };
