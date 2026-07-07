#!/usr/bin/env node
// Empirical test of whether Windows ConPTY preserves bracketed-paste byte
// sequences (\x1b[200~ ... \x1b[201~) on the INPUT side of a node-pty session.
//
// Why this matters: the chat→PTY submit path in YouCoded currently relies on
// a 600 ms gap between body bytes and \r (Ink's PASTE_TIMEOUT bypass). That
// gap only exists at the worker's WRITE time; when Claude Code is busy, the
// child reads body+\r together and Ink treats \r as paste content (newline
// instead of submit). Bracketed-paste markers would disambiguate — IF the
// markers actually reach the child intact through ConPTY.
//
// Commit e54faa3 tried markers, commit 5788110 reverted 47 minutes later
// "likely due to Windows ConPTY interfering with escape sequences." That was
// never actually verified. This harness verifies it directly.
//
// Usage:   cd youcoded/desktop && node test-conpty/harness.mjs

import pty from 'node-pty';
import path from 'node:path';
import fs from 'node:fs';
import url from 'node:url';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const CHILD = path.join(__dirname, 'child.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runScenario(name, opts) {
  const logFile = path.join(__dirname, `log-${name}.txt`);
  fs.writeFileSync(logFile, '');

  const child = pty.spawn(process.execPath, [CHILD], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd: __dirname,
    env: { ...process.env, LOG_FILE: logFile, SLOW: opts.slow ? '1' : '0' },
  });

  // Drain child stdout so ConPTY doesn't block — not logged, we only care
  // about what the child READ.
  child.onData(() => {});

  // Give the child a moment to attach its stdin listener + enter raw mode.
  // If the child is in SLOW mode, we wait longer so our writes land during
  // the busy-spin window (which is exactly what "Claude mid-render" reproduces).
  await sleep(100);

  await opts.write(child);

  // Wait long enough for a SLOW child to unblock (2s) plus drain margin.
  await sleep(opts.slow ? 3500 : 1500);

  try { child.kill(); } catch {}
  await sleep(100);

  const log = fs.readFileSync(logFile, 'utf8');
  console.log(`\n=== ${name}${opts.slow ? ' [SLOW child]' : ''} ===`);
  console.log(log);
  return log;
}

async function main() {
  console.log(`node-pty harness — platform=${process.platform} node=${process.version}`);

  // A: Atomic write to idle child. Baseline — should trivially succeed.
  await runScenario('A-atomic-idle', {
    write: (c) => c.write('\x1b[200~hello\x1b[201~\r'),
  });

  // B: Atomic write, same bytes, child busy-spins at startup. This is the
  // analog of the real YouCoded bug: worker writes everything, child reads
  // nothing for 2s, then drains in one batch. If ConPTY preserves markers,
  // the child reads intact \x1b[200~hello\x1b[201~\r and Ink would commit.
  // If ConPTY mangles markers, the child sees something garbled and Ink
  // falls back to the PASTE_TIMEOUT heuristic (which would fail here too).
  await runScenario('B-atomic-busy', {
    slow: true,
    write: (c) => c.write('\x1b[200~hello\x1b[201~\r'),
  });

  // C: Split writes with inter-write delays, child busy. Mirrors the planned
  // worker logic: markers as tiny separate writes + chunked body + trailing
  // \r. Verifies that each small write survives ConPTY on its own.
  await runScenario('C-split-busy', {
    slow: true,
    write: async (c) => {
      c.write('\x1b[200~');
      await sleep(50);
      c.write('hello world this is a longer body to force chunking-like pacing');
      await sleep(50);
      c.write('\x1b[201~');
      await sleep(50);
      c.write('\r');
    },
  });

  // D: Baseline bug repro — no markers, 600 ms gap, busy child. Matches the
  // current production code path. Expect: child reads body + \r together
  // (gap collapsed by backpressure). This is the failure mode we're trying
  // to escape.
  await runScenario('D-body-cr-busy', {
    slow: true,
    write: async (c) => {
      c.write('hello');
      await sleep(600);
      c.write('\r');
    },
  });

  // E: Long body with markers, busy child. Tests whether marker ordering
  // survives when body exceeds one ConPTY write capacity. If ConPTY
  // truncates a big single write, \x1b[201~ could get lost — which is
  // the scenario that killed e54faa3. Body is 300 chars to push past the
  // old single-write threshold.
  const longBody = 'x'.repeat(300);
  await runScenario('E-atomic-long-busy', {
    slow: true,
    write: (c) => c.write('\x1b[200~' + longBody + '\x1b[201~\r'),
  });

  // F: Long body with markers but body is chunked (matches planned worker
  // logic exactly — markers as single writes, body in 64-byte chunks).
  await runScenario('F-split-long-busy', {
    slow: true,
    write: async (c) => {
      c.write('\x1b[200~');
      await sleep(50);
      const CHUNK = 64;
      for (let i = 0; i < longBody.length; i += CHUNK) {
        c.write(longBody.slice(i, i + CHUNK));
        await sleep(50);
      }
      c.write('\x1b[201~');
      await sleep(50);
      c.write('\r');
    },
  });

  console.log('\n=== INTERPRETATION ===');
  console.log('Look at each scenario\'s READ lines:');
  console.log('  - "1b 5b 32 30 30 7e" = \\x1b[200~ (paste start marker)');
  console.log('  - "1b 5b 32 30 31 7e" = \\x1b[201~ (paste end marker)');
  console.log('  - "0d" = \\r (submit)');
  console.log('If markers appear intact in READs, bracketed paste is viable.');
  console.log('If they\'re split into per-char keystrokes or rewritten, it isn\'t.');
}

main().catch((e) => { console.error(e); process.exit(1); });
