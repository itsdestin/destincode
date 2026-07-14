#!/usr/bin/env node
// Probe: router-mode spawn + /health readiness (engine-supervisor coupling).
// Spawns llama-server with the EXACT flag set engine-supervisor.ts uses.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const binary = argv[argv.indexOf('--binary') + 1];
if (!binary || binary.startsWith('--')) { console.error('usage: probe-health.mjs --binary <llama-server>'); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = 9971;

// Mirrors engine-supervisor.ts: router mode (no -m), --no-webui --jinja,
// --models-dir <cache> (what actually serves dropped GGUFs), --models-max 2,
// -c <contextSize>.
const child = spawn(binary, [
  '--host', '127.0.0.1', '--port', String(PORT),
  '--no-webui', '--jinja', '--models-dir', path.join(here, 'cache'), '--models-max', '2', '-c', '4096',
], { env: { ...process.env, LLAMA_CACHE: path.join(here, 'cache') }, stdio: ['ignore', 'inherit', 'inherit'] });

const deadline = Date.now() + 30_000;
let ok = false;
while (Date.now() < deadline) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    if (res.ok) {
      // b9992 returns 200 with body {"status":"ok"}. The supervisor only checks
      // res.ok and never parses the body, so the exact shape doesn't matter.
      const body = await res.text().catch(() => '');
      console.log('HEALTH:', res.status, JSON.stringify(body));
      ok = true;
      break;
    }
  } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 250));
}
child.kill();
if (!ok) { console.error('FAIL: /health never became ready'); process.exit(1); }
console.log('PASS: router mode boots with our flag set and reports healthy');
