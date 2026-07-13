import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanGgufCache, ggufIdFromFileName } from '../src/main/engine/cache-scan';

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
      { id: 'Qwen3-4B-Instruct-2507-UD-Q4_K_XL', sizeBytes: 16, loaded: false },
    ]);
  });

  it('collapses multi-part sets to ONE entry keyed by the first part, summing sizes', () => {
    touch('Big-Model-UD-Q4_K_XL-00001-of-00002.gguf', 10);
    touch('Big-Model-UD-Q4_K_XL-00002-of-00002.gguf', 20);
    const models = scanGgufCache(dir);
    expect(models).toEqual([
      { id: 'Big-Model-UD-Q4_K_XL-00001-of-00002', sizeBytes: 30, loaded: false },
    ]);
  });

  it('returns [] for a missing directory', () => {
    expect(scanGgufCache(path.join(dir, 'nope'))).toEqual([]);
  });

  it('ggufIdFromFileName strips the extension only (router ids are filename-based)', () => {
    expect(ggufIdFromFileName('foo-Q4_K_M.gguf')).toBe('foo-Q4_K_M');
  });
});
