// Launch auto-update of the local engine, and the two disk operations that make
// it safe to run unattended.
//
// The hazard being guarded: EngineAcquisition.install() marks a directory
// complete and renames it into place BEFORE anything runs the binary, and
// installed() prefers the pinned version over every other. So an engine that
// downloads and unpacks cleanly but will not START on this machine shadows a
// working older install. Pressing Install and reading the error was survivable;
// doing it silently at every launch is not.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { EngineAcquisition } from '../src/main/engine/engine-acquisition';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';

let root: string;
let userData: string;
let engineRoot: string;
let home: NativeHome;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-auto-'));
  userData = path.join(root, 'userData');
  engineRoot = path.join(userData, 'engine');
  home = new NativeHome(root);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Plant a usable install of an arbitrary version — the point of these tests is
 *  the version MISMATCH, so the version has to be a parameter. */
function plant(version: string, backend = 'cpu'): string {
  const dir = path.join(engineRoot, `${version}-${backend}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'llama-server.exe'), 'fake');
  fs.writeFileSync(path.join(dir, '.complete'),
    JSON.stringify({ version, backend, binaryRelPath: 'llama-server.exe' }));
  return dir;
}

const OLD = 'b0001'; // any version that is not the pin

describe('EngineManager.autoUpdateOnLaunch', () => {
  it('updates when the installed engine is older than the pin', async () => {
    plant(OLD);
    const mgr = new EngineManager(home, userData, 9999);
    const install = vi.spyOn(mgr, 'install').mockResolvedValue(undefined);
    await mgr.autoUpdateOnLaunch();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('does NOT first-install when no engine is present — that stays the user\'s call', async () => {
    const mgr = new EngineManager(home, userData, 9999);
    const install = vi.spyOn(mgr, 'install').mockResolvedValue(undefined);
    await mgr.autoUpdateOnLaunch();
    expect(install).not.toHaveBeenCalled();
  });

  it('does nothing when the installed engine already matches the pin', async () => {
    plant(ENGINE_VERSION);
    const mgr = new EngineManager(home, userData, 9999);
    const install = vi.spyOn(mgr, 'install').mockResolvedValue(undefined);
    await mgr.autoUpdateOnLaunch();
    expect(install).not.toHaveBeenCalled();
  });

  it('skips while the engine is running — swapping the binary would unload a resident model', async () => {
    plant(OLD);
    const mgr = new EngineManager(home, userData, 9999);
    // Stand in for a supervisor that already booted (a session restored fast
    // enough can start one before this runs). Next launch picks the update up.
    (mgr as unknown as { supervisor: { status: () => string } }).supervisor = { status: () => 'running' };
    const install = vi.spyOn(mgr, 'install').mockResolvedValue(undefined);
    await mgr.autoUpdateOnLaunch();
    expect(install).not.toHaveBeenCalled();
  });

  it('leaves the engine STOPPED afterwards — nobody asked for a process at startup', async () => {
    plant(OLD);
    const mgr = new EngineManager(home, userData, 9999);
    const stop = vi.fn(async () => {});
    // install() leaves the engine running by design; the auto path must undo that.
    vi.spyOn(mgr, 'install').mockImplementation(async () => {
      (mgr as unknown as { supervisor: unknown }).supervisor = { status: () => 'running', stop };
    });
    await mgr.autoUpdateOnLaunch();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('never throws, and leaves the working engine in place, when the update fails', async () => {
    const oldDir = plant(OLD);
    const mgr = new EngineManager(home, userData, 9999);
    vi.spyOn(mgr, 'install').mockRejectedValue(new Error('offline'));
    await expect(mgr.autoUpdateOnLaunch()).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(oldDir, '.complete'))).toBe(true);
    expect(mgr.status().installedVersion).toBe(OLD);
  });
});

describe('EngineManager.install — what may be discarded', () => {
  it('keeps a pre-existing install of the pinned version when a re-install fails to boot', async () => {
    // acquisition.install() is idempotent, so pressing Install on the engine you
    // are already running still reaches verifyBoot. A transient failure there must
    // not delete a build that has been working.
    // Plant every backend install() might reach on any platform, so acquisition
    // .install() short-circuits on its idempotent path and nothing is downloaded.
    const dir = plant(ENGINE_VERSION, 'cpu');
    plant(ENGINE_VERSION, 'vulkan');
    plant(ENGINE_VERSION, 'metal');
    const mgr = new EngineManager(home, userData, 9999);
    // Every backend attempt fails to boot; install() then rejects.
    vi.spyOn(mgr as unknown as { verifyBoot: () => Promise<void> }, 'verifyBoot')
      .mockRejectedValue(new Error('port busy'));
    await expect(mgr.install()).rejects.toThrow();
    expect(fs.existsSync(path.join(dir, '.complete'))).toBe(true);
    expect(mgr.status().installedVersion).toBe(ENGINE_VERSION);
  });
});

describe('EngineAcquisition.discard', () => {
  it('removes an install so installed() falls back to the older working one', () => {
    plant(OLD);
    const newDir = plant(ENGINE_VERSION);
    const acq = new EngineAcquisition(engineRoot);
    // Pinned wins while it is on disk — that is exactly the shadowing hazard.
    expect(acq.installed()?.version).toBe(ENGINE_VERSION);
    expect(acq.discard({ version: ENGINE_VERSION, backend: 'cpu', binaryPath: '', dir: newDir })).toBe(true);
    expect(acq.installed()?.version).toBe(OLD);
  });
});

describe('EngineAcquisition.pruneOthers', () => {
  it('removes other installs but never touches non-install siblings', () => {
    const oldDir = plant(OLD);
    const keepDir = plant(ENGINE_VERSION);
    // install() manages these itself — pruning must not race it.
    const archive = path.join(engineRoot, 'llama-x.tar.gz.download');
    fs.writeFileSync(archive, 'partial');
    const scratch = path.join(engineRoot, `${ENGINE_VERSION}-vulkan.unpacking`);
    fs.mkdirSync(scratch, { recursive: true });

    new EngineAcquisition(engineRoot)
      .pruneOthers({ version: ENGINE_VERSION, backend: 'cpu', binaryPath: '', dir: keepDir });

    expect(fs.existsSync(oldDir)).toBe(false);
    expect(fs.existsSync(keepDir)).toBe(true);
    expect(fs.existsSync(archive)).toBe(true);
    expect(fs.existsSync(scratch)).toBe(true);
  });
});
