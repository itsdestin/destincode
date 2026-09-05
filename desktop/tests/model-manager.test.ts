import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { updateEngineConfig } from '../src/main/engine/engine-config';
import { ENGINE_VERSION } from '../src/main/engine/engine-pin';
import { ModelManager } from '../src/main/models/model-manager';
import type { DownloadProgress } from '../src/shared/model-manager-types';

let root: string;
let home: NativeHome;
let cacheDir: string;
let urls: string[];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-mgr-'));
  home = new NativeHome(root);
  cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });
  // Point the manager at the tmp cache — never at ~/.cache/llama.cpp.
  await updateEngineConfig(home, { cacheDir });
  urls = [];
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// Records every URL the downloader asks for, then fails — the test only needs
// to see WHERE resume went, not to move bytes.
const recordingFetch = (async (url: any) => {
  urls.push(String(url));
  return new Response(null, { status: 500 });
}) as typeof fetch;

function manager(opts: { freeDiskBytes?: number } = {}): ModelManager {
  const userData = path.join(root, 'userData');
  const engine = new EngineManager(home, userData, 9999);
  return new ModelManager(home, engine, userData, {
    fetchImpl: recordingFetch, totalVramBytes: null, ...opts,
  });
}

describe('ModelManager.resume', () => {
  it("starts a download of the manifest's repo and file set — with NO Hugging Face listing call", async () => {
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00002.gguf'), Buffer.alloc(10));
    fs.writeFileSync(path.join(cacheDir, 'Half-UD-Q4_K_XL-00001-of-00002.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/Half-GGUF', quant: 'UD-Q4_K_XL',
      files: ['a/Half-UD-Q4_K_XL-00001-of-00002.gguf', 'a/Half-UD-Q4_K_XL-00002-of-00002.gguf'],
      totalSizeBytes: 100, sha256ByFile: {}, startedAt: 1,
    }));
    const mm = manager();
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
    });
    const { downloadId } = await mm.resume('Half-UD-Q4_K_XL-00001-of-00002');
    expect(downloadId).toBeTruthy();
    await settled;
    // Part 1 is already published, so the ONLY request is part 2's resolve URL.
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain('unsloth/Half-GGUF');
    expect(urls[0]).toContain('Half-UD-Q4_K_XL-00002-of-00002.gguf');
  });

  it('names the real problem when there is no manifest', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Old-Q4_K_M.gguf.partial'), Buffer.alloc(10));
    await expect(manager().resume('Old-Q4_K_M')).rejects.toThrow(/where it came from/i);
    expect(urls).toEqual([]);
  });

  it('refuses a manifest whose repo was never found — repo: null is untraceable', async () => {
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.partial'), Buffer.alloc(10));
    fs.writeFileSync(path.join(cacheDir, 'Mystery-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: null, quant: 'Q4_K_M', files: ['Mystery-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1,
    }));
    await expect(manager().resume('Mystery-Q4_K_M')).rejects.toThrow(/where it came from/i);
    expect(urls).toEqual([]);
  });

  it('refuses a FINISHED download — a surviving manifest is not something to resume', async () => {
    // The manifest outlives the download now, so its presence alone must not be
    // read as "there is more to fetch". completedAt is the test.
    fs.writeFileSync(path.join(cacheDir, 'Done-Q4_K_M.gguf'), Buffer.alloc(50));
    fs.writeFileSync(path.join(cacheDir, 'Done-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/Done-GGUF', quant: 'Q4_K_M', files: ['a/Done-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1, completedAt: 2,
    }));
    await expect(manager().resume('Done-Q4_K_M')).rejects.toThrow(/already finished/i);
    expect(urls).toEqual([]);   // no bytes asked for, no Hugging Face call
  });
});

// ── The vision folder reaches ModelManager too (design §E2) ─────────────────

const GB = 1024 ** 3;
/** A vision quant whose weights and projector are deliberately different
 *  sizes, so a guard that counts only one of them cannot accidentally pass. */
const visionQuant = {
  quant: 'Q4_K_M', description: '',
  files: ['V-Q4_K_M.gguf'],
  totalSizeBytes: 3 * GB,
  sha256ByFile: { 'V-Q4_K_M.gguf': null },
  visionBytes: GB,
  visionFile: { path: 'mmproj-F16.gguf', size: GB, sha256: null },
};

describe('ModelManager.download — the disk guard reserves the projector', () => {
  it('refuses when weights + projector do not fit, though the weights alone would', async () => {
    // 3.5 GB free against a 3 GB model: the old guard, which reserved
    // `totalSizeBytes` alone, let this through and the download then ran the
    // disk out partway through the projector (T15 handoff 2). The refusal has
    // to quote 4.0 GB — the whole job — not 3.0.
    await expect(manager({ freeDiskBytes: 3.5 * GB }).download('unsloth/V-GGUF', visionQuant as any)).rejects.toThrow(
      'Not enough free space: this download needs about 4.0 GB but only 3.5 GB is free.');
    expect(urls).toEqual([]);          // nothing was fetched
    expect(fs.existsSync(path.join(cacheDir, 'V-Q4_K_M'))).toBe(false);
  });

  it('allows it when both really do fit', async () => {
    const mm = manager({ freeDiskBytes: 9 * GB });
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
    });
    const { downloadId } = await mm.download('unsloth/V-GGUF', visionQuant as any);
    expect(downloadId).toBeTruthy();
    await settled;                     // the fake fetch 500s; the guard is what was tested
  });

  it('credits a half-fetched projector in the folder, so a resume is judged on what is LEFT', async () => {
    // The 2026-08-26 trap: charging a resume the full size tells the user to
    // delete the very .partial that made it fit.
    fs.mkdirSync(path.join(cacheDir, 'V-Q4_K_M'), { recursive: true });
    // Sparse — statSync reports 3 GB, the disk holds nothing.
    fs.writeFileSync(path.join(cacheDir, 'V-Q4_K_M', 'V-Q4_K_M.gguf'), '');
    fs.truncateSync(path.join(cacheDir, 'V-Q4_K_M', 'V-Q4_K_M.gguf'), 3 * GB);
    const mm = manager({ freeDiskBytes: 1.2 * GB });
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
    });
    // 4 GB job, 3 GB of it already on disk in the FOLDER: 1 GB left, 1.2 free.
    await expect(mm.download('unsloth/V-GGUF', visionQuant as any)).resolves.toBeTruthy();
    await settled;
  });
});

describe('ModelManager.resume — a vision download resumes into its folder', () => {
  it('reads the manifest INSIDE the folder and keeps the projector on the job', async () => {
    const folder = path.join(cacheDir, 'V-Q4_K_M');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'V-Q4_K_M.gguf.partial'), Buffer.alloc(10));
    fs.writeFileSync(path.join(folder, 'V-Q4_K_M.gguf.download.json'), JSON.stringify({
      v: 1, repo: 'unsloth/V-GGUF', quant: 'Q4_K_M', files: ['V-Q4_K_M.gguf'],
      totalSizeBytes: 50, sha256ByFile: {}, startedAt: 1,
      visionFile: { path: 'mmproj-F16.gguf', size: 900, sha256: null },
    }));
    const mm = manager();
    const settled = new Promise<DownloadProgress>((resolve) => {
      mm.on('download-progress', (p: DownloadProgress) => { if (p.state === 'error') resolve(p); });
    });
    await mm.resume('V-Q4_K_M');
    const err = await settled;
    // Dropping visionFile here would send the remaining bytes FLAT, beside the
    // folder that holds the rest of them — where the engine serves neither.
    expect(err.totalBytes).toBe(950);
    expect(err.parts).toBe(2);
    expect(fs.existsSync(path.join(cacheDir, 'V-Q4_K_M.gguf.partial'))).toBe(false);
    expect(fs.existsSync(path.join(folder, 'V-Q4_K_M.gguf.partial'))).toBe(true);
  });
});

describe('ModelManager.memoryCheck — the projector is memory too', () => {
  it("counts an installed model's projector, and names it in the numbers line", async () => {
    // A projector is loaded WITH its model (--mmproj) and reaches 2.6 GB on
    // Qwen2.5-Omni — five times the working-memory cushion — so leaving it out
    // could tell a user a model fits when it does not.
    const folder = path.join(cacheDir, 'V-Q4_K_M');
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'V-Q4_K_M.gguf'), '');
    fs.truncateSync(path.join(folder, 'V-Q4_K_M.gguf'), 4 * GB);
    fs.writeFileSync(path.join(folder, 'mmproj-F16.gguf'), '');
    fs.truncateSync(path.join(folder, 'mmproj-F16.gguf'), 2 * GB);

    const userData = path.join(root, 'userData');
    // memoryCheck reads the model list, which is empty until an engine is
    // installed — plant a fake one so the ENGINE-OFF cache scan is used.
    const engineDir = path.join(userData, 'engine', `${ENGINE_VERSION}-cpu`);
    fs.mkdirSync(engineDir, { recursive: true });
    fs.writeFileSync(path.join(engineDir, 'llama-server'), 'fake');
    fs.writeFileSync(path.join(engineDir, '.complete'),
      JSON.stringify({ version: ENGINE_VERSION, backend: 'cpu', binaryRelPath: 'llama-server' }));
    const engine = new EngineManager(home, userData, 9999);
    const mm = new ModelManager(home, engine, userData, {
      fetchImpl: recordingFetch, totalVramBytes: null,
      totalMemBytes: 16 * GB, availableMemBytes: 5 * GB,
    });
    const verdict = await mm.memoryCheck('V-Q4_K_M');
    // Exact string: the headline is the ONLY thing the warning row draws, and a
    // substring match on "vision" would stay green if the size were wrong.
    expect(verdict.headline).toContain('4.0 GB model + 2.0 GB vision file');
  });
});
