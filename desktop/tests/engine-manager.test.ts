import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager, selectInstallAsset } from '../src/main/engine/engine-manager';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';
import { updateEngineConfig } from '../src/main/engine/engine-config';

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
      local: { sizeBytes: 4, quant: 'unknown', installed: true, state: 'unloaded' },
    }]);
  });

  it('installedModels(): quant parsing + summed multi-part size + parts', async () => {
    plantInstall();
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'), Buffer.alloc(2));
    fs.writeFileSync(path.join(cacheDir, 'M-UD-Q4_K_XL-00002-of-00002.gguf'), Buffer.alloc(3));
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir } }));
    const mgr = new EngineManager(home, userData, 9999);
    const models = await mgr.installedModels();
    // sizeBytes is summed across the set's published parts. The row also
    // carries the download state (2026-08-27): both parts are present, so this
    // one is complete, and a complete row needs no manifest fields.
    expect(models).toEqual([{
      id: 'M-UD-Q4_K_XL-00001-of-00002', sizeBytes: 5,
      quant: 'UD-Q4_K_XL', quantDescription: expect.stringMatching(/unsloth/i),
      parts: 2, partsPresent: 2, status: 'complete',
      totalSizeBytes: null, repo: null,
    }]);
  });

  it('deleteModel(): removes every part + partials', async () => {
    plantInstall();
    const cacheDir = path.join(root, 'cache'); fs.mkdirSync(cacheDir, { recursive: true });
    for (const n of ['M-UD-Q4_K_XL-00001-of-00002.gguf', 'M-UD-Q4_K_XL-00002-of-00002.gguf']) {
      fs.writeFileSync(path.join(cacheDir, n), Buffer.alloc(1));
    }
    await home.mutateJson('config.json', () => ({ v: 1, engine: { cacheDir } }));
    const mgr = new EngineManager(home, userData, 9999);
    await mgr.deleteModel('M-UD-Q4_K_XL-00001-of-00002');
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });
});

describe('EngineManager — local downloads', () => {
  let cacheDir: string;
  let manager: EngineManager;

  beforeEach(async () => {
    // A real cache dir under the per-test tmp root. Without this the manager
    // reads ~/.cache/llama.cpp — the developer's actual models.
    cacheDir = path.join(root, 'cache');
    fs.mkdirSync(cacheDir, { recursive: true });
    await updateEngineConfig(home, { cacheDir });
    manager = new EngineManager(home, userData, 9999);
  });

  const manifest = (repo: string, files: string[], totalSizeBytes: number) => JSON.stringify({
    v: 1, repo, quant: 'UD-Q4_K_XL', files, totalSizeBytes, sha256ByFile: {}, startedAt: 1,
  });
  /** A manifest for a download that FINISHED — the state every completed
   *  download is left in since 2026-09-05. */
  const doneManifest = (repo: string, files: string[], totalSizeBytes: number) => JSON.stringify({
    v: 1, repo, quant: 'UD-Q4_K_XL', files, totalSizeBytes, sha256ByFile: {},
    startedAt: 1, completedAt: 2,
    visionFile: { path: 'mmproj-F16.gguf', size: 900, sha256: null },
  });

  it('reports a complete model, an unfinished one with its manifest, and an untraceable one', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00004.gguf'), Buffer.alloc(10));
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00003-of-00004.gguf.partial'), Buffer.alloc(5));
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00004.gguf.download.json'),
      manifest('unsloth/Half-GGUF', ['Half-UD-Q4_K_XL-00001-of-00004.gguf'], 100));
    fs.writeFileSync(path.join(cacheDir, 'Old-UD-Q4_K_XL-00001-of-00002.gguf'), Buffer.alloc(20));

    const rows = await manager.installedModels();
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));

    expect(byId['Whole-Q4_K_M']).toMatchObject({
      status: 'complete', sizeBytes: 50, parts: 1, partsPresent: 1,
      totalSizeBytes: null, repo: null,
    });
    expect(byId['Half-UD-Q4_K_XL-00001-of-00004']).toMatchObject({
      status: 'unfinished', sizeBytes: 15, parts: 4, partsPresent: 1,
      totalSizeBytes: 100, repo: 'unsloth/Half-GGUF', quant: 'UD-Q4_K_XL',
    });
    expect(byId['Old-UD-Q4_K_XL-00001-of-00002']).toMatchObject({
      status: 'untraceable', sizeBytes: 20, parts: 2, partsPresent: 1,
      totalSizeBytes: null, repo: null,
    });
  });

  it('a download that stopped before its first byte is an unfinished row at 0 bytes', async () => {
    fs.writeFileSync(path.join(cacheDir, 'New-Q4_K_M.gguf.download.json'),
      manifest('unsloth/New-GGUF', ['New-Q4_K_M.gguf'], 100));
    const rows = await manager.installedModels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'New-Q4_K_M', status: 'unfinished', sizeBytes: 0, totalSizeBytes: 100, repo: 'unsloth/New-GGUF',
    });
  });

  it('an unreadable manifest with no bytes is nothing the user can act on — dropped and removed', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Junk-Q4_K_M.gguf.download.json'), '{not json');
    expect(await manager.installedModels()).toEqual([]);
    expect(fs.existsSync(path.join(cacheDir, 'Junk-Q4_K_M.gguf.download.json'))).toBe(false);
  });

  // Was: 'removes a stale manifest left beside a COMPLETE set'. The manifest now
  // OUTLIVES the download — it is the only record of the repo a finished model
  // came from — so a complete set keeps it, and completedAt (not presence) is
  // what says the download is over.
  it('KEEPS a finished manifest beside a complete set, and never calls it unfinished', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'),
      doneManifest('a/b', ['Whole-Q4_K_M.gguf'], 50));
    const rows = await manager.installedModels();
    expect(rows[0].status).toBe('complete');
    expect(fs.existsSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'))).toBe(true);
    const kept = JSON.parse(fs.readFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'), 'utf8'));
    expect(kept.completedAt).toBe(2);                       // untouched
    expect(kept.visionFile.path).toBe('mmproj-F16.gguf');   // what §E needs later
  });

  it('a complete set whose manifest was never stamped is HEALED, not thrown away', async () => {
    // The crash window: the last part published, the app died before the stamp.
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'),
      manifest('a/b', ['Whole-Q4_K_M.gguf'], 50));
    const rows = await manager.installedModels();
    expect(rows[0].status).toBe('complete');
    const healed = JSON.parse(fs.readFileSync(path.join(cacheDir, 'Whole-Q4_K_M.gguf.download.json'), 'utf8'));
    expect(typeof healed.completedAt).toBe('number');
    expect(healed.repo).toBe('a/b');
  });

  it('a stamped manifest with no bytes at all is a leftover, not an unfinished row', async () => {
    // The files were deleted from under a finished download: nothing to resume,
    // nothing to show, so the record goes with them.
    fs.writeFileSync(path.join(cacheDir, 'Gone-Q4_K_M.gguf.download.json'),
      doneManifest('a/b', ['Gone-Q4_K_M.gguf'], 50));
    expect(await manager.installedModels()).toEqual([]);
    expect(fs.existsSync(path.join(cacheDir, 'Gone-Q4_K_M.gguf.download.json'))).toBe(false);
  });

  it('deleteModel removes the manifest along with the parts', async () => {
    fs.writeFileSync(path.join(cacheDir, 'M-Q4_K_M.gguf.partial'), Buffer.alloc(10));
    fs.writeFileSync(path.join(cacheDir, 'M-Q4_K_M.gguf.download.json'), '{}');
    // No supervisor is running in this fixture, so refreshModels() is a no-op
    // — deleteModel needs no engine.
    await manager.deleteModel('M-Q4_K_M');
    expect(fs.readdirSync(cacheDir)).toEqual([]);
  });
});
