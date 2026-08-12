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
//   echo '<json config>' | node test-engine/harness-eval-worker.mjs
//
// Config (ONE JSON object read from STDIN — not argv, not the environment):
// { cellId, caseId, instructionsId, instructionsFile, dist, modelId, label,
//   apiKey, prompt, wrapUpPrompt?, contextLength?, instructions? }.
// `dist` is the harness-under-test root that cell names (paths.ts's
// harnessRoot) — this worker imports run-case.js and openrouter-factory.js
// from underneath it, never from its own checkout.
//
// STDOUT CONTRACT: exactly one line, one JSON object, and nothing else:
//   { cellId, run: <the CaseRun runCase() returned>, error?: string }
// Every log/progress/diagnostic line goes to stderr instead. A stray
// console.log on stdout corrupts the parse for a run that may have cost real
// money — there is no output here that isn't either the final result or an
// error explaining why there isn't one.
import * as path from 'path';

// ---------------------------------------------------------------------------
// HOW THE API KEY GETS IN HERE, and what is actually guaranteed about it.
//
// The threat: the model under test drives a Bash tool
// (src/main/harness/tools/bash.ts:511) that spawns its children with
// `{ ...process.env, ... }`, so those children are DESCENDANTS of this process.
// Every byte they print comes back as a tool result, lands in `run.events`, and
// is written to stdout below — where the runner saves it as a transcript on
// disk. Any channel a descendant can read the key from is therefore a channel
// that writes the key into a file.
//
// Two channels were tried and both failed, each measured from inside such a
// descendant with a canary key:
//   round 1, argv:        /proc/<ppid>/cmdline  -> LEAKED
//   round 2, environment: /proc/<ppid>/environ  -> LEAKED
//                         `ps eww -p <ppid>`    -> LEAKED
// Round 2 captured the key into a local and called
// `delete process.env.OPENROUTER_API_KEY`. That is NOT a scrub of the process's
// environment: delete calls unsetenv, which edits the in-heap environ array
// only. It does not rewrite the mm->env_start..env_end stack region that
// /proc/<pid>/environ and `ps eww` read, so the ORIGINAL environment stayed
// readable for this process's whole lifetime. What the delete does fix is
// narrower and real: children spawned AFTER it inherit an env without the key.
// A `ps -eo args` check (which prints arguments, never the environment)
// reported clean and was mistaken for proof.
//
// So: the config — key included — arrives on STDIN. A pipe has no /proc mirror,
// is consumed exactly once by the read below, and is never re-readable by
// anything, descendant or otherwise. Nothing is in argv (this file refuses an
// argv config outright, see below) and nothing is in the environment (the
// orchestrator spawns this worker with an ALLOWLISTED env that has no
// OPENROUTER_API_KEY in it at all — see WORKER_ENV_ALLOWLIST in
// harness-eval.mjs). makeOpenRouterFactory takes the key as a plain function
// argument, so nothing downstream ever needs it in the environment either.
//
// The delete below is kept as belt-and-braces for the hand-run case (a human
// invoking this worker from a shell that happens to export the key). It is NOT
// the mechanism, and on its own it is known-insufficient — see above.
// ---------------------------------------------------------------------------
delete process.env.OPENROUTER_API_KEY;

function fail(message) {
  console.error(`harness-eval-worker: ${message}`);
  process.exit(1);
}

// Refuse an argv config rather than silently accepting one: a caller still
// passing JSON on argv would be putting the key back into /proc/<pid>/cmdline,
// and a clear error is what routes them to the stdin channel instead.
if (process.argv[2]) {
  fail('the config is read from STDIN, not argv — a config on argv puts the API key into /proc/<pid>/cmdline, where the model\'s own Bash tool (a descendant of this process) can read it. Pipe the JSON in instead.');
}

if (process.stdin.isTTY) {
  fail('no config was piped in (stdin is a terminal). Usage: echo \'<json config>\' | node test-engine/harness-eval-worker.mjs');
}

let raw = '';
process.stdin.setEncoding('utf8');
// setEncoding on the STREAM, for the same reason the orchestrator does it on
// the worker's stdout: a multi-byte character split across two chunks decodes
// to U+FFFD if each Buffer is coerced on its own, which would corrupt the
// prompt or instructions text this config carries.
for await (const chunk of process.stdin) raw += chunk;

if (!raw.trim()) fail('stdin closed without a config (expected one JSON object).');

let config;
try {
  config = JSON.parse(raw);
} catch (err) {
  fail(`the config on stdin is not valid JSON: ${err.message}`);
}

const {
  cellId, dist, modelId, label, apiKey,
  prompt, wrapUpPrompt, contextLength, instructions, instructionsFile,
} = config;

// Missing-field checks happen BEFORE any import or spend — a malformed
// config is "the run could not start" (task brief, Step 4's third bullet),
// not a run result worth recording.
for (const [field, value] of [['cellId', cellId], ['dist', dist], ['modelId', modelId]]) {
  if (!value) fail(`config is missing required field "${field}".`);
}
// The key IS a config field again (round 2 → 3: argv → env → stdin). Naming
// the channel is what makes this error actionable.
if (!apiKey) fail('the config on stdin has no "apiKey" (the orchestrator puts the OpenRouter key there — never on argv, never in the environment).');
// Fix (review round 1, IMPORTANT 1): runCase() defaults `prompt` to the
// harness-review BATTERY_PROMPT when it is absent. Without this check, a
// config that lost its case body would run the default battery and be
// reported as whatever case the cell id names — N identical paid runs
// masquerading as a matrix. Name the case so the gap is obvious.
if (typeof prompt !== 'string' || !prompt) {
  fail(`config for case "${config.caseId ?? '(unnamed)'}" has no "prompt" — refusing to run, because runCase() would silently fall back to the default battery prompt and bill it as this case.`);
}
// Fix (review round 2, IMPORTANT 2): the same refusal on the INSTRUCTIONS axis.
// An arm that names a file but carries no resolved text produces a config
// identical to every other arm's, so the arms would be one repeated task billed
// and reported as an instructions comparison. `instructionsFile: null` (the
// baseline arm) has nothing to resolve and is fine.
if (instructionsFile && (typeof instructions !== 'string' || !instructions)) {
  fail(`config for instruction arm "${config.instructionsId ?? '(unnamed)'}" names a file ("${instructionsFile}") but carries no resolved "instructions" text — refusing to run, because this config is byte-identical to every other arm's and would be billed as an instructions comparison.`);
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
