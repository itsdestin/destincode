// The ONE place the llama.cpp engine version is pinned (spec §3.1). Bumping
// ENGINE_VERSION is a PR that MUST re-run the test-engine/ probes and re-verify
// docs/engine-dependencies.md — the same discipline as a Claude Code bump.
// Regenerate the table: node scripts/generate-engine-pin.mjs <tag>
// binaryRelPath (path of llama-server inside each archive) is pinned per
// archive family and enforced by engine-acquisition's post-unpack existence
// check — a layout change upstream fails loudly, never installs a broken dir.
// Empirically verified for b9992 (2026-07-13): Windows .zip archives are FLAT
// (llama-server.exe + sibling DLLs at the archive root); macOS/Linux .tar.gz
// archives nest everything under a single `llama-<tag>/` directory (binary at
// `llama-<tag>/llama-server` alongside its .so/.dylib). The tar path is
// therefore VERSION-DEPENDENT — the generator templates the tag in, so a bump
// regenerates it. Do NOT revert to `build/bin/llama-server` (a stale guess).
import type { EngineBackend } from '../../shared/engine-types';

export const ENGINE_VERSION = 'b9992';

export interface EngineAsset {
  platform: 'win32' | 'darwin' | 'linux';
  arch: 'x64' | 'arm64';
  backend: EngineBackend;
  assetName: string;      // exact GitHub release asset filename
  sha256: string;         // from the release API's asset digest
  binaryRelPath: string;  // path of llama-server inside the unpacked archive
}

export const ENGINE_ASSETS: EngineAsset[] = [
  { platform: 'win32', arch: 'x64', backend: 'vulkan', assetName: 'llama-b9992-bin-win-vulkan-x64.zip', sha256: '1f0c8a70e40b019e79c91e1ea280a61e56bcc60b74568de2e2fd47253a5d68f3', binaryRelPath: 'llama-server.exe' },
  { platform: 'win32', arch: 'x64', backend: 'cpu', assetName: 'llama-b9992-bin-win-cpu-x64.zip', sha256: 'a90bb725712dcb4a6aa1150d83ef1f58fe80262614986a0af7f0f9e324ec49b6', binaryRelPath: 'llama-server.exe' },
  { platform: 'win32', arch: 'arm64', backend: 'cpu', assetName: 'llama-b9992-bin-win-cpu-arm64.zip', sha256: '175759763b755f5ab4ae192a1dbe0a85d594b0c61bf369560b0dae9b493e5aab', binaryRelPath: 'llama-server.exe' },
  { platform: 'win32', arch: 'x64', backend: 'cuda', assetName: 'llama-b9992-bin-win-cuda-12.4-x64.zip', sha256: '046cf7630064a90d83c8b7b377239de7fa2326c73582ad95025694ba04f17c5c', binaryRelPath: 'llama-server.exe' },
  { platform: 'darwin', arch: 'arm64', backend: 'metal', assetName: 'llama-b9992-bin-macos-arm64.tar.gz', sha256: 'b6021d0d6f87d58514d92a67c6fe2956638c242fc2aa30a11c370645246b90a0', binaryRelPath: 'llama-b9992/llama-server' },
  { platform: 'darwin', arch: 'x64', backend: 'metal', assetName: 'llama-b9992-bin-macos-x64.tar.gz', sha256: '7a632870b57fc260b2a978404efa8655c427e9433c95b6596b832507991a4389', binaryRelPath: 'llama-b9992/llama-server' },
  { platform: 'linux', arch: 'x64', backend: 'vulkan', assetName: 'llama-b9992-bin-ubuntu-vulkan-x64.tar.gz', sha256: 'cbc3e4928018d0b2b61af8bba22dfe097bfd487ae51184dfa00dc0330f0a3a7b', binaryRelPath: 'llama-b9992/llama-server' },
  { platform: 'linux', arch: 'x64', backend: 'cpu', assetName: 'llama-b9992-bin-ubuntu-x64.tar.gz', sha256: 'a56a9c6c971a36be3b2045fdf458d2fae88700883931c94eb214dff4e19165d9', binaryRelPath: 'llama-b9992/llama-server' },
  { platform: 'linux', arch: 'arm64', backend: 'vulkan', assetName: 'llama-b9992-bin-ubuntu-vulkan-arm64.tar.gz', sha256: '0ff433609ac0ff624e50ae5eb386a56f5989b8b4e86e4b56967200346bac35c8', binaryRelPath: 'llama-b9992/llama-server' },
  { platform: 'linux', arch: 'arm64', backend: 'cpu', assetName: 'llama-b9992-bin-ubuntu-arm64.tar.gz', sha256: '211bc659fa49ac96b311fe41c6249dd29e133654cf48389556845caecb3dd2a6', binaryRelPath: 'llama-b9992/llama-server' },
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
