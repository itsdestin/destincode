// desktop/src/main/sync-spaces/repair.ts
// Pure fs helpers for the two-tier corruption repair (2026-07-30 spec §2).
// The orchestration lives on GitTransport.repair() (it needs the credentialed
// git runner); these helpers hold the fs mechanics so they unit-test without
// spawning git.
import fs from 'fs';
import path from 'path';

/**
 * Delete every ZERO-BYTE loose object under <gitDir>/objects. Returns a count.
 *
 * WHY zero-byte specifically: a power loss during a loose-object write leaves
 * the FILENAME (the rename landed) with no CONTENT (never flushed). That file
 * is POISON, not just damage — git checks object existence by name, so
 * `add -A` sees it "exists" and never rewrites it from the intact worktree
 * file. The repo can therefore never self-heal until the empty file is gone;
 * deleting it makes the next `add` regenerate the object. (16 of these across
 * three crashes in the 2026-07-27 Z13 incident.)
 *
 * Best-effort per file; one-level walk matching git's objects/<2-hex>/<38-hex>
 * layout (pack/ and info/ contain no zero-byte hazards worth recursing for).
 */
export function deleteZeroByteObjects(gitDir: string): number {
  const objects = path.join(gitDir, 'objects');
  let removed = 0;
  let dirs: string[] = [];
  try { dirs = fs.readdirSync(objects); } catch { return 0; }
  for (const d of dirs) {
    const dir = path.join(objects, d);
    let entries: string[] = [];
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      entries = fs.readdirSync(dir);
    } catch { continue; }
    for (const f of entries) {
      const p = path.join(dir, f);
      try {
        if (fs.statSync(p).size === 0) { fs.rmSync(p, { force: true }); removed++; }
      } catch { /* raced away / unreadable — the git-level verify catches it */ }
    }
  }
  return removed;
}

/** `<gitDir>.broken-2026-07-30T14-05-06` — colons replaced (Windows paths). */
export function brokenBackupName(gitDir: string, now: Date): string {
  return `${gitDir}.broken-${now.toISOString().slice(0, 19).replace(/:/g, '-')}`;
}

/**
 * Keep only the NEWEST `<basename>.broken-*` sibling of gitDir; delete older
 * ones. Backups exist so a repair can never destroy evidence, but corruption
 * recurs on crash-prone hardware (three in three days on the Z13) and each
 * backup is a full repo — unbounded they'd eat the disk.
 */
export function pruneBrokenBackups(gitDir: string): void {
  const parent = path.dirname(gitDir);
  const prefix = `${path.basename(gitDir)}.broken-`;
  let entries: string[] = [];
  try { entries = fs.readdirSync(parent).filter(e => e.startsWith(prefix)); } catch { return; }
  // ISO timestamps sort lexically — newest last.
  entries.sort();
  for (const stale of entries.slice(0, -1)) {
    try { fs.rmSync(path.join(parent, stale), { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
