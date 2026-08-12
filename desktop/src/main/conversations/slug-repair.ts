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

/** Quarantine, not deletion. Lives under ~/.youcoded/ — NEVER inside
 *  ~/.claude/projects/: four subsystems readdir that tree and would adopt a
 *  quarantine folder as a project (spec §6.0). */
export class Quarantine {
  readonly homeRoot: string;
  readonly dir: string;
  constructor(homeRoot: string = os.homedir()) {
    this.homeRoot = homeRoot;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.dir = path.join(homeRoot, '.youcoded', 'repair-quarantine', stamp);
  }
  log(line: string): void {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFileSync(path.join(this.dir, 'decisions.log'), `${new Date().toISOString()} ${line}\n`);
  }
  private destFor(absPath: string): string {
    const rel = path.relative(this.homeRoot, absPath);
    const dest = path.join(this.dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    return dest;
  }
  /** MOVE out of the live tree (reversible). Returns false (and only logs) if
   *  the rename fails (e.g. EXDEV) — never falls back to copy+delete. */
  move(absPath: string, why: string): boolean {
    try {
      fs.renameSync(absPath, this.destFor(absPath));
      this.log(`MOVE ${absPath} (${why})`);
      return true;
    } catch (e) {
      this.log(`SKIP-MOVE ${absPath} (${why}) — rename failed: ${String(e)}`);
      return false;
    }
  }
  /** COPY a snapshot — for case C, where the live tree stays untouched. */
  snapshot(absPath: string, why: string): void {
    try {
      fs.copyFileSync(absPath, this.destFor(absPath));
      this.log(`SNAPSHOT ${absPath} (${why})`);
    } catch (e) {
      this.log(`SKIP-SNAPSHOT ${absPath} — copy failed: ${String(e)}`);
    }
  }
}

export interface RepairOpts {
  projectsDir: string;          // ~/.claude/projects
  homeDir: string;              // os.homedir()
  knownFolders: string[];       // saved folders + managed roots, absolute paths
  quarantine: Quarantine;
  liveMs?: number;              // default LIVE_MTIME_MS
  now?: () => number;           // test seam
  // Test seam for isForeignCwd/firstCwd's platform-relative foreign-cwd check
  // (review fix: firstCwd gained an optional trailing platform param so POSIX
  // fixtures don't silently only pass on POSIX CI runners) — default
  // process.platform, threaded through to firstCwd below.
  platform?: NodeJS.Platform;
}
export interface RepairFinding {
  sessionId: string;
  homeFolder: string;           // the R2 answer (the real project)
  kind: 'moved' | 'quarantined' | 'replaced-with-superset' | 'fork-surfaced' | 'deferred-live';
  paths: string[];
}

export const LIVE_MTIME_MS = 10 * 60 * 1000; // "live" = appended within 10 min (spec §6.5: mechanical, written down)

function topLevelJsonl(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      // DIRECT CHILDREN ONLY — subagent transcripts live at
      // <sessionId>/subagents/ below and travel with their parent (§6.1).
      .filter(e => e.isFile() && e.name.endsWith('.jsonl'))
      .map(e => path.join(dir, e.name));
  } catch { return []; }
}

function isLive(file: string, liveMs: number, now: () => number): boolean {
  try { return now() - fs.statSync(file).mtimeMs < liveMs; } catch { return true; } // unstat-able → treat as live (safe)
}

const sameDir = (a: string, b: string) => path.resolve(a) === path.resolve(b);

export function repairHomeForks(opts: RepairOpts): RepairFinding[] {
  const { projectsDir, homeDir, knownFolders, quarantine: q } = opts;
  const liveMs = opts.liveMs ?? LIVE_MTIME_MS;
  const now = opts.now ?? Date.now;
  const platform = opts.platform ?? process.platform;
  const findings: RepairFinding[] = [];
  const homeSlugDir = path.join(projectsDir, ccProjectSlug(homeDir));

  for (const file of topLevelJsonl(homeSlugDir)) {
    const sessionId = path.basename(file, '.jsonl');
    if (isLive(file, liveMs, now)) {
      findings.push({ sessionId, homeFolder: '', kind: 'deferred-live', paths: [file] });
      continue;
    }
    const cwd = firstCwd(file, platform);              // R2 — NOT R1 (§6.1: R1 would
    if (!cwd || isForeignCwd(cwd, platform)) continue; // call the fork a resident and no-op)
    const P = knownFolders.find(p => sameDir(p, cwd));
    if (!P || sameDir(P, homeDir)) continue;

    const correctDir = path.join(projectsDir, ccProjectSlug(P));
    const correct = path.join(correctDir, path.basename(file));
    if (!fs.existsSync(correct)) {
      fs.mkdirSync(correctDir, { recursive: true });
      fs.renameSync(file, correct);
      q.log(`MOVE-TO-CORRECT ${file} -> ${correct}`);
      findings.push({ sessionId, homeFolder: P, kind: 'moved', paths: [correct] });
      continue;
    }
    switch (classifyPair(file, correct)) {
      case 'identical':
      case 'wrong-is-subset':
        if (q.move(file, `6.1 ${sessionId}: $HOME copy ⊆ correct copy`)) {
          findings.push({ sessionId, homeFolder: P, kind: 'quarantined', paths: [file] });
        }
        break;
      case 'wrong-is-superset':
        if (q.move(correct, `6.1 ${sessionId}: correct copy superseded`)) {
          fs.renameSync(file, correct);
          q.log(`MOVE-TO-CORRECT ${file} -> ${correct} (superset)`);
          findings.push({ sessionId, homeFolder: P, kind: 'replaced-with-superset', paths: [correct] });
        }
        break;
      case 'fork':
        // Case C — NEVER automated (spec §6.0). Snapshot both, change nothing.
        q.snapshot(file, `6.1 FORK ${sessionId} ($HOME copy)`);
        q.snapshot(correct, `6.1 FORK ${sessionId} (project copy)`);
        q.log(`ATTENTION fork ${sessionId}: ${file} vs ${correct} — both left on disk; user decision required`);
        findings.push({ sessionId, homeFolder: P, kind: 'fork-surfaced', paths: [file, correct] });
        break;
    }
  }
  return findings;
}
