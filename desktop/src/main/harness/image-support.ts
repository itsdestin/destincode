// The ONE extension table + disk reader for image delivery (spec 2026-08-11).
// #290 shipped two disagreeing tables: Read's IMAGE_EXTENSIONS included
// .bmp/.svg/.avif that imagePartsFor's IMAGE_MEDIA_TYPES could not deliver —
// harmless while the tool only refused images, a silent dead end the moment it
// promises one. Everything image-shaped imports from here now.
import * as fs from 'fs';
import * as path from 'path';

// Only formats every mainstream vision model accepts (moved verbatim from
// harness-session.ts).
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp',
};

// Real image formats we deliberately do NOT deliver (providers reject or
// mis-handle them). Read names these honestly instead of promising them.
export const UNDELIVERABLE_IMAGE_EXTENSIONS = new Set(['.bmp', '.svg', '.avif']);

// Attachments are base64'd into the request, so a huge one is a request-size
// failure AND a token bill. 10 MB is far above any screenshot (moved from
// harness-session.ts).
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Model-initiated fetch budgets (spec "Budgets" — starting numbers, tunable).
// Roo caps 20 MB/task, Cline 8 MiB/request; unlimited is the ecosystem outlier.
export const MAX_IMAGES_PER_TURN = 8;
export const MAX_IMAGE_BYTES_PER_TURN = 20 * 1024 * 1024;

export function deliverableImageMediaType(p: string): string | null {
  return IMAGE_MEDIA_TYPES[path.extname(p).toLowerCase()] ?? null;
}

/** Bytes+mediaType for a deliverable image, or null (missing, unreadable,
 *  oversized, or not a deliverable format). Null — never throw — because every
 *  caller (attachment push, tool delivery, resume rebuild) treats a bad file as
 *  a skip-with-note, not a dead turn. */
export function readImageFromDisk(absPath: string): { mediaType: string; data: Buffer } | null {
  const mediaType = deliverableImageMediaType(absPath);
  if (!mediaType) return null;
  try {
    const st = fs.statSync(absPath);
    if (st.size > MAX_ATTACHMENT_BYTES) return null;
    return { mediaType, data: fs.readFileSync(absPath) };
  } catch { return null; }
}
