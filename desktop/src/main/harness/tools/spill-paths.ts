// Where Bash spills full output that doesn't fit inline.
//
// WHY this is its own module rather than living in bash.ts (2026-08-11 review
// round 8): the path guard has to recognize a spill file to let the model read
// one back (see checkPathGuard in guards.ts), and bash.ts already imports
// guards.ts — putting the definition there and importing it here would be a
// cycle. One definition, two importers, no chance of the guard and the writer
// disagreeing about where spill files live.
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
