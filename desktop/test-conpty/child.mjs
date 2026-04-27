#!/usr/bin/env node
// PTY child used by harness.mjs. Reads stdin in raw mode and appends every
// chunk it receives to LOG_FILE, stamped with ms-since-start. When SLOW=1,
// blocks the event loop for 2s at startup to simulate a backpressured TUI
// (the scenario that breaks YouCoded's current submit path on Windows
// ConPTY: writes pile up in the input pipe, child drains them all at once).
// Output-side writes are suppressed — harness only cares what the child READ.

import fs from 'node:fs';

const SLOW = process.env.SLOW === '1';
const LOG = process.env.LOG_FILE;
if (!LOG) { console.error('LOG_FILE env var required'); process.exit(2); }

const start = process.hrtime.bigint();
const ms = () => (Number(process.hrtime.bigint() - start) / 1e6).toFixed(3);

function log(msg) {
  fs.appendFileSync(LOG, `[${ms()}ms] ${msg}\n`);
}

log(`CHILD_START pid=${process.pid} slow=${SLOW} platform=${process.platform}`);

try {
  process.stdin.setRawMode(true);
} catch (e) {
  log(`RAW_MODE_ERROR ${e.message}`);
}
process.stdin.resume();

// Mimic Claude Code: enable bracketed-paste mode and focus reporting on stdout
// so the terminal (ConPTY) knows the child wants paste markers forwarded.
// Without this, ConPTY may strip \x1b[200~ / \x1b[201~ on the input side
// because the child has not asked for them — that was the v1 harness's blind
// spot. Suppress on env opt-out so we can A/B compare.
if (process.env.NO_BRACKETED !== '1') {
  process.stdout.write('\x1b[?2004h\x1b[?1004h');
  log('ENABLED_BRACKETED_PASTE_MODE');
}

process.stdin.on('data', (chunk) => {
  const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
  const text = JSON.stringify(chunk.toString('utf8'));
  log(`READ len=${chunk.length} hex=[${hex}] text=${text}`);
});

if (SLOW) {
  log(`BLOCKING 2000ms to simulate backpressure`);
  const end = Date.now() + 2000;
  // Busy-spin — event loop cannot service stdin 'data' events during this.
  while (Date.now() < end) { /* spin */ }
  log(`UNBLOCKED`);
}

process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
setTimeout(() => { log('TIMEOUT_EXIT'); process.exit(0); }, 8000);
