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
// NOTE: the child stays UP through the ?reload=1 check below — killing it here
// (as this probe used to) would make that check test nothing. Torn down at exit.

const rows = Array.isArray(raw?.data) ? raw.data : Array.isArray(raw?.models) ? raw.models : Array.isArray(raw) ? raw : [];
const rawRouterIds = rows.map((m) => m.id ?? m.name).sort();
// The router lists one row per FILE, so a split set shows up as N rows while the
// cache scan collapses it to the first part. That is NOT a naming mismatch — it
// is the router's LISTING granularity, and the app drops the follower rows in
// EngineSupervisor.listModels (shared/gguf-split.ts). Fold them here too, or this
// probe fails the moment probe-download.mjs leaves a split set in cache/
// (measured on b10665, 2026-08-27 — the same rows that put four picker entries in
// front of a user for one model).
const routerIds = rawRouterIds.filter((id) => {
  const part = /-(\d{5})-of-(\d{5})$/.exec(id);
  return part === null || part[1] === '00001';
});
const scan = scanIds(cacheDir);
console.log('router ids (raw):     ', rawRouterIds);
console.log('router ids (followers dropped):', routerIds);
console.log('scan   ids:', scan);
if (JSON.stringify(routerIds) !== JSON.stringify(scan)) {
  console.error('FAIL: cache-scan id derivation does not match router discovery — fix ggufIdFromFileName + engine-dependencies.md');
  child.kill();
  process.exit(1);
}

// ---- ?reload=1 is the ONLY way a running router learns about a new file ----
// Every local model the user downloads while the engine is up depends on this
// query param existing and doing a real re-scan. The unit tests mock fetch, so
// they cannot see upstream dropping or renaming it on an engine bump — this
// probe is what would. If it fails after a bump, local models are broken for
// anyone who downloads one without restarting (that is exactly the 2026-08-16
// bug); find the replacement mechanism before shipping the new engine.
const newName = '__reload_probe__.gguf';
const newPath = path.join(cacheDir, newName);
const seed = routerIds.length
  ? fs.readFileSync(path.join(cacheDir, `${routerIds[0]}.gguf`))
  : null;
if (!seed) {
  console.error('FAIL: no seed GGUF in the probe cache dir — cannot test ?reload=1');
  child.kill(); process.exit(1);
}
fs.writeFileSync(newPath, seed); // a real, loadable GGUF the router has never seen
try {
  const idsAfterPlainGet = (await (await fetch(`http://127.0.0.1:${PORT}/models`)).json())
    .data.map((m) => m.id ?? m.name);
  if (idsAfterPlainGet.includes('__reload_probe__')) {
    // Not a failure — upstream gained an auto-rescan, which would make our
    // refreshModels() redundant rather than wrong. Worth knowing about.
    console.log('NOTE: a plain GET /models now rescans — upstream behavior changed (ours still correct, just belt-and-braces)');
  }
  const idsAfterReload = (await (await fetch(`http://127.0.0.1:${PORT}/models?reload=1`)).json())
    .data.map((m) => m.id ?? m.name);
  if (!idsAfterReload.includes('__reload_probe__')) {
    console.error('FAIL: GET /models?reload=1 did NOT pick up a file added after boot.');
    console.error('  EngineSupervisor.refreshModels()/ensureServable() depend on this.');
    console.error('  See youcoded/docs/engine-dependencies.md → router hot-reload.');
    child.kill(); process.exit(1);
  }
} finally {
  fs.rmSync(newPath, { force: true });
}

child.kill();
console.log('PASS: /models parsed; scan ids match router ids; ?reload=1 picks up a post-boot file');
