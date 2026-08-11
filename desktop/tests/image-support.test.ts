import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { deliverableImageMediaType, UNDELIVERABLE_IMAGE_EXTENSIONS, readImageFromDisk } from '../src/main/harness/image-support';

describe('image-support', () => {
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
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'imgsup-')), 'x.png');
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(readImageFromDisk(p)).toEqual({ mediaType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) });
    expect(readImageFromDisk(path.join(path.dirname(p), 'gone.png'))).toBeNull();
    expect(readImageFromDisk(p.replace('.png', '.svg'))).toBeNull();
  });
});
