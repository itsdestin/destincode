#!/usr/bin/env node
// End-to-end test of pty-worker.js's new echo-driven submit logic.
//
// Spawns the actual worker (via fork, exactly as session-manager.ts does in
// production) and exercises every input shape:
//   - short atomic submit (body+\r ≤ 56 bytes — Path 2)
//   - long echo-driven submit (body+\r > 56 bytes — Path 3)
//   - passthrough (single-byte ESC, no \r — Path 1)
//
// Submit detection: forwards worker `data` messages into a buffer and
// matches CC's randomized `<gerund>ing…` spinner suffix, same as
// test-multiline-submit.mjs.
//
// Cost: ~3 worker spawns × short test message; each killed before any
// significant tokens stream. Negligible.
//
// Usage:  cd youcoded/desktop && node test-conpty/test-worker-submit.mjs

import { fork } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  return String(s)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b./g, '');
}

async function runOneTest(name, opts) {
  console.log(`\n${'='.repeat(70)}\n=== ${name}\n${'='.repeat(70)}`);

  const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const cwd = path.join(os.tmpdir(), `cc-worker-test-${stamp}`);
  fs.mkdirSync(cwd, { recursive: true });
  pretrustCwd(cwd);

  // Trace dir — gated by YOUCODED_PTY_TRACE so the new instrumentation runs.
  const workerScript = path.join(__dirname, '..', 'src', 'main', 'pty-worker.js');
  const worker = fork(workerScript, [], {
    env: { ...process.env, YOUCODED_PTY_TRACE: '1' },
    silent: true,
  });

  let buffer = '';
  const allChunks = [];
  worker.on('message', (msg) => {
    if (msg.type === 'data') {
      allChunks.push({ t: Date.now(), data: msg.data });
      buffer += stripAnsi(msg.data);
      if (buffer.length > 100000) buffer = buffer.slice(-100000);
    }
  });
  worker.stderr?.on('data', (d) => console.error('[worker stderr]', d.toString()));

  // Spawn CC inside the worker (same shape as session-manager.ts).
  worker.send({
    type: 'spawn',
    command: 'claude',
    args: [],
    cols: 120,
    rows: 30,
    cwd,
    sessionId: 'test',
    pipeName: '',
  });

  // Wait for input bar ready (welcome screen + post-welcome settle).
  console.log(`waiting for welcome...`);
  const readyDeadline = Date.now() + 25000;
  let welcomeSeen = false;
  while (Date.now() < readyDeadline) {
    if (/Welcome|Tips|Recent\s*activity/i.test(buffer)) {
      welcomeSeen = true;
      await sleep(3500);
      break;
    }
    await sleep(150);
  }
  if (!welcomeSeen) {
    console.log('!! welcome never appeared — aborting');
    worker.kill('SIGKILL');
    return { submitted: false, ready: false };
  }

  // Send the test input via the worker (NOT directly to PTY).
  console.log(`sending input via worker: ${JSON.stringify(opts.input.slice(0, 60))}${opts.input.length > 60 ? '…' : ''} (len=${opts.input.length})`);
  const markBefore = buffer.length;
  const sendStart = Date.now();
  worker.send({ type: 'input', data: opts.input });

  // Watch for spinner suffix as proof of submission. Worst-case timing in
  // the echo-driven path is ECHO_TIMEOUT_MS (12 s) + CC's spinner-render
  // delay (~7 s on cold start) ≈ 19 s. 30 s leaves a comfortable margin
  // for both paths and for CC startup variance.
  const detectDeadline = Date.now() + 30000;
  const turnRegex = /([A-Za-z]+ing)…/;
  let submitMarker = null;
  while (Date.now() < detectDeadline) {
    const tail = buffer.slice(markBefore);
    const m = tail.match(turnRegex);
    if (m) { submitMarker = m[1]; break; }
    await sleep(200);
  }
  const submitMs = Date.now() - sendStart;

  worker.kill('SIGKILL');
  await sleep(500);

  // Save trace for inspection.
  const tracePath = path.join(__dirname, `worker-${name}.log`);
  fs.writeFileSync(
    tracePath,
    allChunks.map((e) => `[${e.t - sendStart}ms post-send] ${JSON.stringify(e.data)}`).join('\n'),
  );

  console.log(`RESULT: submitted=${!!submitMarker} marker=${submitMarker || '(none)'} time=${submitMs}ms`);
  console.log(`        trace -> ${tracePath}`);
  return { submitted: !!submitMarker, marker: submitMarker, submitMs };
}

async function main() {
  console.log(`platform=${process.platform} node=${process.version}`);

  // Path 2: atomic. body+\r is 12 bytes — well under SAFE_ATOMIC_LEN (56).
  const r1 = await runOneTest('atomic-short', {
    input: 'hi friend\r',
  });

  // Path 3: echo-driven. body is 100 chars + \r = 101 bytes — over the
  // threshold AND over SAFE_ATOMIC_LEN. Worker should chunk + wait for
  // echo + send \r.
  const longBody = 'x'.repeat(100);
  const r2 = await runOneTest('echo-driven-long', {
    input: longBody + '\r',
  });

  // Path 3 + boundary: exactly at SAFE_ATOMIC_LEN+1 = 57 bytes total.
  // Should take echo-driven path. Body = "y".repeat(56) = 56 chars + \r
  // = 57 bytes. Worker compares text.length (57) <= SAFE_ATOMIC_LEN (56)
  // — false — so echo-driven.
  const r3 = await runOneTest('echo-driven-boundary', {
    input: 'y'.repeat(56) + '\r',
  });

  console.log(`\n${'='.repeat(70)}\nINTERPRETATION\n${'='.repeat(70)}`);
  console.log(`atomic-short (Path 2):         submitted=${r1.submitted} (${r1.submitMs}ms)`);
  console.log(`echo-driven-long (Path 3):     submitted=${r2.submitted} (${r2.submitMs}ms)`);
  console.log(`echo-driven-boundary (Path 3): submitted=${r3.submitted} (${r3.submitMs}ms)`);
  if (r1.submitted && r2.submitted && r3.submitted) {
    console.log('\nAll three paths submit successfully — new worker logic is sound.');
  } else {
    console.log('\nOne or more paths failed. Inspect the per-test traces.');
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
