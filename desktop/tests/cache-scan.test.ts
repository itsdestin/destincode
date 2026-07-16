import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanGgufCache, scanPartialFiles, ggufIdFromFileName } from '../src/main/engine/cache-scan';

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

// Orphaned-.partial surfacing (2026-07-15): a .partial left by a previous app
// run is invisible to scanGgufCache AND to the in-memory downloader — this scan
// is the UI's only way to find it (models:orphaned-partials).
describe('scanPartialFiles', () => {
  it('lists .gguf.partial files with size + mtime; ignores whole .gguf files and unrelated files', () => {
    touch('M-Q4_K_M.gguf.partial', 12);
    touch('Finished-Q4_K_M.gguf', 99);   // published model — not a partial
    touch('notes.txt.partial');          // not a GGUF download — ignored
    const partials = scanPartialFiles(dir);
    expect(partials).toHaveLength(1);
    expect(partials[0]).toMatchObject({
      fileName: 'M-Q4_K_M.gguf.partial',
      modelId: 'M-Q4_K_M',
      sizeBytes: 12,
    });
    // mtime comes from a real stat — just assert it's a plausible timestamp.
    expect(partials[0].mtimeMs).toBeGreaterThan(0);
  });

  it('maps a multi-part .partial to the FIRST-part id (what models:delete expects)', () => {
    touch('Big-UD-Q4_K_XL-00003-of-00005.gguf.partial', 7);
    const partials = scanPartialFiles(dir);
    expect(partials).toEqual([expect.objectContaining({
      fileName: 'Big-UD-Q4_K_XL-00003-of-00005.gguf.partial',
      // deleteModel('…-00001-of-00005') removes every sibling part + .partial,
      // so this id makes the orphan row directly cleanable.
      modelId: 'Big-UD-Q4_K_XL-00001-of-00005',
      sizeBytes: 7,
    })]);
  });

  it('returns [] for a missing directory', () => {
    expect(scanPartialFiles(path.join(dir, 'nope'))).toEqual([]);
  });
});
