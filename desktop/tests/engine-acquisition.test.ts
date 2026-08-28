import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import { EngineAcquisition } from '../src/main/engine/engine-acquisition';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';
import type { EngineAsset } from '../src/main/engine/engine-pin';
import type { EngineInstallProgress } from '../src/shared/engine-types';

let tmp: string;
let engineRoot: string;
let archivePath: string;
let asset: EngineAsset;

// Same reasoning as production's systemTar(): on Windows a bare `tar` on PATH
// resolves to Git's GNU tar, which reads the colon in `C:\...` as an rsh
// host:path and can't create/read archives at Windows paths. System32 bsdtar
// (libarchive) handles them. Use it for the fixture builder too.
const TAR_BIN = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';

/** Build a real tar.gz containing build/bin/llama-server so the system-tar
 *  unpack path is exercised end to end. */
function makeFixtureArchive(dir: string): string {
  const stage = path.join(dir, 'stage');
  fs.mkdirSync(path.join(stage, 'build', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'build', 'bin', 'llama-server'), '#!/bin/sh\necho fake\n');
  const out = path.join(dir, 'fixture.tar.gz');
  execFileSync(TAR_BIN, ['-czf', out, '-C', stage, 'build']);
  return out;
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** fetch mock streaming the fixture file, honoring Range requests. */
function fetchServing(file: string): typeof fetch {
  return (async (_url: any, init?: any) => {
    const buf = fs.readFileSync(file);
    const range = init?.headers?.Range as string | undefined;
    let start = 0;
    if (range) start = Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
    if (start >= buf.length) return new Response(null, { status: 416 });
    const body = buf.subarray(start);
    return new Response(new Blob([body]).stream(), {
      status: start > 0 ? 206 : 200,
      headers: { 'content-length': String(body.length) },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-acq-'));
  engineRoot = path.join(tmp, 'engine');
  archivePath = makeFixtureArchive(tmp);
  asset = {
    platform: 'linux', arch: 'x64', backend: 'cpu',
    assetName: `llama-${ENGINE_VERSION}-bin-test-x64.tar.gz`,
    sha256: sha256(archivePath),
    binaryRelPath: path.join('build', 'bin', 'llama-server'),
  };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

describe('EngineAcquisition', () => {
  it('installs: downloads, verifies, unpacks, writes .complete LAST, reports progress', async () => {
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    const events: EngineInstallProgress[] = [];
    const installed = await acq.install(asset, (p) => events.push(p));

    expect(fs.existsSync(installed.binaryPath)).toBe(true);
    expect(installed.version).toBe(ENGINE_VERSION);
    expect(installed.backend).toBe('cpu');
    const marker = JSON.parse(fs.readFileSync(path.join(installed.dir, '.complete'), 'utf8'));
    expect(marker.binaryRelPath).toBe(asset.binaryRelPath);
    expect(events.some((e) => e.kind === 'download')).toBe(true);
    expect(events.map((e) => e.kind)).toContain('verify');
    expect(events[events.length - 1]).toEqual({ kind: 'done', version: ENGINE_VERSION, backend: 'cpu' });
    expect(fs.readdirSync(engineRoot).filter((f) => f.endsWith('.download'))).toEqual([]);
  });

  it('installed() finds the usable install and returns null when the binary vanished', async () => {
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    const installed = await acq.install(asset, () => {});
    expect(acq.installed()?.dir).toBe(installed.dir);
    fs.rmSync(installed.binaryPath);
    expect(acq.installed()).toBeNull();
  });

  it('installed(preferBackend) prefers the matching backend when two builds of the same version coexist', async () => {
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    // Install the cpu build the normal way.
    await acq.install(asset, () => {});
    // Plant a SECOND usable install of the same version, backend 'vulkan',
    // by hand (simulating a fallback that left both dirs behind).
    const vulkanDir = acq.installDir(ENGINE_VERSION, 'vulkan');
    const vbin = path.join(vulkanDir, 'build', 'bin', 'llama-server');
    fs.mkdirSync(path.dirname(vbin), { recursive: true });
    fs.writeFileSync(vbin, 'fake');
    fs.writeFileSync(path.join(vulkanDir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend: 'vulkan', binaryRelPath: path.join('build', 'bin', 'llama-server') }));
    expect(acq.installed('cpu')?.backend).toBe('cpu');
    expect(acq.installed('vulkan')?.backend).toBe('vulkan');
    // No preference → still returns a usable pinned-version install (either backend).
    expect(acq.installed()).not.toBeNull();
  });

  it('REFUSES a checksum mismatch and deletes the bad download', async () => {
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    const bad = { ...asset, sha256: '0'.repeat(64) };
    await expect(acq.install(bad, () => {})).rejects.toThrow(/integrity check/);
    expect(acq.installed()).toBeNull();
    expect(fs.existsSync(path.join(engineRoot, `${asset.assetName}.download`))).toBe(false);
  });

  it('resumes a partial download via a Range request', async () => {
    fs.mkdirSync(engineRoot, { recursive: true });
    const full = fs.readFileSync(archivePath);
    fs.writeFileSync(path.join(engineRoot, `${asset.assetName}.download`), full.subarray(0, 10));
    const fetchImpl = fetchServing(archivePath);
    const acq = new EngineAcquisition(engineRoot, fetchImpl);
    const installed = await acq.install(asset, () => {});
    expect(fs.existsSync(installed.binaryPath)).toBe(true);
  });

  it('never leaves a half-unpacked dir marked usable when the archive lacks the binary', async () => {
    const stage = path.join(tmp, 'empty-stage'); fs.mkdirSync(path.join(stage, 'build'), { recursive: true });
    fs.writeFileSync(path.join(stage, 'build', 'README'), 'nope');
    const emptyArchive = path.join(tmp, 'empty.tar.gz');
    execFileSync(TAR_BIN, ['-czf', emptyArchive, '-C', stage, 'build']);
    const badAsset = { ...asset, sha256: sha256(emptyArchive) };
    const acq = new EngineAcquisition(engineRoot, fetchServing(emptyArchive));
    await expect(acq.install(badAsset, () => {})).rejects.toThrow(/did not contain/);
    expect(acq.installed()).toBeNull();
  });

  it('a write-stream failure rejects the install cleanly (never an unhandled crash)', async () => {
    fs.mkdirSync(engineRoot, { recursive: true });
    // Plant a DIRECTORY where the .download file must be written → the write
    // stream errors (EISDIR/EPERM). The install must reject, not throw an
    // unhandled stream 'error' that would crash the main process.
    fs.mkdirSync(path.join(engineRoot, `${asset.assetName}.download`), { recursive: true });
    const acq = new EngineAcquisition(engineRoot, fetchServing(archivePath));
    await expect(acq.install(asset, () => {})).rejects.toThrow();
    expect(acq.installed()).toBeNull();
  });
});
