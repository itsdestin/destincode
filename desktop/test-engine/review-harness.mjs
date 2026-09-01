#!/usr/bin/env node
// Run the harness review battery across a roster of models.
//
//   OPENROUTER_API_KEY=sk-... node test-engine/review-harness.mjs
//   node test-engine/review-harness.mjs --dry-run
//   node test-engine/review-harness.mjs --only "Kimi K3"
//
// WHY a dev-run script rather than a test: it costs real money and takes minutes.
// The deterministic guarantees live in the vitest suites; this is the discovery
// pass that finds what nobody thought to assert.
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { execFileSync } from 'child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');

// Fix (2026-08-10 incident): appendReview's heading now needs a build
// identity (see the WHY comment on the metadata line in append-review.ts) —
// but appendReview is pure and can't shell out to git itself. This script
// already isn't pure (it reads/writes the doc), so it resolves the build here
// and hands it in as data. `execFileSync` (not `execSync`) avoids a shell,
// and both calls are wrapped: a missing git binary, a non-repo checkout, or
// any other git failure must not abort a real, paid model run over metadata.
function resolveBuildSha(cwd) {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim().length > 0;
    return dirty ? `${sha}+dirty` : sha;
  } catch {
    return 'unknown';
  }
}

// WHY a walk instead of a fixed `../..`: that only lands on the workspace repo
// (youcoded-dev) from the canonical checkout (youcoded-dev/youcoded/desktop).
// This project's convention is to do non-trivial work in a git worktree, e.g.
// youcoded-dev/youcoded/worktrees/<name>/desktop, which sits one level deeper
// — a fixed `../..` would silently resolve to youcoded-dev/youcoded/worktrees,
// mkdirSync would happily create the bogus tree, the paid model calls would
// run to completion, and only the later doc read would fail. Walk upward and
// look for the actual marker directory instead of assuming a fixed depth.
const WORKSPACE_MARKER = 'docs/active/investigations';
// The canonical checkout needs 2 levels up from desktop/ to reach the
// workspace repo (youcoded-dev/youcoded/desktop -> youcoded-dev); the worktree
// layout needs 4 (youcoded-dev/youcoded/worktrees/<name>/desktop -> youcoded-dev).
// 6 leaves headroom for one more level of nesting beyond that.
const SEARCH_DEPTH = 6;
function findWorkspace(start) {
  let candidate = start;
  const searched = [];
  for (let i = 0; i < SEARCH_DEPTH; i++) {
    candidate = path.resolve(candidate, '..');
    searched.push(candidate);
    if (fs.existsSync(path.join(candidate, WORKSPACE_MARKER))) return candidate;
  }
  console.error(`Could not find the workspace repo (looked for "${WORKSPACE_MARKER}" in each of):`);
  for (const dir of searched) console.error(`  ${dir}`);
  process.exit(2);
}
const WORKSPACE = findWorkspace(DESKTOP);
const DOC = path.join(WORKSPACE, 'docs/active/investigations/2026-08-01-native-agent-harness-reviews.md');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyAt = args.indexOf('--only');
const only = onlyAt === -1 ? null : args[onlyAt + 1];

// The compiled output is what runs — build first so this script never diverges
// from the TypeScript the app ships.
//
// WHY only battery.js is imported up front: run-case.js transitively pulls in
// HarnessSession, the tools/ tree, and shared/ — a much bigger import graph than
// this script needs just to print a dry run. Importing it lazily, after the
// --dry-run early-exit below, means `--dry-run` still works even if something
// deep in that graph turns out to need an Electron runtime this plain-Node
// script doesn't have.
// WHY the `dist()` helper: Node's ESM loader rejects a bare absolute path on
// Windows (`D:\...` → ERR_UNSUPPORTED_ESM_URL_SCHEME), so every dynamic
// import of a computed path goes through pathToFileURL. Same file, same loader.
const dist = (rel) => pathToFileURL(path.join(DESKTOP, 'dist/main/harness/eval', rel)).href;
const { loadRoster, BATTERY_PROMPT } = await import(dist('battery.js'));

let roster = loadRoster(path.join(HERE, 'review-roster.json'));
if (only) roster = roster.filter((r) => r.label === only);
if (!roster.length) {
  console.error(only ? `No roster entry labelled "${only}".` : 'Roster is empty.');
  process.exit(2);
}

if (dryRun) {
  console.log('Would run the battery against:');
  for (const r of roster) console.log(`  ${r.label.padEnd(16)} ${r.modelId}`);
  console.log(`\nReviews append to: ${DOC}`);
  console.log(`\n--- battery prompt ---\n${BATTERY_PROMPT}`);
  process.exit(0);
}

const key = process.env.OPENROUTER_API_KEY;
if (!key) {
  console.error('Set OPENROUTER_API_KEY before running the battery.');
  process.exit(2);
}
// Scrub the key from our own env before any battery runs. The Bash tool
// (src/main/harness/tools/bash.ts) spawns subprocesses with `env: process.env`,
// and the battery prompt itself tells the model to test "env var persistence
// across calls" — an open invitation for it to run `env`/`printenv`/`echo
// $OPENROUTER_API_KEY`. Any such tool result lands in `run.events`, which we
// write straight to the transcript JSON on disk below. makeOpenRouterFactory
// takes the key as a plain argument (see openrouter-factory.ts), so nothing
// downstream needs it to still be in the environment.
delete process.env.OPENROUTER_API_KEY;

// Deferred until here — see the WHY above the battery.js import. Only a live
// run needs HarnessSession, the tool tree, and the OpenRouter model factory.
const { runCase } = await import(dist('run-case.js'));
const { appendReview } = await import(dist('append-review.js'));
const { makeOpenRouterFactory } = await import(dist('openrouter-factory.js'));
// Task 5 widened appendReview to require a rendered run-facts block; this is
// the CLI's own call site for that, so it has to build one per run.
const { collectRunFacts, renderRunFacts } = await import(dist('run-facts.js'));

const stamp = new Date().toISOString().slice(0, 10);
const runDir = path.join(WORKSPACE, 'docs/active/investigations/harness-review-runs', stamp);
fs.mkdirSync(runDir, { recursive: true });

// Resolved once per roster run, not per model: the harness build doesn't
// change mid-run, and it's one fewer pair of subprocess calls per entry.
const buildSha = resolveBuildSha(DESKTOP);

for (const entry of roster) {
  console.log(`\n=== ${entry.label} (${entry.modelId}) ===`);
  const slug = entry.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const transcriptPath = path.join(runDir, `${slug}.json`);
  try {
    const run = await runCase({
      modelFactory: makeOpenRouterFactory(key, entry.modelId),
      modelId: entry.modelId,
      label: entry.label,
      // Load-bearing: without it runCase falls back to a 32_768 default that,
      // against the harness's output ceiling, left a NEGATIVE history budget and
      // gave every model amnesia for three paid rounds (2026-08-11).
      contextLength: entry.contextLength,
    });

    // Save the transcript FIRST, unconditionally, before anything can fail. A
    // claim in a review is only checkable if the events behind it survive — and
    // round 5 lost four models entirely because the write sat behind a throw.
    fs.writeFileSync(
      transcriptPath,
      JSON.stringify(
        {
          label: entry.label, modelId: entry.modelId,
          outcome: run.outcome, wrapUpReason: run.wrapUpReason, error: run.error,
          metrics: run.metrics, events: run.events,
        },
        null, 2,
      ),
    );

    const m = run.metrics;
    const ending = run.wrapUpReason ? `wrapped-up (${run.wrapUpReason})` : run.outcome;
    const secs = Math.round(m.wallClockMs / 1000);
    console.log(
      `  ${ending} · ${m.toolCalls} calls · ${m.asks} asks · ${m.stepGates} gates · ` +
      `${m.thinkingEvents} thinking · ${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`,
    );
    console.log(`  tools: ${m.toolsUsed.join(' ') || 'none'}`);
    // ROADMAP L161: what OpenRouter itself billed for this run, when every turn
    // reported it — the per-model, per-round figure the old hand-copied roster
    // average could never give.
    if (m.providerCostUsd !== undefined) console.log(`  provider billed: $${m.providerCostUsd.toFixed(4)}`);
    // Independent of outcome: a wrap-up turn that itself failed still reports
    // outcome 'wrapped-up' (see run-case.ts's outcome comment), so a reader
    // branching only on outcome would miss a real provider failure here.
    if (run.error) console.log(`  error: ${run.error}`);

    if (!run.review.trim()) {
      // Not a failure worth aborting on — the transcript is written and the
      // metrics line above says what happened. appendReview would throw here.
      console.log('  → no review text; transcript only');
      continue;
    }

    // Fix (2026-08-10 incident): a bare date-only `stamp` let three same-day
    // runs produce indistinguishable headings (see append-review.ts). Pass
    // the actual completion instant (full ISO timestamp, not just the date)
    // plus the resolved build identity so appendReview can render both, and
    // the rendered run-facts block (Task 5) so a reader never has to open the
    // transcript JSON to see what the run measurably did.
    const runFacts = renderRunFacts(collectRunFacts(run));
    fs.writeFileSync(
      DOC,
      appendReview(fs.readFileSync(DOC, 'utf8'), { ...run, buildSha, runFacts }, new Date().toISOString()),
    );
    console.log('  → review appended');
  } catch (err) {
    // Fix pass 2, Finding 8: this catch wraps the WHOLE try block, not just
    // runCase — a throw from the review extraction inside runCase, or
    // from session.destroy()/fs.rmSync in its `finally`, or from the
    // fs.writeFileSync/appendReview calls above also lands here, so "runCase
    // only throws when it could not seed the fixture or construct the session"
    // overclaimed what this catch actually guards. Name the transcript path so
    // a failed entry still says where its evidence would have been, even when
    // the failure happened before transcriptPath was ever written to (a run
    // that never got far enough to write it still names where a retry would
    // land). One model erroring must not abort the roster.
    console.error(`  FAILED (${transcriptPath}): ${err?.message ?? err}`);
  }
}

console.log(`\nTranscripts: ${runDir}`);
