import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager, selectInstallAsset } from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';

let root: string;
let userData: string;
let home: NativeHome;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-mgr-'));
  userData = path.join(root, 'userData');
  home = new NativeHome(root);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Plant a fake usable install so status()/hook tests need no download. */
function plantInstall(backend = 'cpu') {
  const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
  fs.writeFileSync(path.join(dir, '.complete'),
    JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe' }));
}

describe('selectInstallAsset (Fix: platforms without the preferred backend)', () => {
  it('falls back to CPU when the preferred backend has no asset for this platform/arch (win arm64)', () => {
    const sel = selectInstallAsset('win32', 'arm64', 'vulkan'); // no win-arm64 vulkan asset ships
    expect(sel?.backend).toBe('cpu');
    expect(sel?.asset.backend).toBe('cpu');
  });
  it('uses the preferred backend when it ships an asset', () => {
    expect(selectInstallAsset('win32', 'x64', 'vulkan')?.backend).toBe('vulkan');
  });
  it('returns null when neither the preferred backend nor CPU ships an asset', () => {
    expect(selectInstallAsset('sunos', 'mips', 'vulkan')).toBeNull();
  });
});

describe('EngineManager', () => {
  it('status(): not-installed before any install; installed afterwards', () => {
    const mgr = new EngineManager(home, userData, 9999);
    expect(mgr.status().state).toBe('not-installed');
    expect(mgr.status().installed).toBe(false);
    plantInstall();
    const s = mgr.status();
    expect(s.installed).toBe(true);
    expect(s.installedVersion).toBe(ENGINE_VERSION);
    expect(s.backend).toBe('cpu');
    expect(s.state).toBe('stopped');
    expect(s.pinnedVersion).toBe(ENGINE_VERSION);
  });

  it('registryHook(): installed() false → ensureRunning throws install guidance', async () => {
    const mgr = new EngineManager(home, userData, 9999);
    const hook = mgr.registryHook();
    expect(hook.installed()).toBe(false);
    await expect(hook.ensureRunning()).rejects.toThrow(/Settings/);
  });

  it('catalogModels(): cache-scan models become providerId "local" CatalogModel rows carrying the CONFIGURED context size', async () => {
    plantInstall();
    const cacheDir = path.join(root, 'gguf-cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'tiny-Q4_K_M.gguf'), Buffer.alloc(4));
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir, contextSize: 8192 } }));
    const mgr = new EngineManager(home, userData, 9999);
    const models = await mgr.catalogModels();
    expect(models).toEqual([{
      id: 'tiny-Q4_K_M',
      providerId: 'local',
      label: 'tiny-Q4_K_M',
      contextLength: 8192, // the -c we spawn with, NOT the model's trained max
      local: { sizeBytes: 4, quant: 'unknown', installed: true },
    }]);
  });
});
