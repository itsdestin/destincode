import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deliverableImageMediaType, UNDELIVERABLE_IMAGE_EXTENSIONS, readImageFromDisk } from '../src/main/harness/image-support';

describe('image-support', () => {
  // Fix 5 (2026-08-11 review): the two mkdtempSync calls below never cleaned
  // up, leaking a dir into os.tmpdir() on every run — same defect
  // harness-session-loop.test.ts fixed for its own mkTmpDir helper. Track
  // every dir created via mkTmpDir() and sweep it after each test, whether it
  // passed or threw.
  const tmpDirs: string[] = [];
  function mkTmpDir(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('maps deliverable extensions and rejects the rest', () => {
    expect(deliverableImageMediaType('/a/shot.PNG')).toBe('image/png');
    expect(deliverableImageMediaType('/a/pic.jpeg')).toBe('image/jpeg');
    expect(deliverableImageMediaType('/a/anim.webp')).toBe('image/webp');
    expect(deliverableImageMediaType('/a/notes.txt')).toBeNull();
    // An image format we CANNOT deliver must never be "deliverable" — the
    // old split table promised these and silently delivered nothing.
    expect(deliverableImageMediaType('/a/logo.svg')).toBeNull();
    expect(UNDELIVERABLE_IMAGE_EXTENSIONS.has('.svg')).toBe(true);
    expect(UNDELIVERABLE_IMAGE_EXTENSIONS.has('.bmp')).toBe(true);
    expect(UNDELIVERABLE_IMAGE_EXTENSIONS.has('.avif')).toBe(true);
  });

  it('readImageFromDisk reads a real file and nulls on missing/oversized/undeliverable', () => {
    const p = path.join(mkTmpDir('imgsup-'), 'x.png');
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(readImageFromDisk(p)).toEqual({ mediaType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    expect(readImageFromDisk(path.join(path.dirname(p), 'gone.png'))).toBeNull();
    expect(readImageFromDisk(p.replace('.png', '.svg'))).toBeNull();
  });

  // MAX_ATTACHMENT_BYTES cap: four later tasks rely on oversized attachments
  // being rejected here rather than silently forwarded to the model.
  it('readImageFromDisk nulls on a deliverable image over MAX_ATTACHMENT_BYTES', () => {
    const p = path.join(mkTmpDir('imgsup-'), 'big.png');
    fs.writeFileSync(p, Buffer.alloc(11 * 1024 * 1024));
    expect(readImageFromDisk(p)).toBeNull();
  });
});
