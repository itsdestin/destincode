import * as path from 'path';

// WHY this file exists at all: comparing your branch against master must not
// silently compare two GRADERS as well as two harnesses. The orchestrator
// always loads assertions/judge/report from its own checkout; only the worker
// loads the dist under test. Two functions so the distinction is impossible to
// get wrong by accident, and testable without spawning anything.
//
// WHY __dirname (not the cell's dist, ever): this file compiles under
// tsconfig's `module: "commonjs"`, so __dirname is the real absolute path of
// THIS file inside dist/main/harness/eval/ once built — i.e. the checkout that
// is running the orchestrator, never whatever `--dist` a cell happens to name.
// graderRoot ignores its argument entirely (see the `_cell` name) so that
// "own checkout" can never accidentally leak in a value derived from the
// per-run dist, which is the exact bug this module exists to make impossible.
const OWN_DIST_ROOT = path.resolve(__dirname, '..', '..', '..');

/** Root the orchestrator loads assertions/judge/report from — always this
 *  checkout's own build, never the cell's `dist`. The parameter is accepted
 *  (not used) only so call sites can pass a `Cell` without a special case. */
export function graderRoot(_cell: { dist: string }): string {
  return OWN_DIST_ROOT;
}

/** Root the worker loads the harness under test (`run-case.js`, etc.) from —
 *  the cell's own `dist`, so a branch-vs-master comparison actually runs two
 *  different harness builds. */
export function harnessRoot(cell: { dist: string }): string {
  return cell.dist;
}
