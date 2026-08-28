// Where Bash spills full output that doesn't fit inline.
//
// WHY this is its own module rather than living in bash.ts (2026-08-11 review
// round 8): the path guard has to recognize a spill file to let the model read
// one back (see checkPathGuard in guards.ts), and bash.ts already imports
// guards.ts — putting the definition there and importing it here would be a
// cycle. One definition, two importers, no chance of the guard and the writer
// disagreeing about where spill files live.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Root of every session's spill directory. Session-scoped subfolders below it
 *  keep one conversation's files easy to reason about in isolation, while the
 *  single parent lets the retention sweep walk every session's leftovers —
 *  including ones from sessions that ended long ago — in a single pass. */
export function spillRoot(): string {
  return path.join(os.tmpdir(), 'youcoded-harness-bash-output');
}

export function spillDirFor(sessionId: string): string {
  // Never trust sessionId as a path segment verbatim — strip anything that
  // isn't alnum/dash/underscore so a pathological id can't escape spillRoot().
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  return path.join(spillRoot(), safe);
}

// WHY a module-level once-flag, not a timer (2026-08-10 review — OpenCode's
// precedent is a 7-day TTL swept hourly): a spill-to-file design that never
// cleans up is a slow disk leak, real in every surveyed design that adds this
// affordance without a retention policy (even Claude Code's docs don't state
// one). We have no scheduler primitive here worth adding a dependency for, so
// instead sweep once per process lifetime, on the first spill this process
// ever writes — for a long-running desktop app that lands close enough to
// OpenCode's cadence without a timer that outlives every session.
//
// G-1 (2026-08-28): this lives HERE rather than in bash.ts because the
// ShellRegistry writes background-command logs into the very same tree. In
// bash.ts the sweep only ever fired from a FOREGROUND spill, so a user whose
// long commands all ran in the background would never have triggered it and
// every log would accumulate forever.
const SPILL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let sweepScheduled = false;

/** The sweep itself — always runs. Exported so a test can drive it directly. */
export async function sweepOldSpillFiles(): Promise<void> {
  const root = spillRoot();
  const cutoff = Date.now() - SPILL_TTL_MS;
  let sessionDirs: fs.Dirent[];
  try {
    sessionDirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    // spillRoot() doesn't exist yet (first spill ever on this machine) — nothing to sweep.
    return;
  }
  for (const d of sessionDirs) {
    if (!d.isDirectory()) continue;
    const sessDir = path.join(root, d.name);
    let files: string[] = [];
    try {
      files = await fs.promises.readdir(sessDir);
    } catch {
      continue;
    }
    for (const f of files) {
      const fp = path.join(sessDir, f);
      try {
        const st = await fs.promises.stat(fp);
        if (st.mtimeMs < cutoff) await fs.promises.unlink(fp);
      } catch {
        // Best-effort: a file that vanished mid-sweep, or that we can't
        // stat/unlink for permission reasons, isn't worth failing the
        // whole sweep over — it'll be retried next process launch.
      }
    }
    // Tidy up an emptied session dir too, so orphaned folders don't pile up.
    try {
      const remaining = await fs.promises.readdir(sessDir);
      if (remaining.length === 0) await fs.promises.rmdir(sessDir);
    } catch {
      /* best-effort */
    }
  }
}

/** Once per process, on the first spill anything writes. Called by BOTH
 *  writers: bash.ts's foreground spill and the ShellRegistry's background log. */
export function sweepOldSpillFilesOnce(): void {
  if (sweepScheduled) return;
  sweepScheduled = true;
  void sweepOldSpillFiles().catch(() => {
    /* best-effort — retried on the next process launch */
  });
}
