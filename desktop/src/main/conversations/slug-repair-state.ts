// Leaf module — the slug repair runner's on-disk state shape, plus the
// fork-hold reader BOTH slug-repair.ts (the runner) and conversations/
// service.ts (the mirror sweeps) need. No imports beyond fs/path/os on
// purpose: service.ts importing slug-repair.ts directly would create a
// CYCLE (slug-repair.ts imports getConversationStore from ./service), so
// this tiny module is the shared seam both sides import from instead.
import fs from 'fs';
import os from 'os';
import path from 'path';

export interface RepairState {
  v: 1;
  deferred: Record<string, number>;
  // Session ids of true forks (spec §6.0 Case C) the repair has surfaced to
  // the user and left on disk, untouched. See heldForkIds' WHY below for what
  // holding a fork actually protects against.
  surfacedForks: string[];
}

export function defaultStateFile(homeDir: string = os.homedir()): string {
  return path.join(homeDir, '.youcoded', 'slug-repair-state.json');
}

/** Reads the state file, normalizing a missing/corrupt file or a
 *  pre-fork-hold file (no `surfacedForks` key) to an empty array — backward
 *  compatible with the `{ v, deferred }` shape this file had before. */
export function readState(stateFile?: string): RepairState {
  const file = stateFile ?? defaultStateFile();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<RepairState>;
    return {
      v: 1,
      deferred: raw.deferred ?? {},
      surfacedForks: Array.isArray(raw.surfacedForks) ? raw.surfacedForks : [],
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
  return new Set(readState(stateFile).surfacedForks);
}
