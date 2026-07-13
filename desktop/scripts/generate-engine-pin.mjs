#!/usr/bin/env node
// Regenerates the ENGINE_ASSETS table for src/main/engine/engine-pin.ts from
// the GitHub release API (assets carry a sha256 `digest`). Usage:
//   node scripts/generate-engine-pin.mjs b9986
// Paste the printed rows into engine-pin.ts, keep/adjust binaryRelPath per
// archive family (verified by the unpack test + test-engine probes), bump
// ENGINE_VERSION, and re-run the test-engine/ probes (engine-dependencies.md).
const tag = process.argv[2];
if (!tag) { console.error('usage: generate-engine-pin.mjs <release-tag>'); process.exit(1); }

// Only the variants YouCoded ships (spec §3.1): Vulkan default on win/linux,
// CPU fallback, Metal-by-default macOS builds, CUDA opt-in (Windows only —
// upstream publishes no Linux CUDA asset).
const WANTED = [
  { platform: 'win32',  arch: 'x64',   backend: 'vulkan', suffix: 'bin-win-vulkan-x64.zip',        binaryRelPath: 'llama-server.exe' },
  { platform: 'win32',  arch: 'x64',   backend: 'cpu',    suffix: 'bin-win-cpu-x64.zip',           binaryRelPath: 'llama-server.exe' },
  { platform: 'win32',  arch: 'arm64', backend: 'cpu',    suffix: 'bin-win-cpu-arm64.zip',         binaryRelPath: 'llama-server.exe' },
  { platform: 'win32',  arch: 'x64',   backend: 'cuda',   suffix: 'bin-win-cuda-12.4-x64.zip',     binaryRelPath: 'llama-server.exe' },
  { platform: 'darwin', arch: 'arm64', backend: 'metal',  suffix: 'bin-macos-arm64.tar.gz',        binaryRelPath: 'build/bin/llama-server' },
  { platform: 'darwin', arch: 'x64',   backend: 'metal',  suffix: 'bin-macos-x64.tar.gz',          binaryRelPath: 'build/bin/llama-server' },
  { platform: 'linux',  arch: 'x64',   backend: 'vulkan', suffix: 'bin-ubuntu-vulkan-x64.tar.gz',  binaryRelPath: 'build/bin/llama-server' },
  { platform: 'linux',  arch: 'x64',   backend: 'cpu',    suffix: 'bin-ubuntu-x64.tar.gz',         binaryRelPath: 'build/bin/llama-server' },
  { platform: 'linux',  arch: 'arm64', backend: 'vulkan', suffix: 'bin-ubuntu-vulkan-arm64.tar.gz',binaryRelPath: 'build/bin/llama-server' },
  { platform: 'linux',  arch: 'arm64', backend: 'cpu',    suffix: 'bin-ubuntu-arm64.tar.gz',       binaryRelPath: 'build/bin/llama-server' },
];

const res = await fetch(`https://api.github.com/repos/ggml-org/llama.cpp/releases/tags/${tag}`);
if (!res.ok) { console.error(`GitHub API ${res.status}`); process.exit(1); }
const release = await res.json();

for (const w of WANTED) {
  const name = `llama-${tag}-${w.suffix}`;
  const asset = (release.assets ?? []).find((a) => a.name === name);
  if (!asset) { console.error(`// MISSING upstream asset: ${name} — upstream naming changed? Update WANTED.`); continue; }
  const digest = String(asset.digest ?? '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(digest)) { console.error(`// NO sha256 digest for ${name} — compute manually and paste.`); continue; }
  console.log(`  { platform: '${w.platform}', arch: '${w.arch}', backend: '${w.backend}', assetName: '${name}', sha256: '${digest}', binaryRelPath: '${w.binaryRelPath}' },`);
}
console.log(`\n// ENGINE_VERSION = '${tag}'`);
