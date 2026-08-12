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
// INTEGRATION (Task 8 Step 0, 2026-08-12). This file used to define its own
// local `loadPlan`/`expandPlan`, because matrix.ts and cases/ were sibling
// deliverables in other worktrees and this one was forbidden from importing
// them. All three merged cleanly — different files — and every test stayed
// green, which is exactly the hazard: there were then TWO plan validators that
// already disagreed (the local one never cross-checked case ids or roster
// labels, which is `validatePlan`'s whole job), and `cellFilename` — the
// Windows-safe filename builder that cost a full review round — was referenced
// zero times here. Both local copies are now DELETED and replaced by the real
// modules; nothing below re-implements any part of them.
//
// WHY every grader module is loaded through `graderRoot()` and never through
// `cell.dist`: matrix.js, cases/index.js and battery.js are GRADER-side. The
// harness under test varies per cell; the graders must not. Loading a grader
// from the cell's dist would mean a branch-vs-master comparison silently
// compares two different *graders* as well as two harnesses — a diff nobody
// can interpret, and not a crash. `src/main/harness/eval/paths.ts` exists for
// exactly this: `graderRoot()` ignores its argument by construction and always
// answers this checkout's own dist; `harnessRoot(cell)` answers the cell's.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const WORKER = path.join(HERE, 'harness-eval-worker.mjs');
/** The model roster — the same file review-harness.mjs runs its battery from,
 *  so "which models exist" has one answer for both CLIs. Its LABELS are what a
 *  plan's `models` array names (matrix.ts's EvalPlan documents them as roster
 *  labels), and the OpenRouter model id is looked up from it in runCell. */
const ROSTER_FILE = path.join(HERE, 'review-roster.json');

/** paths.js is the one module that has to be located by hand: it is the module
 *  that DEFINES where graders come from, so it cannot be located by itself.
 *  Everything after it goes through graderRoot(). */
const PATHS_BOOTSTRAP = path.join(DESKTOP, 'dist/main/harness/eval/paths.js');

let gradersPromise = null;

/** Load every grader-side module this orchestrator needs, once.
 *
 *  All four resolve through `graderRoot()` — this checkout's own `dist` —
 *  which is why the argument below is a literal reminder rather than a cell:
 *  graderRoot ignores it by construction (see paths.ts's `_cell`), and passing
 *  something cell-derived here would only invite a future edit to start
 *  honouring it.
 *
 *  THROWS with the real module-resolution error if `dist/` has not been built.
 *  Building is `npm run build:main` (~11s measured); the tests build on demand. */
function loadGraders() {
  if (!gradersPromise) {
    gradersPromise = (async () => {
      const { graderRoot, harnessRoot } = await import(PATHS_BOOTSTRAP);
      const root = graderRoot({ dist: '(ignored — graderRoot never reads its argument)' });
      const load = (rel) => import(path.join(root, rel));
      const [matrix, cases, battery] = await Promise.all([
        load('main/harness/eval/matrix.js'),
        load('main/harness/eval/cases/index.js'),
        load('main/harness/eval/battery.js'),
      ]);
      return {
        graderRoot,
        harnessRoot,
        validatePlan: matrix.validatePlan,
        expandPlan: matrix.expandPlan,
        cellFilename: matrix.cellFilename,
        allCaseIds: cases.allCaseIds,
        getCase: cases.getCase,
        roster: battery.loadRoster(ROSTER_FILE),
      };
    })();
  }
  return gradersPromise;
}

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

// -- plan loading (validation + expansion both live in matrix.ts) ------------

/**
 * @typedef {import('../src/main/harness/eval/matrix').Cell} Cell
 */

/** The default build arm when a plan names none: this checkout's own current
 *  build. Same physical path graderRoot() resolves to (own checkout), but a
 *  DIFFERENT role — this is the harness UNDER TEST for the 'current' arm,
 *  resolved once here and then threaded through exactly like any other
 *  --dist. It is never treated as "the grader root" anywhere downstream.
 *
 *  WHY this is injected here instead of relying on matrix.ts's own default:
 *  matrix.ts is a pure module with no filesystem access, so its DEFAULT_BUILDS
 *  is the RELATIVE `dist: '.'`. Handed to a worker, `'.'` resolves against
 *  whatever cwd that worker happens to have — i.e. "the harness under test" is
 *  decided by where you were standing when you typed the command. Resolving it
 *  to an absolute path here, once, is the fix. */
const CURRENT_BUILD = { id: 'current', dist: path.join(DESKTOP, 'dist') };

/** True only for a whole number >= 1. Used for the `--repeats` FLAG only —
 *  the plan file's own `repeats` field is validatePlan's business. Kept
 *  separate on purpose: a user who typed `--repeats abc` needs to be told the
 *  flag is wrong, not that the plan file is. Before this check existed,
 *  `--repeats abc` printed "Repeats: NaN" and 0 cells while exiting 0. */
function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

/** Read a plan file and hand it to the REAL validator.
 *
 *  Everything this function does is I/O and error framing: read, JSON.parse,
 *  then `validatePlan(plan, knownCaseIds, knownModels)` from matrix.js. There
 *  is deliberately no shape-checking here — a second validator is what Task 8
 *  Step 0 existed to remove, and the local one it replaced never cross-checked
 *  case ids or roster labels at all, so a plan naming a case that does not
 *  exist expanded happily and would have been billed as a real matrix.
 *
 *  `knownCaseIds` comes from the case registry (cases/index.js `allCaseIds()`)
 *  and `knownModels` from the roster's LABELS — both loaded from this
 *  checkout's own dist via graderRoot(), never from a cell's.
 *
 *  THROWS rather than calling process.exit so the validation is reachable from
 *  a test (main() below turns the throw into the same exit code 2 and the same
 *  stderr text a user saw before). The plan's path is prepended to
 *  validatePlan's message because validatePlan takes a parsed object and has
 *  no idea which file it came from — and "which file" is the first thing a
 *  user with several plans needs.
 */
async function readPlanFile(filePath) {
  const { validatePlan, allCaseIds, roster } = await loadGraders();
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`harness-eval: could not read plan "${filePath}": ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`harness-eval: plan "${filePath}" is not valid JSON: ${err.message}`);
  }
  let plan;
  try {
    plan = validatePlan(parsed, allCaseIds(), roster.map((entry) => entry.label));
  } catch (err) {
    throw new Error(`harness-eval: plan "${filePath}" is invalid: ${err.message}`);
  }

  // Build dists are resolved to absolute paths HERE, at the one boundary that
  // knows where the plan file lives. A relative `dist` in a hand-written plan
  // would otherwise be resolved by the worker against whatever cwd it inherits
  // — so the same plan would test a different harness depending on where you
  // stood when you ran it. Relative to the plan file, not to cwd, because that
  // is the directory the author was thinking in when they typed the path.
  const planDir = path.dirname(path.resolve(filePath));
  return {
    ...plan,
    builds: plan.builds && plan.builds.length
      ? plan.builds.map((build) => ({ ...build, dist: path.resolve(planDir, build.dist) }))
      : [CURRENT_BUILD],
  };
}

/** Expand a validated plan into cells — matrix.js's `expandPlan`, unmodified.
 *  It also verifies every cell's `cellFilename` is distinct across the whole
 *  matrix before anything runs, which is why expansion is not something this
 *  file may re-implement. */
async function expandPlanFile(plan) {
  const { expandPlan } = await loadGraders();
  return expandPlan(plan);
}

// -- where a cell's result file goes -----------------------------------------

/** The ONE place a filename is derived from a cell.
 *
 *  WHY never `cell.id`: the id is `|`-joined and carries roster labels like
 *  "Claude Opus 5", so it contains a Windows-reserved character AND spaces —
 *  it was never a valid filename on any platform. `cellFilename` (matrix.ts)
 *  is the slug-plus-digest builder that cost a full review round; every path
 *  derived from a cell goes through it, and nothing downstream should ever
 *  build one from a raw id. */
async function cellResultPath(runDir, cell) {
  const { cellFilename } = await loadGraders();
  return path.join(runDir, `${cellFilename(cell)}.json`);
}

/** Directory a run's per-cell result files land in.
 *
 *  The workspace-marker walk is the same one review-harness.mjs uses and for
 *  the same reason (a git worktree sits one level deeper than the canonical
 *  checkout, so a fixed `../..` silently resolves to the wrong tree).
 *
 *  WHY a fallback instead of review-harness.mjs's `process.exit(2)`: this CLI
 *  has to keep working in a desktop-only checkout with no youcoded-dev
 *  workspace beside it — which is exactly what CI checks out and runs the
 *  tests in. Exiting there would make the orchestrator untestable on the only
 *  platform that tests it. The fallback is announced in the printed output, so
 *  nobody has to guess which one they got. */
function resolveRunsDir() {
  const stamp = new Date().toISOString().slice(0, 10);
  const marker = 'docs/active/investigations';
  let candidate = DESKTOP;
  for (let i = 0; i < 6; i++) {
    candidate = path.resolve(candidate, '..');
    if (fs.existsSync(path.join(candidate, marker))) {
      return { dir: path.join(candidate, marker, 'harness-eval-runs', stamp), inWorkspace: true };
    }
  }
  return { dir: path.join(DESKTOP, 'test-engine/harness-eval-runs', stamp), inWorkspace: false };
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
async function printGrid(plan, cells) {
  const uniq = (values) => [...new Set(values)];
  console.log(`Plan: ${plan.name}`);
  console.log(`Cases: ${uniq(cells.map((c) => c.caseId)).join(', ')}`);
  console.log(`Instructions: ${uniq(cells.map((c) => c.instructionsId)).join(', ')}`);
  console.log(`Models: ${uniq(cells.map((c) => c.model)).join(', ')}`);
  console.log(`Builds: ${uniq(cells.map((c) => c.buildId)).join(', ')}`);
  // COUNT of distinct repeat indices, not max(repeat): matrix.js numbers
  // repeats from 0, so a max would print "Repeats: 2" for three runs. Counting
  // also stays truthful under --only, which can leave a single repeat index.
  console.log(`Repeats: ${uniq(cells.map((c) => c.repeat)).length}`);

  // Where results land, and — concretely — what one result file is called.
  // Printing a real cellFilename() output rather than describing it is the
  // point: the raw cell id contains '|' and spaces, so an example here is a
  // visible check that the Windows-safe builder is actually in the path.
  const runs = resolveRunsDir();
  console.log(`Results: ${runs.dir}`);
  if (!runs.inWorkspace) {
    console.log('  (no youcoded-dev workspace found beside this checkout — falling back to the checkout itself)');
  }
  console.log(`  e.g. ${path.basename(await cellResultPath(runs.dir, cells[0]))} (one file per cell)`);

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

/** Replace every occurrence of the credential with a marker.
 *
 *  Split/join rather than a RegExp: an API key is untrusted-shaped text, and
 *  building a pattern from it would let a key containing regex metacharacters
 *  either throw or match the wrong thing. A falsy key is a no-op so --dry-run
 *  and the tests, which have no key at all, take the same path as a real run. */
function redactKey(text, apiKey) {
  return apiKey ? text.split(apiKey).join('[REDACTED credential]') : text;
}

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
 * place the grader-isolation invariant is defined and tested. Note the
 * contrast with `loadGraders()` at the top of this file, which resolves the
 * case registry and the matrix through `graderRoot()` — this checkout, never
 * `cell.dist`. Only the harness under test varies per cell.
 *
 * WHY it THROWS instead of running something: every failure mode this function
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
 * @param {{ apiKey: string, instructionsText?: string }} opts
 * @returns {Promise<{ cellId: string, run: unknown, error?: string }>}
 */
async function runCell(cell, { apiKey, instructionsText }) {
  if (!apiKey) {
    throw new Error(`harness-eval: cell "${cell.id}" cannot run — no OpenRouter API key was supplied to runCell().`);
  }
  // Fix (review round 1, IMPORTANT 2): no silent `?? distRoot` fallback. A
  // cell whose build arm lost its dist must stop here, not quietly run this
  // checkout's build and be reported as some other arm. validatePlan rejects a
  // dist-less build arm too; this is the second half of the same guard, for
  // cells that reach here without having gone through a plan file.
  if (typeof cell.dist !== 'string' || !cell.dist) {
    throw new Error(`harness-eval: cell "${cell.id}" (build arm "${cell.buildId}") has no "dist" — refusing to run, because defaulting it would run this checkout's own build while the report claims build "${cell.buildId}".`);
  }
  const { harnessRoot, getCase, roster } = await loadGraders();
  // Fix (review round 1, IMPORTANT 1), rewired in Task 8 Step 0: the worker's
  // runCase() defaults an absent `prompt` to the harness-review BATTERY_PROMPT,
  // so a cell with no case body would run the same task N times while each row
  // was labelled with a different caseId — a real matrix's worth of money for
  // one repeated task. The body now comes from the case registry
  // (cases/index.js, loaded from THIS checkout via graderRoot), and getCase
  // throws naming every known id if the cell's caseId is not one of them, so
  // there is no path left on which a body can be absent. The prompt re-check
  // below stays because a future case could be registered with an empty prompt,
  // and that must fail here rather than silently become the battery.
  const caseBody = getCase(cell.caseId);
  if (typeof caseBody.prompt !== 'string' || !caseBody.prompt) {
    throw new Error(
      `harness-eval: cell "${cell.id}" cannot run — case "${cell.caseId}" is registered with an empty prompt. `
      + `Running it would silently execute the default battery prompt and bill it as case "${cell.caseId}".`,
    );
  }
  // Fix (review round 2, IMPORTANT 2): the same hole the check above closes for
  // the CASE axis was still wide open on the INSTRUCTIONS axis. `instructionsId`
  // reaches the worker, but nothing resolves the arm's `file` to text, so two
  // instruction arms produced byte-identical worker configs differing only in
  // the cell id — N paid runs of ONE task, reported as a matrix. Resolving the
  // file belongs to a later task; refusing to run silently does not.
  // `file: null` (the baseline arm) is fine: there is nothing to resolve.
  if (cell.instructionsFile && (typeof instructionsText !== 'string' || !instructionsText)) {
    throw new Error(
      `harness-eval: cell "${cell.id}" cannot run — instruction arm "${cell.instructionsId}" declares a file `
      + `("${cell.instructionsFile}") but no instruction text was supplied for it. Reading instruction files is not wired up `
      + `on this branch yet; running without it would send a config identical to every other arm's, so the arms would be one `
      + `repeated task billed and reported as an instructions comparison.`,
    );
  }
  // Fix (Task 8 Step 0): `cell.model` is a roster LABEL, not an OpenRouter
  // model id — matrix.ts's EvalPlan documents `models` that way and
  // validatePlan cross-checks the plan against the roster's labels. Sending
  // the label straight through as `modelId` (what this file did before the
  // integration, when it validated nothing and assumed the plan held ids)
  // would have OpenRouter reject "Claude Opus 5" as an unknown model AFTER the
  // fixture was seeded. The roster is also where contextLength comes from.
  const entry = roster.find((r) => r.label === cell.model);
  if (!entry) {
    throw new Error(
      `harness-eval: cell "${cell.id}" names model "${cell.model}", which is not a label in ${ROSTER_FILE}. `
      + `Known labels: ${roster.map((r) => r.label).join(', ')}.`,
    );
  }
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
    // `cell.model` is the roster LABEL; `entry.modelId` is what OpenRouter
    // actually accepts. Both travel, because the label is what a report and
    // every error message names, and the id is what gets billed.
    modelId: entry.modelId,
    label: entry.label,
    prompt: caseBody.prompt,
    wrapUpPrompt: caseBody.wrapUpPrompt,
    // From the ROSTER, not the case: it is a property of the model, and
    // getting it wrong-high overflows the model and 400s mid-run (see the
    // RosterEntry doc comment in battery.ts).
    contextLength: entry.contextLength,
    instructions: instructionsText,
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

async function main(argv) {
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
    plan = await readPlanFile(planPath);
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

  let cells;
  try {
    cells = await expandPlanFile(plan);
  } catch (err) {
    // expandPlan's own throw path is the cellFilename collision check, which
    // fires before any run starts. Reported in its own words, not summarised.
    console.error(`harness-eval: ${err.message}`);
    process.exit(2);
  }
  if (only) {
    cells = cells.filter((c) => c.id === only);
    if (!cells.length) {
      console.error(`harness-eval: --only "${only}" matched no cell in the expanded plan.`);
      process.exit(2);
    }
  }

  await printGrid(plan, cells);

  // Skeleton stop point. Task 8 adds: a dollar estimate for `cells`, a
  // confirmation gate (interactive `y` or `--yes`) before the first spawn, and
  // the `--max-spend` cap checked between cells via /api/v1/key. None of that
  // exists yet, so nothing below this line ever calls runCell() or touches an
  // API key — this is deliberate per the task brief's scope discipline, not an
  // oversight. `maxSpend` and `confirmed` are parsed above only so the flags
  // already validate/round-trip for Task 8 to pick up.
  //
  // The case-body half IS now solved (Task 8 Step 0): runCell loads the body
  // from the case registry itself. What remains unwired is the INSTRUCTIONS
  // axis — nothing reads an arm's `file` into text yet, so a non-baseline arm
  // still refuses to run rather than sending a config identical to every other
  // arm's.
  console.log(dryRun
    ? '\n(dry run: nothing would be spent — the estimate and spend gate are Task 8)'
    : `\n(orchestrator skeleton: nothing was run — spawning is wired to runCell() but not yet called from here; that lands behind Task 8's estimate + confirmation gate)${confirmed ? ' [--yes given, but nothing to confirm yet]' : ''}${maxSpend ? ` [--max-spend ${maxSpend} given, but no cap enforced yet]` : ''}`);
}

// Fix (review round 1, MINOR 3): only run main when this file IS the process's
// entry point. Before this, main ran at module scope, so any `await
// import(...)` of this module from a test immediately printed the usage error
// and called process.exit(2) — which made the plan loader/runCell
// exported-but-unreachable and the validator untestable.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // main is async now (the graders are ES-imported from dist at run time), so a
  // rejection would otherwise surface as an unhandled-rejection warning and a
  // zero exit code. Exit 1, with the real error, never a summary of it.
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}

export { readPlanFile, expandPlanFile, cellResultPath, resolveRunsDir, runCell, workerEnv, redactKey, loadGraders };
