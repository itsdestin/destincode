import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanGgufCache, scanLocalDownloads, isComplete, ggufIdFromFileName } from '../src/main/engine/cache-scan';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-cache-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function touch(name: string, bytes = 8) {
  fs.writeFileSync(path.join(dir, name), Buffer.alloc(bytes));
}

describe('scanGgufCache', () => {
  it('lists .gguf files with ids derived from filenames', () => {
    touch('Qwen3-4B-Instruct-2507-UD-Q4_K_XL.gguf', 16);
    touch('notes.txt');
    const models = scanGgufCache(dir);
    expect(models).toEqual([
      { id: 'Qwen3-4B-Instruct-2507-UD-Q4_K_XL', sizeBytes: 16, loaded: false, state: 'unloaded' },
    ]);
  });

  it('collapses multi-part sets to ONE entry keyed by the first part, summing sizes', () => {
    touch('Big-Model-UD-Q4_K_XL-00001-of-00002.gguf', 10);
    touch('Big-Model-UD-Q4_K_XL-00002-of-00002.gguf', 20);
    const models = scanGgufCache(dir);
    expect(models).toEqual([
      { id: 'Big-Model-UD-Q4_K_XL-00001-of-00002', sizeBytes: 30, loaded: false, state: 'unloaded' },
    ]);
  });

  it('returns [] for a missing directory', () => {
    expect(scanGgufCache(path.join(dir, 'nope'))).toEqual([]);
  });

  it('ggufIdFromFileName strips the extension only (router ids are filename-based)', () => {
    expect(ggufIdFromFileName('foo-Q4_K_M.gguf')).toBe('foo-Q4_K_M');
  });
});

// Unfinished-download surfacing (2026-08-27): a .partial left by a previous app
// run is invisible to scanGgufCache AND to the in-memory downloader — this scan
// is the UI's only way to find it, and it is the SAME scan scanGgufCache filters,
// so the two lists can never disagree (models:installed).

describe('scanLocalDownloads', () => {
  it('counts a complete split set as complete', () => {
    touch('Big-UD-Q4_K_XL-00001-of-00002.gguf', 10);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf', 20);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'Big-UD-Q4_K_XL-00001-of-00002',
      firstFileName: 'Big-UD-Q4_K_XL-00001-of-00002.gguf',
      partsDeclared: 2, partsPresent: 2, bytesPublished: 30, bytesPartial: 0,
      hasPartial: false, hasManifest: false,
    });
    expect(isComplete(d)).toBe(true);
  });

  it('a split set missing parts is NOT complete, and reports partial bytes separately', () => {
    // Destin's 2026-08-26 case in miniature: parts 1-2 published, part 3 half-written.
    touch('Big-UD-Q4_K_XL-00001-of-00004.gguf', 10);
    touch('Big-UD-Q4_K_XL-00002-of-00004.gguf', 20);
    touch('Big-UD-Q4_K_XL-00003-of-00004.gguf.partial', 5);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'Big-UD-Q4_K_XL-00001-of-00004',
      partsDeclared: 4, partsPresent: 2, bytesPublished: 30, bytesPartial: 5, hasPartial: true,
    });
    expect(isComplete(d)).toBe(false);
  });

  it('reports a download with ONLY a .partial and no published file', () => {
    touch('Solo-Q4_K_M.gguf.partial', 7);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'Solo-Q4_K_M', firstFileName: 'Solo-Q4_K_M.gguf',
      partsDeclared: 1, partsPresent: 0, bytesPublished: 0, bytesPartial: 7, hasPartial: true,
    });
    expect(isComplete(d)).toBe(false);
  });

  it('a manifest ALONE is a download — one that stopped before its first byte', () => {
    // The manifest is written before any fetch (model-downloader.ts start()).
    // Without this row a download that failed on its first request would be
    // invisible, unresumable, and its manifest would never be cleaned up.
    touch('New-UD-Q4_K_XL-00001-of-00003.gguf.download.json', 100);
    const [d] = scanLocalDownloads(dir);
    expect(d).toMatchObject({
      modelId: 'New-UD-Q4_K_XL-00001-of-00003', firstFileName: 'New-UD-Q4_K_XL-00001-of-00003.gguf',
      partsDeclared: 3, partsPresent: 0, bytesPublished: 0, bytesPartial: 0,
      hasPartial: false, hasManifest: true,
    });
    expect(isComplete(d)).toBe(false);
  });

  it('a manifest beside its published parts is the SAME download, not a second one', () => {
    touch('M-Q4_K_M.gguf', 5);
    touch('M-Q4_K_M.gguf.download.json', 100);
    touch('notes.txt', 100);
    const downloads = scanLocalDownloads(dir);
    expect(downloads).toHaveLength(1);
    expect(downloads[0]).toMatchObject({ bytesPublished: 5, hasManifest: true });
  });

  it('a complete set with a stray .partial is still complete', () => {
    // Publication is an atomic rename, so this should not happen — but if it
    // does, a stray file must not demote a working model (spec §3.2).
    touch('Big-UD-Q4_K_XL-00001-of-00002.gguf', 10);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf', 20);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf.partial', 3);
    const [d] = scanLocalDownloads(dir);
    expect(isComplete(d)).toBe(true);
    expect(d.bytesPublished).toBe(30);
  });

  it('returns [] for a missing directory', () => {
    expect(scanLocalDownloads(path.join(dir, 'nope'))).toEqual([]);
  });
});

describe('scanGgufCache is scanLocalDownloads filtered to complete sets', () => {
  it('omits an incomplete split model entirely — the picker must never offer it', () => {
    touch('Whole-Q4_K_M.gguf', 5);
    touch('Half-UD-Q4_K_XL-00001-of-00004.gguf', 10);
    touch('Half-UD-Q4_K_XL-00003-of-00004.gguf.partial', 5);
    touch('New-Q4_K_M.gguf.download.json', 50);
    expect(scanGgufCache(dir).map((m) => m.id)).toEqual(['Whole-Q4_K_M']);
  });

  it('a complete set reports published bytes only', () => {
    touch('Big-UD-Q4_K_XL-00001-of-00002.gguf', 10);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf', 20);
    touch('Big-UD-Q4_K_XL-00002-of-00002.gguf.partial', 3);
    expect(scanGgufCache(dir)).toEqual([
      { id: 'Big-UD-Q4_K_XL-00001-of-00002', sizeBytes: 30, loaded: false, state: 'unloaded' },
    ]);
  });
});
