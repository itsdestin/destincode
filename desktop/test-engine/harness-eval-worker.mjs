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
//   node test-engine/harness-eval-worker.mjs '<json config>'
//
// Config (argv[2], one JSON object): { cellId, dist, modelId, label, apiKey,
// prompt?, wrapUpPrompt?, contextLength?, instructions? }. `dist` is the
// harness-under-test root that cell names (paths.ts's harnessRoot) — this
// worker imports run-case.js and openrouter-factory.js from underneath it,
// never from its own checkout.
//
// STDOUT CONTRACT: exactly one line, one JSON object, and nothing else:
//   { cellId, run: <the CaseRun runCase() returned>, error?: string }
// Every log/progress/diagnostic line goes to stderr instead. A stray
// console.log on stdout corrupts the parse for a run that may have cost real
// money — there is no output here that isn't either the final result or an
// error explaining why there isn't one.
import * as path from 'path';

// Fix, copied from test-engine/review-harness.mjs:113 with the identical
// reasoning: scrub the key from OUR OWN env before anything runs, regardless
// of how it got there (explicit config field below, or inherited from the
// parent orchestrator's environment at spawn time — child_process.spawn
// inherits the parent's env by default unless overridden). The Bash tool
// (src/main/harness/tools/bash.ts) spawns subprocesses with `env:
// process.env`, and the task prompt a case supplies could just as easily
// invite `env`/`printenv` as the harness review battery's own prompt does —
// any such tool result lands in the transcript this process writes to
// stdout. makeOpenRouterFactory takes the key as a plain argument, so nothing
// downstream needs it to still be in the environment.
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
  cellId, dist, modelId, label, apiKey,
  prompt, wrapUpPrompt, contextLength, instructions,
} = config;

// Missing-field checks happen BEFORE any import or spend — a malformed
// config is "the run could not start" (task brief, Step 4's third bullet),
// not a run result worth recording.
for (const [field, value] of [['cellId', cellId], ['dist', dist], ['modelId', modelId], ['apiKey', apiKey]]) {
  if (!value) fail(`config is missing required field "${field}".`);
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
