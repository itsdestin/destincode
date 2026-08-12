// One-time, idempotent startup repair for data mis-filed by the slug-encoding
// bug. Ground rules (spec §6.0): NEVER unlink (quarantine instead), NEVER
// union two transcripts (parentUuid chains make a merged file undefined
// behavior), classify every duplicate pair by CONTENT at run time, and a true
// fork (case C) is never automated — snapshot, surface, leave the disk alone.
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { ccProjectSlug, nativeStoreSlug } from '../slug-encoding';
import { firstCwd, isForeignCwd } from '../transcript-cwd';
import { readFolders } from '../saved-folders';
import { getConversationStore } from './service';
import { log } from '../logger';

export function uuidSet(filePath: string): Set<string> {
  const out = new Set<string>();
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.includes('"uuid"')) continue;
    try {
      const u = (JSON.parse(line) as { uuid?: unknown }).uuid;
      if (typeof u === 'string') out.add(u);
    } catch { /* corrupt line — skip */ }
  }
  return out;
}

export function fileMd5(filePath: string): string {
  return crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex');
}

/** uuid -> md5 of that message's raw line bytes. Raw bytes (not the
 *  JSON.parse'd + re-stringified object) on purpose: CC transcripts are
 *  append-only, so a same-uuid byte difference between two copies of "the
 *  same" message means the line was truncated or corrupted in place, not
 *  that JSON key order/whitespace drifted — raw-byte hashing catches that,
 *  a semantic re-stringify would paper over it. */
function uuidContentHashes(filePath: string): Map<string, string> {
  const out = new Map<string, string>();
  let raw = '';
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return out; }
  for (const line of raw.split('\n')) {
    if (!line.includes('"uuid"')) continue;
    try {
      const u = (JSON.parse(line) as { uuid?: unknown }).uuid;
      if (typeof u === 'string') out.set(u, crypto.createHash('md5').update(line).digest('hex'));
    } catch { /* corrupt line — skip */ }
  }
  return out;
}

/** wrongCopy = the file in the WRONG location; correctCopy = the file where it
 *  belongs. Equal-uuid-different-bytes lands on 'wrong-is-subset' on purpose:
 *  the action (keep the correct-directory copy) is the same, and per-turn
 *  metadata lines legitimately differ between copies. */
export function classifyPair(wrongCopy: string, correctCopy: string):
  'identical' | 'wrong-is-subset' | 'wrong-is-superset' | 'fork' {
  if (fileMd5(wrongCopy) === fileMd5(correctCopy)) return 'identical';
  // Same-uuid content divergence check. Set-only comparison (uuid present in
  // both files, ignore its bytes) silently blesses a truncated/corrupted
  // shared message as a clean subset or superset — the copy with the intact
  // version would then get quarantined right along with the truncated one.
  // Fork is the safe direction here: quarantine preserves the disk state
  // either way, but 'fork' routes the pair to a human instead of an
  // automated keeper pick that might throw away the only good copy.
  const wHashes = uuidContentHashes(wrongCopy);
  const cHashes = uuidContentHashes(correctCopy);
  for (const [u, h] of wHashes) {
    const ch = cHashes.get(u);
    if (ch !== undefined && ch !== h) return 'fork';
  }
  const w = uuidSet(wrongCopy);
  const c = uuidSet(correctCopy);
  let wOnly = 0; for (const u of w) if (!c.has(u)) wOnly++;
  let cOnly = 0; for (const u of c) if (!w.has(u)) cOnly++;
  if (wOnly === 0) return 'wrong-is-subset';
  if (cOnly === 0) return 'wrong-is-superset';
  return 'fork';
}
