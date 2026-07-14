#!/usr/bin/env node
// Probe: GET /models schema + id parity with cache-scan.ts (the engine-OFF list
// MUST match the engine-ON list — model-catalog/engine-manager coupling). The
// id derivation below is a self-contained mirror of cache-scan.ts's
// ggufIdFromFileName + multi-part collapse; if this probe diverges from the
// router, fix BOTH cache-scan.ts and this file, and update engine-dependencies.md.
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const argv = process.argv.slice(2);
const binary = argv[argv.indexOf('--binary') + 1];
if (!binary || binary.startsWith('--')) { console.error('usage: probe-models.mjs --binary <llama-server>'); process.exit(1); }
const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, 'cache');
const PORT = 9972;

// Mirror of cache-scan.ts: id = filename minus .gguf; multi-part
// <name>-00001-of-000NN.gguf sets collapse to the first part's id.
const PART_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;
function scanIds(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /\.gguf$/i.test(n)); } catch { return []; }
  const ids = new Set();
  for (const n of names) {
    const part = PART_RE.exec(n);
    if (part && part[1] !== '00001') continue; // non-first parts fold away
    ids.add(n.replace(/\.gguf$/i, ''));
  }
  return [...ids].sort();
}

const child = spawn(binary, ['--host', '127.0.0.1', '--port', String(PORT), '--no-webui', '--jinja', '--models-dir', cacheDir],
  { env: { ...process.env, LLAMA_CACHE: cacheDir }, stdio: ['ignore', 'inherit', 'inherit'] });
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {}
  await new Promise((r) => setTimeout(r, 250));
}

const raw = await (await fetch(`http://127.0.0.1:${PORT}/models`)).json();
console.log('RAW /models:', JSON.stringify(raw, null, 2));
child.kill();

const rows = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];
const routerIds = rows.map((m) => m.id ?? m.name).sort();
const scan = scanIds(cacheDir);
console.log('router ids:', routerIds);
console.log('scan   ids:', scan);
if (JSON.stringify(routerIds) !== JSON.stringify(scan)) {
  console.error('FAIL: cache-scan id derivation does not match router discovery — fix ggufIdFromFileName + engine-dependencies.md');
  process.exit(1);
}
console.log('PASS: /models parsed; scan ids match router ids');
