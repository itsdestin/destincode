// Leaf module — the slug repair runner's on-disk state shape, plus the
// fork-hold reader BOTH slug-repair.ts (the runner) and conversations/
// service.ts (the mirror sweeps) need. No imports beyond fs/path/os on
// purpose: service.ts importing slug-repair.ts directly would create a
// CYCLE (slug-repair.ts imports getConversationStore from ./service), so
// this tiny module is the shared seam both sides import from instead.
import fs from 'fs';
import os from 'os';
import path from 'path';

// A held fork's id, plus the exact absolute paths its snapshot/finding named
// at the moment it was (re)surfaced (review fix, IMPORTANT 2 — auto-release
// on absence of evidence). Recording paths lets the runner tell "user
// resolved the fork" (a recorded path no longer exists on disk) apart from
// "this run's scan simply didn't reach the pair" (e.g. a knownFolders miss,
// or readFolders() throwing) — the latter must NOT release the hold, or
// materializeSweep can clobber the smaller fork copy within seconds of the
// hold silently dropping.
export interface SurfacedFork {
  id: string;
  paths: string[];
}
export interface RepairState {
  v: 1;
  deferred: Record<string, number>;
  // True forks (spec §6.0 Case C) the repair has surfaced to the user and
  // left on disk, untouched. See heldForkIds' WHY below for what holding a
  // fork actually protects against.
  surfacedForks: SurfacedFork[];
}

export function defaultStateFile(homeDir: string = os.homedir()): string {
  // Test seam (review fix, MINOR): conversations/service.ts calls
  // heldForkIds()/readState() with no stateFile override on the production
  // code path, so a test that exercises that path with no seam reads the
  // DEVELOPER'S REAL ~/.youcoded/slug-repair-state.json — non-hermetic, and
  // whatever this machine's file happens to hold silently changes what the
  // test observes. This env var is a test-only escape hatch; production never
  // sets it.
  if (process.env.YOUCODED_SLUG_REPAIR_STATE) return process.env.YOUCODED_SLUG_REPAIR_STATE;
  return path.join(homeDir, '.youcoded', 'slug-repair-state.json');
}

// Normalizes one raw surfacedForks entry: the pre-this-fix shape was a bare
// session-id string (no recorded paths); tolerate that on read so an
// existing state file doesn't get treated as corrupt. Anything unrecognized
// is dropped rather than guessed at — a bad entry silently disappearing is
// safer than a bad entry silently holding the wrong thing.
function normalizeSurfacedFork(entry: unknown): SurfacedFork | null {
  if (typeof entry === 'string') return { id: entry, paths: [] };
  if (entry && typeof entry === 'object') {
    const e = entry as { id?: unknown; paths?: unknown };
    if (typeof e.id === 'string') {
      const paths = Array.isArray(e.paths) ? e.paths.filter((p): p is string => typeof p === 'string') : [];
      return { id: e.id, paths };
    }
  }
  return null;
}

/** Reads the state file, normalizing a missing/corrupt file, a
 *  pre-fork-hold file (no `surfacedForks` key), or a pre-paths-tracking file
 *  (`surfacedForks` as bare id strings) to the current shape. */
export function readState(stateFile?: string): RepairState {
  const file = stateFile ?? defaultStateFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { deferred?: Record<string, number>; surfacedForks?: unknown };
    const surfacedForks = Array.isArray(raw.surfacedForks)
      ? raw.surfacedForks.map(normalizeSurfacedFork).filter((f): f is SurfacedFork => f !== null)
      : [];
    return {
      v: 1,
      deferred: raw.deferred ?? {},
      surfacedForks,
    };
  } catch {
    return { v: 1, deferred: {}, surfacedForks: [] };
  }
}

export function writeState(state: RepairState, stateFile?: string): void {
  const file = stateFile ?? defaultStateFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

/** WHY: a surfaced fork (spec §6.0 Case C — two diverged copies of one
 *  session, both preserved, never auto-resolved) must be immune to the
 *  size-gated mirrors in BOTH directions until a human resolves it.
 *  transcript-mirror.ts's materializeOut/mirrorIn are grow-only BY SIZE, not
 *  content-aware — for a fork, larger is not a superset. Without this hold,
 *  materializeOut's grow-only rule clobbers the smaller fork copy within
 *  seconds of the repair releasing the sweeps (observed 2026-08-15: 74
 *  messages of session 26d919ff displaced into quarantine because the space
 *  copy of the fork happened to be larger than the project-dir copy), and the
 *  next launch sees two identical copies and silently stops surfacing the
 *  fork. Cheap on-disk read; returns an empty set on a missing/corrupt state
 *  file so a fresh install never treats "no state yet" as "everything held". */
export function heldForkIds(stateFile?: string): Set<string> {
  return new Set(readState(stateFile).surfacedForks.map((f) => f.id));
}
