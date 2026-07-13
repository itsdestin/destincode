#!/usr/bin/env node
// Regenerates the ENGINE_ASSETS table for src/main/engine/engine-pin.ts from
// the GitHub release API (assets carry a sha256 `digest`). Usage:
//   node scripts/generate-engine-pin.mjs b9986
// Paste the printed rows into engine-pin.ts, bump ENGINE_VERSION, and re-run
// the test-engine/ probes (engine-dependencies.md). binaryRelPath is computed
// per archive family below — you should NOT need to hand-edit it, but the
// test-engine probes + acquisition's post-unpack existence check will catch it
// if a family's layout ever shifts.
const tag = process.argv[2];
if (!tag) { console.error('usage: generate-engine-pin.mjs <release-tag>'); process.exit(1); }

// Only the variants YouCoded ships (spec §3.1): Vulkan default on win/linux,
// CPU fallback, Metal-by-default macOS builds, CUDA opt-in (Windows only —
// upstream publishes no Linux CUDA asset).
const WANTED = [
  { platform: 'win32',  arch: 'x64',   backend: 'vulkan', suffix: 'bin-win-vulkan-x64.zip' },
  { platform: 'win32',  arch: 'x64',   backend: 'cpu',    suffix: 'bin-win-cpu-x64.zip' },
  { platform: 'win32',  arch: 'arm64', backend: 'cpu',    suffix: 'bin-win-cpu-arm64.zip' },
  { platform: 'win32',  arch: 'x64',   backend: 'cuda',   suffix: 'bin-win-cuda-12.4-x64.zip' },
  { platform: 'darwin', arch: 'arm64', backend: 'metal',  suffix: 'bin-macos-arm64.tar.gz' },
  { platform: 'darwin', arch: 'x64',   backend: 'metal',  suffix: 'bin-macos-x64.tar.gz' },
  { platform: 'linux',  arch: 'x64',   backend: 'vulkan', suffix: 'bin-ubuntu-vulkan-x64.tar.gz' },
  { platform: 'linux',  arch: 'x64',   backend: 'cpu',    suffix: 'bin-ubuntu-x64.tar.gz' },
  { platform: 'linux',  arch: 'arm64', backend: 'vulkan', suffix: 'bin-ubuntu-vulkan-arm64.tar.gz' },
  { platform: 'linux',  arch: 'arm64', backend: 'cpu',    suffix: 'bin-ubuntu-arm64.tar.gz' },
];

// Empirically (b9992): Windows .zip archives are flat (llama-server.exe at the
// root); macOS/Linux .tar.gz archives nest under a single `llama-<tag>/` dir.
// The tar path is version-dependent, so it must be templated with the tag.
function binaryRelPathFor(suffix) {
  return suffix.endsWith('.zip') ? 'llama-server.exe' : `llama-${tag}/llama-server`;
}

const res = await fetch(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`);
if (!res.ok) { console.error(`GitHub API ${res.status}`); process.exit(1); }
const release = await res.json();

for (const w of WANTED) {
  const name = `llama-${tag}-${w.suffix}`;
  const asset = (release.assets ?? []).find((a) => a.name === name);
  if (!asset) { console.error(`// MISSING upstream asset: ${name} — upstream naming changed? Update WANTED.`); continue; }
  const digest = String(asset.digest ?? '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(digest)) { console.error(`// NO sha256 digest for ${name} — compute manually and paste.`); continue; }
  console.log(`  { platform: '${w.platform}', arch: '${w.arch}', backend: '${w.backend}', assetName: '${name}', sha256: '${digest}', binaryRelPath: '${binaryRelPathFor(w.suffix)}' },`);
}
console.log(`\n// ENGINE_VERSION = '${tag}'`);
