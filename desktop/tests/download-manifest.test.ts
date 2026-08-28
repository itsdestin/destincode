import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MANIFEST_SUFFIX, manifestPathFor, writeManifest, readManifest, removeManifest,
} from '../src/main/models/download-manifest';
import type { QuantOption } from '../src/shared/model-manager-types';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-')); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const quant: QuantOption = {
  quant: 'UD-Q4_K_XL',
  description: 'x',
  files: ['UD-Q4_K_XL/M-UD-Q4_K_XL-00001-of-00002.gguf', 'UD-Q4_K_XL/M-UD-Q4_K_XL-00002-of-00002.gguf'],
  totalSizeBytes: 1234,
  sha256ByFile: {
    'UD-Q4_K_XL/M-UD-Q4_K_XL-00001-of-00002.gguf': 'a'.repeat(64),
    'UD-Q4_K_XL/M-UD-Q4_K_XL-00002-of-00002.gguf': null,
  },
};

describe('download manifest', () => {
  it('is named for the FIRST file basename, beside the download', () => {
    expect(MANIFEST_SUFFIX).toBe('.download.json');
    expect(manifestPathFor(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf'))
      .toBe(path.join(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf.download.json'));
  });

  it('round-trips the whole quant option plus the repo', () => {
    writeManifest(dir, 'unsloth/M-GGUF', quant, 1700000000000);
    const got = readManifest(dir, 'M-UD-Q4_K_XL-00001-of-00002.gguf');
    expect(got).toEqual({
      v: 1,
      repo: 'unsloth/M-GGUF',
      quant: 'UD-Q4_K_XL',
      files: quant.files,
      totalSizeBytes: 1234,
      sha256ByFile: quant.sha256ByFile,
      startedAt: 1700000000000,
    });
  });

  it('returns null for an absent manifest', () => {
    expect(readManifest(dir, 'nope.gguf')).toBeNull();
  });

  it('returns null for malformed JSON rather than throwing', () => {
    fs.writeFileSync(path.join(dir, 'M-Q4_K_M.gguf.download.json'), '{not json');
    expect(readManifest(dir, 'M-Q4_K_M.gguf')).toBeNull();
  });

  it('returns null for a manifest from a future version', () => {
    fs.writeFileSync(path.join(dir, 'M-Q4_K_M.gguf.download.json'), JSON.stringify({ v: 2, repo: 'a/b' }));
    expect(readManifest(dir, 'M-Q4_K_M.gguf')).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    fs.writeFileSync(path.join(dir, 'M-Q4_K_M.gguf.download.json'), JSON.stringify({ v: 1, repo: 'a/b' }));
    expect(readManifest(dir, 'M-Q4_K_M.gguf')).toBeNull();
  });

  it('leaves no .tmp behind after a write', () => {
    writeManifest(dir, 'unsloth/M-GGUF', quant, 1);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('remove is a no-op when there is nothing to remove', () => {
    expect(() => removeManifest(dir, 'nope.gguf')).not.toThrow();
  });
});
