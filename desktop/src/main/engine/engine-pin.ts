// The ONE place the llama.cpp engine version is pinned (spec §3.1). Bumping
// ENGINE_VERSION is a PR that MUST re-run the test-engine/ probes and re-verify
// docs/engine-dependencies.md — the same discipline as a Claude Code bump.
// Regenerate the table: node scripts/generate-engine-pin.mjs <tag>
// binaryRelPath (path of llama-server inside each archive) is pinned per
// archive family and enforced by engine-acquisition's post-unpack existence
// check — a layout change upstream fails loudly, never installs a broken dir.
// Empirically verified for b10665 (2026-08-27): Windows .zip archives are FLAT
// (llama-server.exe + sibling DLLs at the archive root); macOS/Linux .tar.gz
// archives nest everything under a single `llama-<tag>/` directory (binary at
// `llama-<tag>/llama-server` alongside its .so/.dylib). The tar path is
// therefore VERSION-DEPENDENT — the generator templates the tag in, so a bump
// regenerates it. Do NOT revert to `build/bin/llama-server` (a stale guess).
import type { EngineBackend } from '../../shared/engine-types';

export const ENGINE_VERSION = 'b10665';

export interface EngineAsset {
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  backend: EngineBackend;
  assetName: string;      // exact GitHub release asset filename
  sha256: string;         // from the release API's asset digest
  binaryRelPath: string;  // path of llama-server inside the unpacked archive
}

export const ENGINE_ASSETS: EngineAsset[] = [
  { platform: 'win32', arch: 'x64', backend: 'vulkan', assetName: 'llama-b10665-bin-win-vulkan-x64.zip', sha256: '9bee8af29495148c04c62cd2e254cf6310686d89025f04a4884eb3d7c4031f0d', binaryRelPath: 'llama-server.exe' },
  { platform: 'win32', arch: 'x64', backend: 'cpu', assetName: 'llama-b10665-bin-win-cpu-x64.zip', sha256: '4b039869c48c2f5842ccc0c005cb36437bac33476be2d661f85e2814a7681af0', binaryRelPath: 'llama-server.exe' },
  { platform: 'win32', arch: 'arm64', backend: 'cpu', assetName: 'llama-b10665-bin-win-cpu-arm64.zip', sha256: 'fa296ac9312b894e8ca1c620623a0620907202ae023b957959997b64abf7ec02', binaryRelPath: 'llama-server.exe' },
  { platform: 'win32', arch: 'x64', backend: 'cuda', assetName: 'llama-b10665-bin-win-cuda-12.4-x64.zip', sha256: 'd9b05b81a3f60d30f6625e5561139af505a7ac1fd933c82ee9067ebbada0887a', binaryRelPath: 'llama-server.exe' },
  { platform: 'darwin', arch: 'arm64', backend: 'metal', assetName: 'llama-b10665-bin-macos-arm64.tar.gz', sha256: 'bea206745e751cf8957eb729cc8f2950ca5e5340e29aaa9a055a0e4100dabdd1', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'darwin', arch: 'x64', backend: 'metal', assetName: 'llama-b10665-bin-macos-x64.tar.gz', sha256: '6c976150c7f74509c60b7cfa04ee31d734d54bcb35fe272cccaa3a2f7f6946aa', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'linux', arch: 'x64', backend: 'vulkan', assetName: 'llama-b10665-bin-ubuntu-vulkan-x64.tar.gz', sha256: '92f8d63384132e6a70b3b106996a5dce06121bbf770eef68500b1cfb7ff22bcc', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'linux', arch: 'x64', backend: 'cpu', assetName: 'llama-b10665-bin-ubuntu-x64.tar.gz', sha256: '7d065b7fe283eac932929bbc92b6e39b58551132a6291d7ab10ea9116997cb4e', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'linux', arch: 'arm64', backend: 'vulkan', assetName: 'llama-b10665-bin-ubuntu-vulkan-arm64.tar.gz', sha256: '746df9199ddfcc11f135f2750d1b38ce73564557642c38bef735fd2f08a9b8f6', binaryRelPath: 'llama-b10665/llama-server' },
  { platform: 'linux', arch: 'arm64', backend: 'cpu', assetName: 'llama-b10665-bin-ubuntu-arm64.tar.gz', sha256: '36983c882d7a88cbc02c190a3980cf397e526d588dd66c684b8cd53385a242a6', binaryRelPath: 'llama-b10665/llama-server' },
];

export function pickAsset(
  platform: NodeJS.Platform | string, arch: string, backend: EngineBackend
): EngineAsset | null {
  return ENGINE_ASSETS.find(
    (a) => a.platform === platform && a.arch === arch && a.backend === backend
  ) ?? null;
}

export function assetUrl(a: EngineAsset): string {
  return `https://github.com/ggml-org/llama.cpp/releases/download/${ENGINE_VERSION}/${a.assetName}`;
}

/** Spec §3.1 defaults: Metal on macOS; Vulkan on Windows/Linux (CPU is the
 *  automatic fallback when the Vulkan build fails to boot — engine-manager). */
export function defaultBackend(platform: NodeJS.Platform | string): EngineBackend {
  return platform === 'darwin' ? 'metal' : 'vulkan';
}
