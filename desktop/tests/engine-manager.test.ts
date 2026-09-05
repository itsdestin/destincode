import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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

describe.skipIf(process.platform === 'win32')('EngineManager — the device-list backfill reaches the UI', () => {
  it('emits status-changed once acquisition fills in a pre-feature marker', async () => {
    // status() is pull-only. An engine installed before the device list existed
    // gets it filled in by a background probe, so without this push the user
    // keeps seeing the wrong "runs on" line until some unrelated engine event
    // happens to refetch. Guards the third EngineAcquisition constructor
    // argument, which knip cannot see is unwired.
    const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-cpu`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server'),
      "#!/bin/sh\ncat <<'EOF'\nAvailable devices:\n  Vulkan0: AMD Radeon 8060S Graphics (RADV STRIX_HALO) (86016 MiB, 83660 MiB free)\nEOF\n",
      { mode: 0o755 });
    fs.writeFileSync(path.join(dir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend: 'cpu', binaryRelPath: 'llama-server' }));

    const mgr = new EngineManager(home, userData, 9999);
    let changed = 0;
    mgr.on('status-changed', () => { changed++; });
    expect(mgr.status().installed).toBe(true);   // starts the backfill
    await vi.waitFor(() => { expect(changed).toBeGreaterThan(0); });
    expect(JSON.parse(fs.readFileSync(path.join(dir, '.complete'), 'utf8')).devices[0].totalMiB).toBe(86016);
  });
});

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

// The graphics-chip probe runs OFF the first status() call, so `backendOptions`
// arrives on a 'status-changed' push rather than in the answer that triggered
// it. That push is the only delivery there is — if it can be missed, the card
// waits forever for a second status that never comes. Everything that CAN
// change during a run is recomputed on every status() instead of cached.
// (2026-09-05 local-engine upgrades §A3.)
describe('EngineManager — the deferred chip probe and the live device line', () => {
  const settled = () => new Promise((r) => setTimeout(r, 0));
  const AMD_CHIP = { vendor: 'amd' as const, gfxTarget: 'gfx1151' };
  // The real two-device reading from this machine (engine-acquisition.test.ts):
  // the software renderer reports 124406 MiB of system RAM and is not a GPU.
  const REAL_DEVICES = [
    { backend: 'Vulkan0', name: 'AMD Radeon 8060S Graphics (RADV STRIX_HALO)', totalMiB: 86016, freeMiB: 83633, isGpu: true },
    { backend: 'Vulkan1', name: 'llvmpipe (LLVM 22.1.6, 256 bits)', totalMiB: 124406, freeMiB: 80073, isGpu: false },
  ];

  /** Plant an install whose marker carries a device list, the way T2 writes it. */
  function plantInstallWithDevices(backend: string, devices: unknown) {
    const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-${backend}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
    fs.writeFileSync(path.join(dir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend, binaryRelPath: 'llama-server.exe', devices }));
  }

  it('status() answers immediately without backendOptions, then pushes them', async () => {
    // A marker that ALREADY carries devices, so T2's lazy backfill does not run
    // and emit a second 'status-changed' — this test counts the chip probe's push.
    plantInstallWithDevices('vulkan', REAL_DEVICES);
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    let pushes = 0;
    mgr.on('status-changed', () => { pushes += 1; });

    // The first answer must not block on the probe, so it cannot carry it.
    expect(mgr.status().backendOptions).toBeUndefined();

    await settled();
    expect(pushes).toBe(1);
    expect(mgr.status().backendOptions?.map((o) => o.backend)).toEqual(['rocm']);
  });

  it('a probe that THROWS still pushes, and settles on "nothing to offer"', async () => {
    // Devices already in the marker, for the same reason as above.
    plantInstallWithDevices('vulkan', REAL_DEVICES);
    const mgr = new EngineManager(home, userData, 9999, {
      probeChip: async () => { throw new Error('nvidia-smi wedged'); },
    });
    let pushes = 0;
    mgr.on('status-changed', () => { pushes += 1; });

    mgr.status();
    await settled();
    // The push fired on the failure path — this is what keeps the card from
    // hanging when a graphics driver misbehaves.
    expect(pushes).toBe(1);
    expect(mgr.status().backendOptions).toEqual([]);
  });

  // Both halves of this feature push independently: the chip probe (T3) and the
  // lazy device backfill (T2), which fills in a marker written before devices
  // were recorded. A user upgrading from an older install gets BOTH, and the
  // card must end up with the chip AND the device name. This is the case the
  // two tests above deliberately exclude so their counts stay meaningful.
  it('an older install with no device list gets both pushes, and ends up complete', async () => {
    plantInstall('vulkan'); // no `devices` key — every install made before T2
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    let pushes = 0;
    mgr.on('status-changed', () => { pushes += 1; });

    mgr.status();
    await settled();
    expect(pushes).toBeGreaterThanOrEqual(1);
    expect(mgr.status().backendOptions?.map((o) => o.backend)).toEqual(['rocm']);
  });

  it('asks the machine ONCE, however many times status() is called', async () => {
    plantInstall();
    let calls = 0;
    const mgr = new EngineManager(home, userData, 9999, {
      probeChip: async () => { calls += 1; return { vendor: null, gfxTarget: null }; },
    });
    mgr.status(); mgr.status(); mgr.status();
    await settled();
    mgr.status();
    await settled();
    expect(calls).toBe(1);
  });

  // The path every new user walks: the Local Models panel is where the Install
  // button lives, so the panel — and the first status() — happens BEFORE there
  // is any engine. An answer computed then and cached would say "Processor
  // only" forever on a machine that is using its graphics chip.
  it('the device name appears on the FIRST status after an install, not the next app run', async () => {
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    // Nothing installed yet: not known, which is NOT the same as "no GPU".
    expect(mgr.status().deviceName).toBeUndefined();
    await settled();
    expect(mgr.status().deviceName).toBeUndefined();

    plantInstallWithDevices('vulkan', REAL_DEVICES);
    expect(mgr.status().deviceName).toBe('AMD Radeon 8060S Graphics');
  });

  it('a switch to another backend shows THAT build\'s device, not the old one\'s', async () => {
    plantInstallWithDevices('vulkan', REAL_DEVICES);
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    mgr.status();          // kicks the probe
    await settled();
    expect(mgr.status().deviceName).toBe('AMD Radeon 8060S Graphics');
    // A ROCm install names its device differently, and the config now prefers it.
    plantInstallWithDevices('rocm', [{ backend: 'ROCm0', name: 'AMD Radeon Graphics (gfx1151)', totalMiB: 65536, freeMiB: 60000, isGpu: true }]);
    await updateEngineConfig(home, { backend: 'rocm' });
    const s = mgr.status();
    expect(s.backend).toBe('rocm');
    expect(s.deviceName).toBe('AMD Radeon Graphics');
    // …and the switch it is already on is no longer offered.
    expect(s.backendOptions).toEqual([]);
  });

  it('an engine that reports only a software renderer says "no GPU", not "not known"', () => {
    plantInstallWithDevices('vulkan', [REAL_DEVICES[1]]);
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    expect(mgr.status().deviceName).toBeNull();
  });

  it('a marker with no device list at all is "not known", never "no GPU"', () => {
    // Every install made before the device list existed. T2 backfills these
    // lazily; until it does, the card must not claim the processor is the answer.
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    expect(mgr.status().deviceName).toBeUndefined();
  });

  it('a corrupt marker degrades to "not known" rather than throwing', () => {
    const dir = path.join(userData, 'engine', `${ENGINE_VERSION}-vulkan`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
    fs.writeFileSync(path.join(dir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend: 'vulkan', binaryRelPath: 'llama-server.exe' }));
    const mgr = new EngineManager(home, userData, 9999, { probeChip: async () => AMD_CHIP });
    // Corrupt it AFTER the install is discovered, so we exercise the read path.
    fs.writeFileSync(path.join(dir, '.complete'), '{not json');
    expect(() => mgr.status()).not.toThrow();
    expect(mgr.status().deviceName).toBeUndefined();
  });

  it('a machine with no AMD or NVIDIA chip is offered nothing', async () => {
    plantInstall('vulkan');
    const mgr = new EngineManager(home, userData, 9999, {
      probeChip: async () => ({ vendor: 'intel' as const, gfxTarget: null }),
    });
    mgr.status();          // kicks the probe — nothing asks the machine unprompted
    await settled();
    expect(mgr.status().backendOptions).toEqual([]);
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
      // No manifest at all, so nothing knows this model's repo — and a flat set
      // with no projector beside it is text-only (T15).
      totalSizeBytes: null, repo: null, vision: 'none', visionBytes: null,
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

  it("keeps §E3's repo: null miss record — sweeping it would make the lookup repeat forever", async () => {
    // "We searched Hugging Face for this model and found nothing" is a REAL
    // record: it is what stops the search running again on every render.
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: null, quant: 'Q4_K_M', files: ['Mystery-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1, completedAt: 2,
    }));
    const rows = await manager.installedModels();
    expect(rows[0]).toMatchObject({ id: 'Mystery-Q4_K_M', status: 'complete', repo: null });
    expect(fs.existsSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.download.json'))).toBe(true);
    const kept = JSON.parse(fs.readFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.download.json'), 'utf8'));
    expect(kept.repo).toBeNull();
    expect(kept.completedAt).toBe(2);   // not re-stamped either
  });

  it('a stamped manifest with no bytes at all is a leftover, not an unfinished row', async () => {
    // The files were deleted from under a finished download: nothing to resume,
    // nothing to show, so the record goes with them.
    fs.writeFileSync(path.join(cacheDir, 'Gone-Q4_K_M.gguf.download.json'),
      doneManifest('a/b', ['Gone-Q4_K_M.gguf'], 50));
    expect(await manager.installedModels()).toEqual([]);
    expect(fs.existsSync(path.join(cacheDir, 'Gone-Q4_K_M.gguf.download.json'))).toBe(false);
  });

  // ── The three vision states (design §E2) ─────────────────────────────────
  // 'ready'     — the projector is on disk beside the weights, so the engine
  //               loads this model with --mmproj and it can look at images.
  // 'available' — the repo HAS a projector this copy does not: the download's
  //               second leg failed, or the app died between the two. Same row,
  //               same fix ("Add vision"), so the same state.
  // 'none'      — this model family has no projector at all.
  const visionFolder = (id: string, opts: { projector: boolean }) => {
    const folder = path.join(cacheDir, id);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, `${id}.gguf`), Buffer.alloc(60));
    if (opts.projector) fs.writeFileSync(path.join(folder, 'mmproj-F16.gguf'), Buffer.alloc(7));
    fs.writeFileSync(path.join(folder, `${id}.gguf.download.json`), JSON.stringify({
      v: 1, repo: 'unsloth/V-GGUF', quant: 'Q4_K_M', files: [`${id}.gguf`],
      totalSizeBytes: 60, sha256ByFile: {}, startedAt: 1, completedAt: 2,
      visionFile: { path: 'mmproj-F16.gguf', size: 900, sha256: null },
    }));
    return folder;
  };

  it("vision 'ready': the projector is on disk, and the row's size admits to it", async () => {
    visionFolder('V-Q4_K_M', { projector: true });
    const rows = await manager.installedModels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'V-Q4_K_M', status: 'complete', vision: 'ready',
      // The projector's REAL size on disk, not the manifest's remote figure.
      visionBytes: 7,
      // Weights + projector: this is what deleting the folder gives back.
      sizeBytes: 67,
      // Flipped by T15 — the row needs it to match its own download's progress.
      repo: 'unsloth/V-GGUF',
    });
  });

  it('a complete row admits to a projector still arriving, because Delete removes it too', async () => {
    // deleteModel removes the folder recursively — .partial files included — so
    // a complete row that reported published bytes only understated what the
    // confirmation was about to throw away.
    const folder = visionFolder('V-Q4_K_M', { projector: false });
    fs.writeFileSync(path.join(folder, 'mmproj-F16.gguf.partial'), Buffer.alloc(11));
    const rows = await manager.installedModels();
    expect(rows[0]).toMatchObject({ id: 'V-Q4_K_M', status: 'complete', sizeBytes: 71 });
  });

  it("vision 'available': the manifest names a projector that is not on disk", async () => {
    // Both the failed-second-leg case and the crash-recovery case (R1-11).
    visionFolder('V-Q4_K_M', { projector: false });
    const rows = await manager.installedModels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'V-Q4_K_M', status: 'complete', vision: 'available',
      // The size the row's "Add vision (0.9 GB)" label has to quote, which can
      // only come from the manifest — nothing of it is on disk.
      visionBytes: 900,
      sizeBytes: 60,
    });
  });

  it("vision 'none': a model whose repo ships no projector", async () => {
    fs.writeFileSync(path.join(cacheDir, 'Plain-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Plain-Q4_K_M.gguf.download.json'),
      manifest('a/b', ['Plain-Q4_K_M.gguf'], 50));
    const rows = await manager.installedModels();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'Plain-Q4_K_M', vision: 'none', visionBytes: null });
  });

  it('deleteModel removes the whole folder AND the model\'s own settings', async () => {
    visionFolder('V-Q4_K_M', { projector: true });
    fs.writeFileSync(path.join(cacheDir, 'V-Q4_K_M', 'mmproj-F16.gguf.partial'), Buffer.alloc(3));
    await home.mutateJson('config.json', (cur: any) => ({
      ...cur,
      engine: { ...(cur?.engine ?? {}), models: { 'V-Q4_K_M': { contextLength: 4096 }, 'Other': { keepLoaded: true } } },
    }));
    await manager.deleteModel('V-Q4_K_M');
    expect(fs.existsSync(path.join(cacheDir, 'V-Q4_K_M'))).toBe(false);
    expect(fs.readdirSync(cacheDir)).toEqual([]);
    // Pruned — a section for a model that no longer exists renders a ghost row
    // in the router's preset file, and a re-download would inherit its context.
    const cfg = home.readJson('config.json') as any;
    expect(Object.keys(cfg.engine.models)).toEqual(['Other']);
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
