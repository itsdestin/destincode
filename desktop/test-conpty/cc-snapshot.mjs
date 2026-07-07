#!/usr/bin/env node
// CC behavior snapshot.
//
// Probes Claude Code's TUI for the behaviors YouCoded silently couples to,
// captures them as a JSON snapshot, and writes it to test-conpty/snapshots/.
// Run on each CC version bump: diff the new snapshot vs the prior to spot
// drift before users do.
//
// Each probed behavior maps to an entry in `youcoded/docs/cc-dependencies.md`.
// When a probe value changes, the corresponding entry's break-symptom column
// tells you what to fix.
//
// Probes (current set; add more as new couplings are discovered):
//   1. Paste-classification length threshold — binary-search for the smallest
//      atomic body-then-CR write that DOESN'T submit (gets classified as paste,
//      \r becomes literal newline). The worker's chunking is sized below this.
//      Empirical answer for v2.1.119: between 6 (submits) and 101 (fails).
//   2. Input-bar echo — does CC echo typed bytes back via stdout? The
//      planned echo-driven worker depends on this. Verified by writing a
//      short body and observing the bytes appear in stdout.
//   3. Metadata — CC version, Node version, platform, capture timestamp.
//
// Cost: each paste-threshold probe spawns a fresh CC and kills it before the
// assistant turn produces tokens; total bisection is ~7 spawns. Echo probe
// is one more spawn. Total: ~5-7 min and a handful of tokens.
//
// Usage:  cd youcoded/desktop && node test-conpty/cc-snapshot.mjs

import pty from 'node-pty';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- helpers (shared with test-multiline-submit.mjs) ----------------------

function resolveClaudeCommand() {
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';')
    : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, 'claude' + ext);
      if (fs.existsSync(full)) return full;
    }
  }
  throw new Error('claude not found on PATH');
}

function pretrustCwd(cwd) {
  const cfgPath = path.join(os.homedir(), '.claude.json');
  if (!fs.existsSync(cfgPath)) return;
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.projects = cfg.projects || {};
  const fwd = cwd.replace(/\\/g, '/');
  cfg.projects[fwd] = { ...(cfg.projects[fwd] || {}), hasTrustDialogAccepted: true };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

function stripAnsi(s) {
  return s
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '');
}

function captureClaudeVersion() {
  try {
    const claude = resolveClaudeCommand();
    const out = execFileSync(claude, ['--version'], { encoding: 'utf8', timeout: 5000 });
    const m = out.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : out.trim();
  } catch (e) {
    return `error: ${e.message}`;
  }
}

// Boot a CC instance to a known-ready state (welcome screen visible, input
// bar attached). Returns { child, kill, buffer, ready } — buffer accumulates
// ANSI-stripped stdout, kill terminates the process.
async function bootClaude({ readyTimeoutMs = 25000 } = {}) {
  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const cwd = path.join(os.tmpdir(), `cc-snapshot-${stamp}`);
  fs.mkdirSync(cwd, { recursive: true });
  pretrustCwd(cwd);

  const claude = resolveClaudeCommand();
  const child = pty.spawn(claude, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: { ...process.env },
  });

  const rawChunks = [];
  let buffer = '';
  child.onData((data) => {
    rawChunks.push({ t: Date.now(), data });
    buffer += stripAnsi(data);
    if (buffer.length > 100000) buffer = buffer.slice(-100000);
  });

  // Wait for input bar to be live. Welcome screen appears after CC has
  // attached its stdin handler — give a generous post-welcome wait so
  // probe writes don't race the listener.
  const deadline = Date.now() + readyTimeoutMs;
  let ready = false;
  while (Date.now() < deadline) {
    if (/Welcome|Tips|Recent\s*activity/i.test(buffer)) {
      await sleep(3500);
      ready = true;
      break;
    }
    await sleep(150);
  }

  const kill = async () => {
    try { child.kill(); } catch {}
    await sleep(200);
    try { child.kill('SIGKILL'); } catch {}
  };

  return { child, kill, ready, getBuffer: () => buffer, rawChunks, cwd };
}

// Run one paste-threshold probe at a given length: write `len` bytes of body
// followed by `\r` atomically, wait for either the turn-active spinner
// (`<gerund>ing…` ellipsis) or a timeout. Returns true if submitted, false
// if stuck (input bar contains `body\n` + cursor — the literal-newline
// bug state).
async function probeAtomicSubmit(len) {
  const { child, kill, ready, getBuffer } = await bootClaude();
  if (!ready) {
    await kill();
    throw new Error(`probeAtomicSubmit(${len}): CC never reached ready state`);
  }

  const markBefore = getBuffer().length;
  // Body: leading marker char + (len-1) filler. Marker varies by len so we
  // don't accidentally match a stray `Hxxx…` from a previous probe (each
  // probe spawns its own CC, so this is belt-and-suspenders).
  const body = String.fromCharCode(0x40 + (len % 26)) + 'x'.repeat(len - 1);
  child.write(body + '\r');

  // 15 s is comfortably above the observed spinner-render delay in test
  // traces (~7-8 s on cold start). If it hasn't appeared by then, the write
  // was classified as paste and \r became a literal newline.
  const submitted = await waitForSubmit(getBuffer, markBefore, 15000);
  await kill();
  return submitted;
}

// Watch buffer for CC's turn-active marker (any `<word>ing…` ellipsis past
// the mark). Resolves true on detection, false on timeout.
async function waitForSubmit(getBuffer, markBefore, timeoutMs) {
  const turnRegex = /([A-Za-z]+ing)…/;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const tail = getBuffer().slice(markBefore);
    if (turnRegex.test(tail)) return true;
    await sleep(250);
  }
  return false;
}

// --- probes ---------------------------------------------------------------

async function probePasteThreshold({ low = 6, high = 100 } = {}) {
  // Bisect: find the smallest length at which atomic body+\r FAILS to submit.
  // Assumes monotonicity (verified empirically for 6 and 101 — values in
  // between haven't been tested but the model says length-gated should be
  // monotonic). Result is `{ minSubmits, maxFails }` — true threshold sits
  // between the two and may shift slightly with Ink internals.
  console.log(`\n[probe] paste threshold — bisecting [${low}, ${high}]`);
  let minSubmits = null;
  let maxFails = null;

  // Start by validating endpoints.
  console.log(`  testing low=${low}...`);
  const lowSubmits = await probeAtomicSubmit(low);
  console.log(`    ${lowSubmits ? 'SUBMITTED' : 'FAILED'} at ${low}`);
  if (!lowSubmits) {
    console.log(`  threshold is at or below ${low} — no bisection possible`);
    return { minSubmits: null, maxFails: low, bisectionRange: [null, low] };
  }
  minSubmits = low;

  console.log(`  testing high=${high}...`);
  const highSubmits = await probeAtomicSubmit(high);
  console.log(`    ${highSubmits ? 'SUBMITTED' : 'FAILED'} at ${high}`);
  if (highSubmits) {
    console.log(`  threshold is above ${high} — extend the search range`);
    return { minSubmits: high, maxFails: null, bisectionRange: [high, null] };
  }
  maxFails = high;

  // Standard bisect — terminate when neighbors are consecutive.
  while (maxFails - minSubmits > 1) {
    const mid = Math.floor((minSubmits + maxFails) / 2);
    console.log(`  testing mid=${mid} (range [${minSubmits}, ${maxFails}])...`);
    const submits = await probeAtomicSubmit(mid);
    console.log(`    ${submits ? 'SUBMITTED' : 'FAILED'} at ${mid}`);
    if (submits) minSubmits = mid;
    else maxFails = mid;
  }

  console.log(`  threshold: submits at ${minSubmits}, fails at ${maxFails}`);
  return { minSubmits, maxFails, bisectionRange: [minSubmits, maxFails] };
}

async function probeEcho() {
  // Verify that CC echoes typed bytes back via stdout. The planned echo-driven
  // worker depends on this. We write a unique short body and check that those
  // bytes appear in the post-write stdout buffer (after ANSI stripping).
  console.log(`\n[probe] echo behavior`);
  const { child, kill, ready, getBuffer } = await bootClaude();
  if (!ready) {
    await kill();
    return { echoes: false, reason: 'CC never reached ready state' };
  }

  const markBefore = getBuffer().length;
  // Use an unambiguous sentinel — random suffix avoids matching any UI text.
  const sentinel = 'echotest-' + Math.random().toString(36).slice(2, 8);
  const writeAt = Date.now();
  child.write(sentinel);

  // Watch for the sentinel to appear in stdout — CC's input bar re-render.
  // Cold-start CC's first input render is slow (5-8 s in test traces), so
  // keep the timeout generous. Once Ink has rendered once it batches faster.
  const deadline = Date.now() + 12000;
  let echoAt = null;
  while (Date.now() < deadline) {
    if (getBuffer().slice(markBefore).includes(sentinel)) {
      echoAt = Date.now();
      break;
    }
    await sleep(50);
  }

  await kill();
  if (echoAt === null) {
    return { echoes: false, sentinel, delayMs: null };
  }
  return { echoes: true, sentinel, delayMs: echoAt - writeAt };
}

// --- main -----------------------------------------------------------------

async function main() {
  const claudeVersion = captureClaudeVersion();
  console.log(`CC snapshot — claude=${claudeVersion} platform=${process.platform} node=${process.version}`);

  const snapshot = {
    schemaVersion: 1,
    claudeVersion,
    platform: process.platform,
    nodeVersion: process.version,
    capturedAt: new Date().toISOString(),
    probes: {},
  };

  try {
    snapshot.probes.pasteThreshold = await probePasteThreshold();
  } catch (e) {
    snapshot.probes.pasteThreshold = { error: e.message };
  }

  try {
    snapshot.probes.echo = await probeEcho();
  } catch (e) {
    snapshot.probes.echo = { error: e.message };
  }

  const outDir = path.join(__dirname, 'snapshots');
  fs.mkdirSync(outDir, { recursive: true });
  const safeVersion = claudeVersion.replace(/[^0-9.]/g, '_');
  const outFile = path.join(outDir, `cc-${safeVersion}.json`);
  fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2) + '\n');

  console.log(`\nSnapshot written: ${outFile}`);
  console.log(JSON.stringify(snapshot, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
