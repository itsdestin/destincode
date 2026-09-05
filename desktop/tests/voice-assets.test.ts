// Voice asset acquisition (src/main/voice/voice-assets.ts).
//
// What this file is defending, in plain words:
//   1. A folder that was only half-unpacked is NEVER reported as ready.
//   2. A download whose fingerprint is wrong says exactly what it expected and
//      exactly what it got — in BOTH fingerprint shapes, because npm publishes
//      SHA-512/base64 and the model release publishes SHA-256/hex.
//   3. If an archive stops containing the file voice-pin.ts says it contains,
//      the install fails loudly instead of leaving a directory that cannot load.
//   4. The progress the card renders reaches "unpacking" BEFORE "ready".
//
// Nothing here downloads anything: fetch is stubbed with real (tiny) archives
// built on the fly. The model half really is a .tar.bz2, so the bzip2 path this
// module had to name explicitly is exercised for real, not mocked away.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';

// The fixture pins, built fresh for each test. `vi.hoisted` because the mock
// factory below is hoisted above every import, but the archives (and therefore
// their real digests) cannot exist until beforeEach has run — so the mock reads
// them through getters instead of capturing values.
const fixtures = vi.hoisted(() => ({
  runtime: null as any,
  wrappers: null as any,
  model: null as any,
  /** Flip to make pickRuntime() answer null, i.e. Windows-on-ARM. */
  unsupported: false,
}));

vi.mock('../src/main/voice/voice-pin', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/voice/voice-pin')>();
  return {
    ...actual,
    get VOICE_RUNTIMES() { return [fixtures.runtime]; },
    get VOICE_WRAPPERS() { return fixtures.wrappers; },
    get VOICE_MODEL() { return fixtures.model; },
    pickRuntime: () => (fixtures.unsupported ? null : fixtures.runtime),
    totalDownloadBytes: (r: { bytes: number }) => r.bytes + fixtures.wrappers.bytes + fixtures.model.bytes,
  };
});

import { VoiceAssets } from '../src/main/voice/voice-assets';
import type { VoiceAssetProgress, VoiceFetch } from '../src/main/voice/voice-assets';
import { MODEL_DIR_NAME, SHERPA_VERSION } from '../src/main/voice/voice-pin';

const TAR_BIN = process.platform === 'win32'
  ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe')
  : 'tar';

/** Can this machine CREATE a .tar.bz2 fixture? (Every CI runner and this dev
 *  box can; a container without bzip2 cannot, and skipping beats a red suite
 *  that says nothing about the code.) */
function canMakeBz2(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'bz2probe-'));
  try {
    fs.writeFileSync(path.join(probe, 'f.txt'), 'x');
    execFileSync(TAR_BIN, ['-cjf', path.join(probe, 'a.tar.bz2'), '-C', probe, 'f.txt']);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(probe, { recursive: true, force: true });
  }
}
const HAS_BZ2 = canMakeBz2();

let tmp: string;
let userData: string;
let served: Map<string, string>;

function digestOf(file: string, algo: 'sha256' | 'sha512', encoding: 'hex' | 'base64'): string {
  return crypto.createHash(algo).update(fs.readFileSync(file)).digest(encoding);
}

/** A real .tgz rooted at `package/`, like every npm tarball. */
function makeTgz(dir: string, name: string, files: Record<string, string>): string {
  const stage = path.join(dir, `stage-${name}`);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(stage, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(stage, rel), body);
  }
  const out = path.join(dir, `${name}.tgz`);
  execFileSync(TAR_BIN, ['-czf', out, '-C', stage, 'package']);
  return out;
}

/** A real .tar.bz2 rooted at the model's own directory name. */
function makeTarBz2(dir: string, files: Record<string, string>): string {
  const stage = path.join(dir, 'stage-model');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.join(stage, path.dirname(rel)), { recursive: true });
    fs.writeFileSync(path.join(stage, rel), body);
  }
  const out = path.join(dir, 'model.tar.bz2');
  execFileSync(TAR_BIN, ['-cjf', out, '-C', stage, MODEL_DIR_NAME]);
  return out;
}

/** fetch stub serving the fixture files by URL, honouring Range resume. */
const fetchServing: VoiceFetch = async (url, init) => {
  const file = served.get(url);
  if (!file) return new Response(null, { status: 404 });
  const buf = fs.readFileSync(file);
  const range = init?.headers?.Range;
  const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
  if (start >= buf.length) return new Response(null, { status: 416 });
  const body = buf.subarray(start);
  return new Response(new Blob([body]).stream(), {
    status: start > 0 ? 206 : 200,
    headers: { 'content-length': String(body.length) },
  });
};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-assets-'));
  userData = path.join(tmp, 'userData');
  fixtures.unsupported = false;

  const runtimeTgz = makeTgz(tmp, 'runtime', {
    'package/sherpa-onnx.node': 'not-really-an-addon',
    'package/libonnxruntime.so': 'shared-library',
    'package/package.json': '{"name":"sherpa-onnx-linux-x64"}',
  });
  const wrapperTgz = makeTgz(tmp, 'wrappers', {
    'package/sherpa-onnx.js': 'module.exports = {};',
    'package/non-streaming-asr.js': 'module.exports = {};',
    'package/addon.js': 'module.exports = require("./sherpa-onnx.node");',
    'package/package.json': '{"name":"sherpa-onnx-node","main":"sherpa-onnx.js"}',
  });
  const modelArchive = HAS_BZ2 ? makeTarBz2(tmp, {
    [`${MODEL_DIR_NAME}/encoder.int8.onnx`]: 'encoder',
    [`${MODEL_DIR_NAME}/decoder.int8.onnx`]: 'decoder',
    [`${MODEL_DIR_NAME}/joiner.int8.onnx`]: 'joiner',
    [`${MODEL_DIR_NAME}/tokens.txt`]: 'tokens',
  }) : '';

  fixtures.runtime = {
    platform: process.platform, arch: process.arch, npmPackage: 'sherpa-onnx-test',
    label: 'the speech runtime',
    url: 'https://registry.test/runtime.tgz',
    // npm's shape: SHA-512 in base64.
    digest: { algo: 'sha512', encoding: 'base64', digest: digestOf(runtimeTgz, 'sha512', 'base64') },
    bytes: fs.statSync(runtimeTgz).size,
    addonRelPath: 'package/sherpa-onnx.node',
    requiredRelPaths: ['package/sherpa-onnx.node'],
  };
  fixtures.wrappers = {
    npmPackage: 'sherpa-onnx-node',
    label: 'the speech runtime',
    url: 'https://registry.test/wrappers.tgz',
    digest: { algo: 'sha512', encoding: 'base64', digest: digestOf(wrapperTgz, 'sha512', 'base64') },
    bytes: fs.statSync(wrapperTgz).size,
    entryRelPath: 'package/sherpa-onnx.js',
    requiredRelPaths: ['package/sherpa-onnx.js', 'package/non-streaming-asr.js', 'package/addon.js'],
  };
  fixtures.model = {
    label: 'the speech model',
    url: 'https://releases.test/model.tar.bz2',
    // The model release's shape: SHA-256 in hex.
    digest: {
      algo: 'sha256', encoding: 'hex',
      digest: HAS_BZ2 ? digestOf(modelArchive, 'sha256', 'hex') : '0'.repeat(64),
    },
    bytes: HAS_BZ2 ? fs.statSync(modelArchive).size : 1,
    requiredRelPaths: [
      `${MODEL_DIR_NAME}/encoder.int8.onnx`,
      `${MODEL_DIR_NAME}/decoder.int8.onnx`,
      `${MODEL_DIR_NAME}/joiner.int8.onnx`,
      `${MODEL_DIR_NAME}/tokens.txt`,
    ],
  };

  served = new Map([
    [fixtures.runtime.url, runtimeTgz],
    [fixtures.wrappers.url, wrapperTgz],
    [fixtures.model.url, modelArchive],
  ]);
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }));

describe.skipIf(!HAS_BZ2)('VoiceAssets — installing', () => {
  it('downloads both halves, unpacks them, and reports unpacking BEFORE ready', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    const events: VoiceAssetProgress[] = [];
    const installed = await assets.install((p) => events.push(p));

    // Both halves really landed, at the paths voice-pin.ts promises.
    expect(fs.existsSync(installed.addonPath)).toBe(true);
    expect(fs.existsSync(installed.wrapperEntryPath)).toBe(true);
    expect(fs.readFileSync(path.join(installed.modelDir, 'tokens.txt'), 'utf8')).toBe('tokens');
    // The wrappers were unpacked ON TOP of the runtime, in the same folder —
    // which is what makes their relative require('./sherpa-onnx.node') resolve.
    expect(path.dirname(installed.addonPath)).toBe(path.dirname(installed.wrapperEntryPath));

    // Phase order: downloading… → unpacking → ready, never the other way round.
    const phases = events.map((e) => e.phase);
    expect(phases).toContain('downloading');
    expect(phases.indexOf('unpacking')).toBeGreaterThan(-1);
    expect(phases.indexOf('unpacking')).toBeLessThan(phases.indexOf('ready'));
    expect(phases[phases.length - 1]).toBe('ready');

    // The percentage is over BOTH halves combined and ends at 100.
    const downloads = events.filter((e): e is Extract<VoiceAssetProgress, { phase: 'downloading' }> => e.phase === 'downloading');
    const total = fixtures.runtime.bytes + fixtures.wrappers.bytes + fixtures.model.bytes;
    expect(downloads[0].totalBytes).toBe(total);
    expect(downloads[downloads.length - 1].percent).toBe(100);

    // Scratch and part-files are gone; the markers are in place.
    expect(fs.readdirSync(installed.voiceRoot).sort()).toEqual(['model', 'runtime']);
    expect(assets.installed()).not.toBeNull();
  });

  it('is idempotent — a second install returns straight away with ready', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    await assets.install(() => {});
    const events: VoiceAssetProgress[] = [];
    await assets.install((p) => events.push(p));
    expect(events).toEqual([{ phase: 'ready' }]);
  });
});

describe.skipIf(!HAS_BZ2)('VoiceAssets — a half-unpacked folder is never ready', () => {
  it('answers null while an unpack is still in its .unpacking scratch folder', () => {
    // Exactly the on-disk state a crash mid-unpack leaves: every file present,
    // but under the scratch name and with no marker. The real folder is absent.
    const scratch = path.join(userData, 'voice', 'runtime.unpacking', 'package');
    fs.mkdirSync(scratch, { recursive: true });
    fs.writeFileSync(path.join(scratch, 'sherpa-onnx.node'), 'x');
    expect(new VoiceAssets(userData, fetchServing).installed()).toBeNull();
  });

  it('answers null when the marker is there but a promised file is gone', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    const installed = await assets.install(() => {});
    expect(assets.installed()).not.toBeNull();
    fs.rmSync(path.join(installed.modelDir, 'encoder.int8.onnx'));
    expect(assets.installed()).toBeNull();
  });

  it('answers null when the marker itself is missing', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    const installed = await assets.install(() => {});
    fs.rmSync(path.join(path.dirname(path.dirname(installed.addonPath)), '.complete'));
    expect(assets.installed()).toBeNull();
  });

  it('writes the marker with the pinned version, so a pin bump reinstalls', async () => {
    const assets = new VoiceAssets(userData, fetchServing);
    await assets.install(() => {});
    const marker = JSON.parse(
      fs.readFileSync(path.join(userData, 'voice', 'model', '.complete'), 'utf8'),
    );
    expect(marker.sherpaVersion).toBe(SHERPA_VERSION);
    expect(marker.requiredRelPaths).toContain(`${MODEL_DIR_NAME}/tokens.txt`);
  });
});

describe.skipIf(!HAS_BZ2)('VoiceAssets — a bad fingerprint names both numbers', () => {
  it('reports the exact mismatch for npm\'s SHA-512/base64 shape', async () => {
    const realDigest = fixtures.runtime.digest.digest;
    const wrong = 'AAAA' + realDigest.slice(4);
    fixtures.runtime.digest = { algo: 'sha512', encoding: 'base64', digest: wrong };

    const assets = new VoiceAssets(userData, fetchServing);
    await expect(assets.install(() => {})).rejects.toThrow(/SHA-512 fingerprint \(base64\)/);
    // Both numbers, spelled out: what was expected and what actually arrived.
    await expect(assets.install(() => {})).rejects.toThrow(new RegExp(escapeRe(wrong)));
    await expect(assets.install(() => {})).rejects.toThrow(new RegExp(escapeRe(realDigest)));
    expect(assets.installed()).toBeNull();
  });

  it('reports the exact mismatch for the model\'s SHA-256/hex shape', async () => {
    const realDigest = fixtures.model.digest.digest;
    const wrong = 'dead' + realDigest.slice(4);
    fixtures.model.digest = { algo: 'sha256', encoding: 'hex', digest: wrong };

    const assets = new VoiceAssets(userData, fetchServing);
    const events: VoiceAssetProgress[] = [];
    await expect(assets.install((p) => events.push(p))).rejects.toThrow(/SHA-256 fingerprint \(hex\)/);
    const failure = events.find((e) => e.phase === 'error') as Extract<VoiceAssetProgress, { phase: 'error' }>;
    expect(failure.message).toContain(wrong);
    expect(failure.message).toContain(realDigest);
    // The CORRUPT file is discarded — otherwise a retry would "resume" it forever
    // and never recover. The two good part-files are deliberately kept, so a
    // retry does not re-download what already arrived intact.
    const parts = fs.readdirSync(path.join(userData, 'voice')).filter((f) => f.endsWith('.download'));
    expect(parts.some((f) => f.includes(MODEL_DIR_NAME))).toBe(false);
    expect(parts).toHaveLength(2);
  });
});

describe.skipIf(!HAS_BZ2)('VoiceAssets — a stale pinned layout is caught', () => {
  it('fails with the pinned path when the runtime archive lost its addon', async () => {
    fixtures.runtime.requiredRelPaths = ['package/sherpa-onnx-renamed.node'];
    const assets = new VoiceAssets(userData, fetchServing);
    await expect(assets.install(() => {})).rejects.toThrow(
      /did not contain package\/sherpa-onnx-renamed\.node — the pinned layout in voice-pin\.ts is stale/,
    );
    // And nothing half-installed survives the failure.
    expect(assets.installed()).toBeNull();
    expect(fs.existsSync(path.join(userData, 'voice', 'runtime'))).toBe(false);
    expect(fs.existsSync(path.join(userData, 'voice', 'runtime.unpacking'))).toBe(false);
  });

  it('fails with the pinned path when the model archive lost a file', async () => {
    fixtures.model.requiredRelPaths = [`${MODEL_DIR_NAME}/encoder.fp16.onnx`];
    const assets = new VoiceAssets(userData, fetchServing);
    await expect(assets.install(() => {})).rejects.toThrow(
      /did not contain .*encoder\.fp16\.onnx — the pinned layout in voice-pin\.ts is stale/,
    );
    expect(fs.existsSync(path.join(userData, 'voice', 'model'))).toBe(false);
  });
});

describe('VoiceAssets — a computer voice cannot run on', () => {
  it('says so instead of failing a download nobody could have won', async () => {
    fixtures.unsupported = true;
    const assets = new VoiceAssets(userData, fetchServing);
    const events: VoiceAssetProgress[] = [];
    await expect(assets.install((p) => events.push(p))).rejects.toThrow(/not available on this computer/);
    expect(events).toEqual([{ phase: 'error', message: expect.stringContaining('not available on this computer') }]);
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
