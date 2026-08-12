// desktop/src/main/transcript-cwd.ts
// The two transcript-ownership rules from the spec (§5.4). They answer
// DIFFERENT questions and an earlier draft conflated them — read the spec
// section before "simplifying" one into the other.
//   R2 firstCwd(file)   — "which project does this SESSION belong to?"
//                         First non-foreign cwd; 200-line cap is safe here
//                         (observed max first-cwd line: 49).
//   R1 r1CwdForDir(dir) — "which path does this slug DIRECTORY encode?"
//                         Accept only a cwd that re-slugs to the dirname;
//                         must scan WHOLE files (the motivating fork's
//                         matching cwd first appears at line 279).
import fs from 'fs';
import path from 'path';
import { ccProjectSlug } from './slug-encoding';

export const R2_SCAN_CAP = 200;
const HEAD_BYTES = 512 * 1024;

/** A cwd recorded by a PEER platform's device (materialized transcript) —
 *  must never be resolved on this one (spec risk 3: 376/648 files here). */
export function isForeignCwd(cwd: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return cwd.startsWith('/');
  return /^[A-Za-z]:[\\/]/.test(cwd);
}

function extractCwd(lineText: string): string | null {
  if (!lineText.includes('"cwd"')) return null;
  try {
    const cwd = (JSON.parse(lineText) as { cwd?: unknown }).cwd;
    return typeof cwd === 'string' && cwd ? cwd : null;
  } catch { return null; }
}

/** Bounded head read — R2 never needs more than the first lines, and some
 *  transcripts are >13MB. */
function headText(filePath: string): string | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

/** R2 — session origin. */
export function firstCwd(filePath: string): string | null {
  const head = headText(filePath);
  if (head === null) return null;
  const lines = head.split('\n').slice(0, R2_SCAN_CAP);
  for (const l of lines) {
    const cwd = extractCwd(l);
    if (cwd && !isForeignCwd(cwd)) return cwd;
  }
  return null;
}

/** Every cwd in the file — full read; used by R1's exhaustive tier. */
export function allCwds(filePath: string): string[] {
  let raw: string;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const out: string[] = [];
  for (const l of raw.split('\n')) {
    const cwd = extractCwd(l);
    if (cwd) out.push(cwd);
  }
  return out;
}

/** R1 — directory identity. Tier 1 (cheap): each file's first cwd. Tier 2
 *  (exhaustive): every cwd in every file. Lowercased compare matches
 *  buildSlugToName's Windows case-drift convention (reconciler.ts). */
export function r1CwdForDir(dirPath: string): string | null {
  const dirName = path.basename(dirPath).toLowerCase();
  let files: string[] = [];
  try { files = fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl')); } catch { return null; }
  for (const f of files) {
    const cwd = firstCwd(path.join(dirPath, f));
    if (cwd && ccProjectSlug(cwd).toLowerCase() === dirName) return cwd;
  }
  for (const f of files) {
    for (const cwd of allCwds(path.join(dirPath, f))) {
      if (!isForeignCwd(cwd) && ccProjectSlug(cwd).toLowerCase() === dirName) return cwd;
    }
  }
  return null;
}
