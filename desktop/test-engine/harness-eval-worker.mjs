#!/usr/bin/env node
// Runs exactly ONE eval cell against a named dist/, in its own process.
//
// WHY a separate process at all: two builds of HarnessSession (and everything
// underneath it) cannot coexist in one Node process — each `dist/` is a
// distinct set of compiled classes/modules, and Node's module cache is keyed
// by resolved path, not by "logical version". Spawning one worker per run is
// what makes "my branch vs master" comparisons possible at all. The other
// half of the invariant — the orchestrator's graders always load from ITS OWN
// checkout, never from the dist this worker is handed — lives in
// src/main/harness/eval/paths.ts.
//
//   OPENROUTER_API_KEY=<key> node test-engine/harness-eval-worker.mjs '<json config>'
//
// Config (argv[2], one JSON object): { cellId, caseId, instructionsId, dist,
// modelId, label, prompt, wrapUpPrompt?, contextLength?, instructions? }.
// `dist` is the harness-under-test root that cell names (paths.ts's
// harnessRoot) — this worker imports run-case.js and openrouter-factory.js
// from underneath it, never from its own checkout.
//
// THE API KEY IS NEVER IN THE CONFIG, and never in argv. See the scrub block
// below for why.
//
// STDOUT CONTRACT: exactly one line, one JSON object, and nothing else:
//   { cellId, run: <the CaseRun runCase() returned>, error?: string }
// Every log/progress/diagnostic line goes to stderr instead. A stray
// console.log on stdout corrupts the parse for a run that may have cost real
// money — there is no output here that isn't either the final result or an
// error explaining why there isn't one.
import * as path from 'path';

// Fix (review round 1, CRITICAL): the key arrives through the ENVIRONMENT and
// is scrubbed here before anything can spawn a subprocess. Same shape as
// test-engine/review-harness.mjs:100-113, and for the same reason: the Bash
// tool (src/main/harness/tools/bash.ts) spawns subprocesses with `env:
// process.env`, and a case's task prompt could invite `env`/`printenv` — any
// such tool result lands in `run.events`, which this process writes to stdout
// and the runner saves as a transcript on disk.
//
// WHY NOT argv (which is what this file used to do): /proc/<pid>/cmdline is
// world-readable on Linux and inherited-by-descendants in spirit — the model's
// own Bash tool runs as a descendant of THIS process, so one `ps -eo args`
// would have printed the key straight back into the transcript. Deleting the
// env var while the key sat in argv scrubbed the visible half and left the
// readable half. Verified empirically: a `ps -eo args` run from inside this
// worker no longer contains the key.
//
// makeOpenRouterFactory takes the key as a plain argument (see
// openrouter-factory.ts), so nothing downstream needs it in the environment.
const apiKey = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY;

function fail(message) {
  console.error(`harness-eval-worker: ${message}`);
  process.exit(1);
}

const raw = process.argv[2];
if (!raw) fail('expected one JSON config argument on argv[2].');

let config;
try {
  config = JSON.parse(raw);
} catch (err) {
  fail(`argv[2] is not valid JSON: ${err.message}`);
}

const {
  cellId, dist, modelId, label,
  prompt, wrapUpPrompt, contextLength, instructions,
} = config;

// Missing-field checks happen BEFORE any import or spend — a malformed
// config is "the run could not start" (task brief, Step 4's third bullet),
// not a run result worth recording.
for (const [field, value] of [['cellId', cellId], ['dist', dist], ['modelId', modelId]]) {
  if (!value) fail(`config is missing required field "${field}".`);
}
// The key is checked separately because it is NOT a config field — see the
// scrub block at the top of this file. Naming the env var (not "apiKey") is
// what makes this error actionable.
if (!apiKey) fail('OPENROUTER_API_KEY was not set in this worker\'s environment (the orchestrator passes it there, never on argv).');
// Fix (review round 1, IMPORTANT 1): runCase() defaults `prompt` to the
// harness-review BATTERY_PROMPT when it is absent. Without this check, a
// config that lost its case body would run the default battery and be
// reported as whatever case the cell id names — N identical paid runs
// masquerading as a matrix. Name the case so the gap is obvious.
if (typeof prompt !== 'string' || !prompt) {
  fail(`config for case "${config.caseId ?? '(unnamed)'}" has no "prompt" — refusing to run, because runCase() would silently fall back to the default battery prompt and bill it as this case.`);
}

let runCase;
let makeOpenRouterFactory;
try {
  ({ runCase } = await import(path.join(dist, 'main/harness/eval/run-case.js')));
  ({ makeOpenRouterFactory } = await import(path.join(dist, 'main/harness/eval/openrouter-factory.js')));
} catch (err) {
  fail(`could not load the harness under test from "${dist}": ${err.message}`);
}

try {
  const run = await runCase({
    modelFactory: makeOpenRouterFactory(apiKey, modelId),
    modelId,
    label: label ?? modelId,
    prompt,
    wrapUpPrompt,
    contextLength,
    instructions,
  });
  // The ONE line this process ever writes to stdout. `run.error` (set when
  // the session itself failed mid-run — see run-case.ts's outcome logic) is
  // mirrored to the top level so a caller can check for failure without
  // reaching into `run` first.
  process.stdout.write(JSON.stringify({ cellId, run, error: run.error }));
} catch (err) {
  // runCase() only throws for a config error caught BEFORE any fixture is
  // seeded or any token spent (see assertHistoryBudget in run-case.ts) — a
  // genuine model/session failure is caught internally and comes back as a
  // normal CaseRun with outcome 'error', handled above. A throw here is
  // therefore "the run could not start": real error on stderr, non-zero exit,
  // no stdout write at all.
  fail(`run "${cellId}" could not start: ${err instanceof Error ? err.message : String(err)}`);
}
