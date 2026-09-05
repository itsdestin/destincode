// Enumerates every checkout of a repo (the main one plus every registered
// worktree) and says, for each, whether deleting it would lose work.
// Read-only: nothing here writes to a repo.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);

/** Run a git command in `dir`, returning trimmed stdout, or `null` if git failed.
 *  WHY swallow the error: a worktree whose directory was deleted, or a branch with
 *  no remote, makes git exit non-zero. That is information, not a crash — every
 *  caller below turns a null into a defined default. */
async function git(dir, args) {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** One checkout, one pill. The ORDER is the whole point: uncommitted files
 *  outrank everything, because they are the only state git itself has no copy of.
 *  context-inject.sh reads `ahead == 0` as "merged or empty, candidate for
 *  cleanup" BEFORE consulting the dirty count, which labelled a worktree holding
 *  40 uncommitted files on a zero-commit branch safe to delete (2026-09-01). */
export function classify({ dirty, ahead, pushed, merged }) {
  if (dirty > 0) return 'unsaved';
  if (ahead > 0 && !pushed) return 'unpushed';
  if (pushed && !merged) return 'pushed';
  return 'safe';
}

/** Stable, path-derived address for a checkout. Requests name THIS, never a path,
 *  so nothing arriving over the network is ever used to build a filesystem path. */
export function checkoutId(p) {
  return p.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function measure(dir, branch, base) {
  const dirtyOut = await git(dir, ['status', '--porcelain']);
  const dirty = dirtyOut ? dirtyOut.split('\n').filter(Boolean).length : 0;

  const aheadOut = await git(dir, ['rev-list', '--count', `${base}..HEAD`]);
  const ahead = aheadOut === null ? 0 : Number(aheadOut) || 0;

  // Pushed means the branch exists on the remote AND the remote is at our tip.
  // A branch pushed once and committed to since is NOT pushed — that distinction
  // is the difference between "backed up" and "the only copy".
  let pushed = false;
  if (branch) {
    const local = await git(dir, ['rev-parse', 'HEAD']);
    const remote = await git(dir, ['rev-parse', `origin/${branch}`]);
    pushed = Boolean(local && remote && local === remote);
  }

  const merged = (await git(dir, ['merge-base', '--is-ancestor', 'HEAD', base])) !== null;

  return { dirty, ahead, pushed, merged };
}

/** Every checkout of `repoDir`: the main one plus every registered worktree. */
export async function listCheckouts(repoDir, opts = {}) {
  const base = opts.base ?? 'origin/master';
  const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
  if (porcelain === null) return [];

  // Parse git's own registry rather than scanning directories: worktrees live in
  // four different places on this machine and a name-pattern scan has silently
  // missed all of them before (context-inject.sh's comment records that outage).
  const entries = [];
  let current = null;
  for (const line of porcelain.split('\n')) {
    if (line.startsWith('worktree ')) {
      // git lists the MAIN checkout first. It is not a worktree you would ever
      // remove — everything else hangs off it — so it is marked and never offered
      // for cleanup, however clean it happens to look.
      current = { path: line.slice('worktree '.length), branch: null, isMain: entries.length === 0 };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      current.branch = line.slice('branch '.length).replace('refs/heads/', '');
    }
  }

  return Promise.all(entries.map(async (e) => {
    const common = {
      id: checkoutId(e.path),
      path: e.path,
      name: path.basename(e.path),
      branch: e.branch,
      isMain: e.isMain,
    };
    // A worktree still registered against a deleted directory: report it rather
    // than letting every git call below fail one at a time.
    if (!fs.existsSync(path.join(e.path, '.git'))) {
      return {
        ...common, dirty: 0, ahead: 0, pushed: false, merged: false,
        status: 'safe', missing: true,
      };
    }
    const m = await measure(e.path, e.branch, base);
    // The main checkout still gets a real status — "unsaved work" there matters as
    // much as anywhere — but never the word "safe to delete".
    return { ...common, ...m, status: classify(m), missing: false };
  }));
}
