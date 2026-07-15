import { describe, it, expect, vi } from 'vitest';
import { HfClient, hfResolveUrl } from '../src/main/models/hf-client';

describe('HfClient', () => {
  it('search: builds the gguf-filtered query and defensively parses hits', async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ([
        { id: 'unsloth/Qwen3-14B-GGUF', downloads: 5000, likes: 100 },
        { downloads: 1 },                 // no id → skipped
        { id: 42 },                       // non-string id → skipped
      ]),
    })) as any;
    const hf = new HfClient(fetchMock);
    const hits = await hf.search('qwen3');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://huggingface.co/api/models?search=qwen3&filter=gguf&sort=downloads&limit=30'
    );
    expect(hits).toEqual([{ repo: 'unsloth/Qwen3-14B-GGUF', downloads: 5000, likes: 100 }]);
  });

  it('quantOptions: recursive tree → grouped quant options with lfs sha256', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ([
        { type: 'file', path: 'M-Q4_K_M.gguf', size: 100, lfs: { oid: 'a'.repeat(64), size: 100 } },
        { type: 'file', path: 'sub/M-UD-Q4_K_XL-00001-of-00002.gguf', size: 50, lfs: { oid: 'b'.repeat(64) } },
        { type: 'file', path: 'sub/M-UD-Q4_K_XL-00002-of-00002.gguf', size: 40 }, // no lfs → sha null
        { type: 'directory', path: 'sub' },
        { type: 'file', path: 'README.md', size: 5 },
      ]),
    })) as any;
    const hf = new HfClient(fetchMock);
    const opts = await hf.quantOptions('unsloth/M-GGUF');
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://huggingface.co/api/models/unsloth/M-GGUF/tree/main?recursive=true'
    );
    expect(opts.map((o) => o.quant).sort()).toEqual(['Q4_K_M', 'UD-Q4_K_XL']);
    const ud = opts.find((o) => o.quant === 'UD-Q4_K_XL')!;
    expect(ud.totalSizeBytes).toBe(90);
    expect(ud.sha256ByFile['sub/M-UD-Q4_K_XL-00001-of-00002.gguf']).toBe('b'.repeat(64));
    expect(ud.sha256ByFile['sub/M-UD-Q4_K_XL-00002-of-00002.gguf']).toBeNull();
  });

  it('search/quantOptions surface plain-language errors on HTTP failure', async () => {
    // 503 is retryable, so it retries maxAttempts times before surfacing the
    // error. retryDelayMs: 0 keeps the test instant.
    const fetchMock = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })) as any;
    const hf = new HfClient(fetchMock, { retryDelayMs: 0 });
    await expect(hf.search('x')).rejects.toThrow(/Hugging Face/);
    expect(fetchMock).toHaveBeenCalledTimes(3); // retried before giving up
  });

  it('retries a transient network flake (ECONNRESET) then succeeds', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
      return { ok: true, json: async () => ([{ id: 'unsloth/M-GGUF', downloads: 3, likes: 0 }]) };
    }) as any;
    const hf = new HfClient(fetchMock, { retryDelayMs: 0 });
    const hits = await hf.search('m');
    expect(calls).toBe(2); // first attempt threw, second succeeded
    expect(hits).toEqual([{ repo: 'unsloth/M-GGUF', downloads: 3, likes: 0 }]);
  });

  it('does NOT retry a permanent 404', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) })) as any;
    const hf = new HfClient(fetchMock, { retryDelayMs: 0 });
    await expect(hf.quantOptions('missing/repo')).rejects.toThrow(/Hugging Face/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 404 is permanent — no retries
  });
});

describe('hfResolveUrl', () => {
  it('builds resolve URLs with encoded path segments', () => {
    expect(hfResolveUrl('unsloth/M-GGUF', 'sub dir/M-Q4_K_M.gguf')).toBe(
      'https://huggingface.co/unsloth/M-GGUF/resolve/main/sub%20dir/M-Q4_K_M.gguf'
    );
  });
});
