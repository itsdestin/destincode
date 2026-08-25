import { describe, it, expect } from 'vitest';
import { rendersFromBytesOnly } from '../src/renderer/components/artifact-views/RendererRegistry';

describe('rendersFromBytesOnly', () => {
  it('is true for formats whose viewer reads its own bytes', () => {
    for (const p of ['a.png', 'a.JPG', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp',
                     'a.ico', 'a.avif', 'a.pdf', 'a.docx', 'a.xlsx']) {
      expect(rendersFromBytesOnly(p)).toBe(true);
    }
  });

  // SVG renders through ImageView but IS text and IS editable today — it must
  // keep the text fetch or the pencil disappears (spec D5).
  it('is false for svg', () => {
    expect(rendersFromBytesOnly('logo.svg')).toBe(false);
  });

  it('is false for text and unknown extensions', () => {
    for (const p of ['a.md', 'a.ts', 'a.csv', 'a.html', 'a.rs', 'Makefile', '']) {
      expect(rendersFromBytesOnly(p)).toBe(false);
    }
  });
});
