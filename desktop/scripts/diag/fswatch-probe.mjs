#!/usr/bin/env node
// Minimal reproduction harness for the recurring macOS CI failure where a
// directory watcher delivers ZERO events (docs/active/investigations/
// 2026-09-01-sync-engine-debounce-macos-flake.md). It deliberately contains no
// YouCoded code: just Node's own fs.watch, so a failure here indicts the
// platform rather than git-watcher or sync-spaces.
//
// One trial = mkdtemp, fs.watch it, create a file inside, wait for the first
// event. A trial that times out is the exact CI signature ("0 events, not a
// slow one").
//
// Modes:
//   --trials N        trials in this process (default 50)
//   --timeout MS      per-trial wait before declaring zero events (default 3000)
//   --watchers N      concurrent live watchers held open during the run (default 1)
//   --op create|modify   what the trial does to trigger the event (default create)
//   --json            emit one JSON summary line (used by the parent below)
//   --procs N         run N CHILD copies of this probe concurrently and
//                     aggregate — this is the load dimension the CI failure
//                     correlates with
//   --cpu N           N busy-loop processes running alongside, to contend

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, fork } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

const TRIALS = Number(flag('trials', 50));
const TIMEOUT = Number(flag('timeout', 3000));
const WATCHERS = Number(flag('watchers', 1));
const OP = String(flag('op', 'create'));
const PROCS = Number(flag('procs', 0));
const CPU = Number(flag('cpu', 0));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One trial. Resolves { ok, ms } — ok:false means zero events within TIMEOUT. */
async function trial(i) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fswatch-probe-'));
  const target = path.join(dir, 'target');
  // 'modify' needs the file to already exist, so the write is a content change
  // rather than a directory-entry creation — kqueue and FSEvents differ here.
  if (OP === 'modify') await fs.promises.writeFile(target, 'seed');

  let watcher;
  try {
    const started = Date.now();
    const got = new Promise((resolve) => {
      watcher = fs.watch(dir, () => resolve(Date.now() - started));
      watcher.on('error', () => resolve(-1));
    });
    // Give the watch a moment to arm before writing. A too-eager write is a
    // real source of missed events and would be a finding in itself, so this
    // is deliberately generous — we are testing steady-state delivery.
    await sleep(50);
    await fs.promises.writeFile(target, `trial-${i}`);
    const ms = await Promise.race([got, sleep(TIMEOUT).then(() => null)]);
    return ms === null ? { ok: false, ms: TIMEOUT } : { ok: ms >= 0, ms };
  } finally {
    try { watcher?.close(); } catch { /* already closed */ }
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

/** Hold N extra watchers open for the duration, to test whether the count of
 *  live watchers in one process is the variable. */
async function openIdleWatchers(n) {
  const held = [];
  for (let i = 0; i < n; i++) {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'fswatch-idle-'));
    try { held.push({ dir, w: fs.watch(dir, () => {}) }); } catch (e) {
      return { held, error: String(e?.code ?? e) };
    }
  }
  return { held, error: null };
}

async function runSelf() {
  const idle = await openIdleWatchers(Math.max(0, WATCHERS - 1));
  const results = [];
  for (let i = 0; i < TRIALS; i++) results.push(await trial(i));
  for (const h of idle.held) {
    try { h.w.close(); } catch { /* closed */ }
    await fs.promises.rm(h.dir, { recursive: true, force: true });
  }
  const missed = results.filter((r) => !r.ok).length;
  const times = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b);
  return {
    pid: process.pid,
    trials: TRIALS,
    missed,
    idleWatcherError: idle.error,
    medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
    maxMs: times.length ? times[times.length - 1] : null,
  };
}

function burnCpu(n) {
  const kids = [];
  for (let i = 0; i < n; i++) {
    kids.push(spawn(process.execPath, ['-e', 'const e=Date.now()+600000;while(Date.now()<e){Math.sqrt(Math.random())}'], { stdio: 'ignore' }));
  }
  return kids;
}

async function runParent() {
  const self = fileURLToPath(import.meta.url);
  const cpuKids = burnCpu(CPU);
  const childArgs = ['--trials', String(TRIALS), '--timeout', String(TIMEOUT),
    '--watchers', String(WATCHERS), '--op', OP, '--json'];
  const kids = Array.from({ length: PROCS }, () => fork(self, childArgs, { silent: true }));
  const summaries = await Promise.all(kids.map((k) => new Promise((resolve) => {
    let out = '';
    k.stdout.on('data', (d) => { out += d; });
    k.on('exit', () => {
      const line = out.trim().split('\n').filter(Boolean).pop();
      try { resolve(JSON.parse(line)); } catch { resolve({ parseError: out.slice(0, 300) }); }
    });
  })));
  for (const k of cpuKids) k.kill('SIGKILL');

  const totalTrials = summaries.reduce((a, s) => a + (s.trials ?? 0), 0);
  const totalMissed = summaries.reduce((a, s) => a + (s.missed ?? 0), 0);
  console.log(JSON.stringify({
    mode: 'parent', procs: PROCS, cpuLoad: CPU, op: OP, watchersPerProc: WATCHERS,
    platform: process.platform, node: process.version, cpus: os.cpus().length,
    totalTrials, totalMissed, perProc: summaries,
  }, null, 1));
  process.exitCode = totalMissed > 0 ? 1 : 0;
}

if (PROCS > 0) {
  await runParent();
} else {
  const summary = await runSelf();
  if (has('json')) console.log(JSON.stringify(summary));
  else console.log(JSON.stringify({ ...summary, platform: process.platform, node: process.version }, null, 1));
  process.exitCode = summary.missed > 0 ? 1 : 0;
}
