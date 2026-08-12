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

/** wrongCopy = the file in the WRONG location; correctCopy = the file where it
 *  belongs. Equal-uuid-different-bytes lands on 'wrong-is-subset' on purpose:
 *  the action (keep the correct-directory copy) is the same, and per-turn
 *  metadata lines legitimately differ between copies. */
export function classifyPair(wrongCopy: string, correctCopy: string):
  'identical' | 'wrong-is-subset' | 'wrong-is-superset' | 'fork' {
  if (fileMd5(wrongCopy) === fileMd5(correctCopy)) return 'identical';
  const w = uuidSet(wrongCopy);
  const c = uuidSet(correctCopy);
  let wOnly = 0; for (const u of w) if (!c.has(u)) wOnly++;
  let cOnly = 0; for (const u of c) if (!w.has(u)) cOnly++;
  if (wOnly === 0) return 'wrong-is-subset';
  if (cOnly === 0) return 'wrong-is-superset';
  return 'fork';
}
