import { describe, it, expect } from 'vitest';
import {
  ENGINE_VERSION, ENGINE_ASSETS, pickAsset, assetUrl, defaultBackend,
} from '../src/main/engine/engine-pin';

describe('engine-pin', () => {
  it('every asset row is fully populated (no placeholder checksums or paths)', () => {
    expect(ENGINE_ASSETS.length).toBeGreaterThan(0);
    for (const a of ENGINE_ASSETS) {
      expect(a.assetName).toContain(ENGINE_VERSION);
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.binaryRelPath.length).toBeGreaterThan(0);
    }
  });

  it('picks the Vulkan build on Windows x64 and the Metal (default) build on macOS arm64', () => {
    const win = pickAsset('win32', 'x64', 'vulkan');
    expect(win?.assetName).toBe(`llama-${ENGINE_VERSION}-bin-win-vulkan-x64.zip`);
    const mac = pickAsset('darwin', 'arm64', 'metal');
    expect(mac?.assetName).toBe(`llama-${ENGINE_VERSION}-bin-macos-arm64.tar.gz`);
  });

  it('returns null for combinations upstream does not ship (Linux CUDA)', () => {
    expect(pickAsset('linux', 'x64', 'cuda')).toBeNull();
  });

  it('defaultBackend: metal on darwin, vulkan elsewhere', () => {
    expect(defaultBackend('darwin')).toBe('metal');
    expect(defaultBackend('win32')).toBe('vulkan');
    expect(defaultBackend('linux')).toBe('vulkan');
  });

  it('assetUrl points at the pinned ggml-org release', () => {
    const a = pickAsset('win32', 'x64', 'cpu')!;
    expect(assetUrl(a)).toBe(
      `https://github.com/ggml-org/llama.cpp/releases/download/${ENGINE_VERSION}/${a.assetName}`
    );
  });
});
