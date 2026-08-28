import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NativeHome } from '../src/main/native-home';
import { EngineManager } from '../src/main/engine/engine-manager';
import { updateEngineConfig } from '../src/main/engine/engine-config';
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

function manager(): ModelManager {
  const userData = path.join(root, 'userData');
  const engine = new EngineManager(home, userData, 9999);
  return new ModelManager(home, engine, userData, { fetchImpl: recordingFetch, totalVramBytes: null });
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
});
