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
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.resolve(HERE, '..');
const WORKSPACE = path.resolve(DESKTOP, '..', '..');
const DOC = path.join(WORKSPACE, 'docs/active/investigations/2026-08-01-native-agent-harness-reviews.md');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyAt = args.indexOf('--only');
const only = onlyAt === -1 ? null : args[onlyAt + 1];

// The compiled output is what runs — build first so this script never diverges
// from the TypeScript the app ships.
//
// WHY only battery.js is imported up front: run-battery.js transitively pulls in
// HarnessSession, the tools/ tree, and shared/ — a much bigger import graph than
// this script needs just to print a dry run. Importing it lazily, after the
// --dry-run early-exit below, means `--dry-run` still works even if something
// deep in that graph turns out to need an Electron runtime this plain-Node
// script doesn't have.
const { loadRoster, BATTERY_PROMPT } = await import(path.join(DESKTOP, 'dist/main/harness/review/battery.js'));

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

// Deferred until here — see the WHY above the battery.js import. Only a live
// run needs HarnessSession, the tool tree, and the OpenRouter model factory.
const { runBattery } = await import(path.join(DESKTOP, 'dist/main/harness/review/run-battery.js'));
const { appendReview } = await import(path.join(DESKTOP, 'dist/main/harness/review/append-review.js'));
const { makeOpenRouterFactory } = await import(path.join(DESKTOP, 'dist/main/harness/review/openrouter-factory.js'));

const stamp = new Date().toISOString().slice(0, 10);
const runDir = path.join(WORKSPACE, 'docs/active/investigations/harness-review-runs', stamp);
fs.mkdirSync(runDir, { recursive: true });

for (const entry of roster) {
  console.log(`\n=== ${entry.label} (${entry.modelId}) ===`);
  try {
    const run = await runBattery({
      modelFactory: makeOpenRouterFactory(key, entry.modelId),
      modelId: entry.modelId,
      label: entry.label,
    });
    // Save the transcript BEFORE touching the doc: a claim in a review is only
    // checkable if the events behind it survive. Opus 5's context-cost claim in
    // the 2026-08-01 round was falsifiable only by reading the source by hand.
    const slug = entry.label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    fs.writeFileSync(
      path.join(runDir, `${slug}.json`),
      JSON.stringify({ label: entry.label, modelId: entry.modelId, toolCalls: run.toolCalls, asks: run.asks, events: run.events }, null, 2),
    );
    fs.writeFileSync(DOC, appendReview(fs.readFileSync(DOC, 'utf8'), run, stamp));
    console.log(`  ${run.toolCalls} tool calls, ${run.asks} asks → review appended`);
  } catch (err) {
    // Report the real failure. One model erroring must not abort the roster.
    console.error(`  FAILED: ${err?.message ?? err}`);
  }
}

console.log(`\nTranscripts: ${runDir}`);
