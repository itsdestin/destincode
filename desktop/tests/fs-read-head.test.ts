// Pins main/fs-read-head.ts, the ONE channel that hands a renderer the first
// bytes of an arbitrary file (composer attachment previews). The contract that
// matters for a channel reachable over the remote WebSocket: never more than
// the cap whatever was asked, sensitive locations refused, binaries refused,
// relative paths refused, honest errors otherwise.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { readFileHead } from '../src/main/fs-read-head';
import { READ_HEAD_MAX_BYTES, clampHeadBytes, decodeHead } from '../src/shared/read-head';

let dir: string;
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-read-head-'));
  fs.writeFileSync(path.join(dir, 'big.txt'), 'a'.repeat(10_000));
  fs.writeFileSync(path.join(dir, 'small.md'), '## Title\n\nbody');
  fs.writeFileSync(path.join(dir, 'accents.txt'), 'é'.repeat(400)); // 2 bytes each
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
  fs.mkdirSync(path.join(dir, '.ssh'));
  fs.writeFileSync(path.join(dir, '.ssh', 'id_rsa'), 'PRIVATE');
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('readFileHead', () => {
  it('returns at most the requested bytes and flags truncation', async () => {
    const r = await readFileHead(path.join(dir, 'big.txt'), 600);
    expect(r).toEqual({ ok: true, text: 'a'.repeat(600), truncated: true });
  });

  it('never reads past the hard cap, whatever the caller asks for', async () => {
    const huge = await readFileHead(path.join(dir, 'big.txt'), 1e9);
    expect(huge.ok && huge.text.length).toBe(READ_HEAD_MAX_BYTES);
    const tiny = await readFileHead(path.join(dir, 'big.txt'), -5);
    expect(tiny.ok && tiny.text.length).toBe(1);
    const dflt = await readFileHead(path.join(dir, 'big.txt'), 'nope' as unknown as number);
    expect(dflt.ok && dflt.text.length).toBe(clampHeadBytes(undefined));
  });

  it('returns the whole file, untruncated, when it fits', async () => {
    expect(await readFileHead(path.join(dir, 'small.md'), 600))
      .toEqual({ ok: true, text: '## Title\n\nbody', truncated: false });
  });

  it('drops a character cut in half by the byte cap', async () => {
    const r = await readFileHead(path.join(dir, 'accents.txt'), 601);
    expect(r.ok && r.text).toBe('é'.repeat(300));
    expect(r.ok && r.truncated).toBe(true);
    // The shared decoder keeps a real U+FFFD when the read was NOT truncated.
    expect(decodeHead(new Uint8Array([0xc3]), false)).toBe('\uFFFD');
  });

  it('refuses binaries, sensitive locations, relative paths, directories, and reports a missing file honestly', async () => {
    expect(await readFileHead(path.join(dir, 'blob.bin'), 600)).toEqual({ ok: false, error: 'binary' });
    expect(await readFileHead(path.join(dir, '.ssh', 'id_rsa'), 600)).toEqual({ ok: false, error: 'not-allowed' });
    expect(await readFileHead(path.join(dir, '.env'), 600)).toEqual({ ok: false, error: 'not-allowed' });
    expect(await readFileHead('relative/notes.md', 600)).toEqual({ ok: false, error: 'no path' });
    expect(await readFileHead('', 600)).toEqual({ ok: false, error: 'no path' });
    expect(await readFileHead(undefined, 600)).toEqual({ ok: false, error: 'no path' });
    expect(await readFileHead(dir, 600)).toEqual({ ok: false, error: 'not-a-file' });
    expect(await readFileHead(path.join(dir, 'missing.md'), 600)).toEqual({ ok: false, error: 'orphan' });
  });
});
