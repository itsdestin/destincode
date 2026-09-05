// Is the workspace itself up to date?
//
// WHY this is on the page at all: `.claude/rules/`, `docs/MAP.md`, CLAUDE.md and
// `scripts/` are read — and RUN — from the shared checkout, so a stale checkout
// GOVERNS every new session with stale rules and stale tooling, and you cannot
// read your way out of it. It has silently sat 175 commits behind for 31 hours.
// Nothing on this machine says so at a glance; that is what this fixes.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);

async function git(dir, args, timeoutMs = 15000) {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Age of the last `git fetch`, in seconds — or null if it has never fetched.
 *  A behind-count is only as true as the fetch behind it, so the page shows both
 *  rather than implying a stale number is current. */
function fetchAgeSeconds(dir) {
  for (const rel of ['.git/FETCH_HEAD', '.git/refs/remotes/origin/HEAD']) {
    try {
      return Math.round((Date.now() - fs.statSync(path.join(dir, rel)).mtimeMs) / 1000);
    } catch { /* try the next one */ }
  }
  return null;
}

async function repoState(dir, name, { fetch }) {
  if (!fs.existsSync(path.join(dir, '.git'))) return null;

  let fetchFailed = false;
  if (fetch) {
    // A real fetch, so the number means "right now" rather than "whenever someone
    // last ran setup.sh". Offline is normal and is reported, never guessed at.
    if ((await git(dir, ['fetch', '--quiet', 'origin'])) === null) fetchFailed = true;
  }

  const branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const upstream = (await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']))
    ?? (branch ? `origin/${branch}` : null);

  let behind = null;
  let ahead = null;
  if (upstream) {
    const counts = await git(dir, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]);
    if (counts) {
      const [a, b] = counts.split(/\s+/).map(Number);
      ahead = Number.isFinite(a) ? a : null;
      behind = Number.isFinite(b) ? b : null;
    }
  }

  const dirtyOut = await git(dir, ['status', '--porcelain']);
  const dirtyFiles = dirtyOut ? dirtyOut.split('\n').filter(Boolean) : [];

  // Which dirty files would actually STOP a pull. A file merely untracked or
  // modified is not the same as one the incoming commits also touch — and only
  // the second kind blocks. Naming them is the difference between "something is
  // wrong" and a fix you can act on.
  let blocking = [];
  if (upstream && behind) {
    const changedUpstream = await git(dir, ['diff', '--name-only', `HEAD...${upstream}`]);
    const incoming = new Set((changedUpstream ?? '').split('\n').filter(Boolean));
    blocking = dirtyFiles
      .map((l) => l.slice(3))
      .filter((f) => incoming.has(f));
  }

  return {
    name,
    branch,
    ahead,
    behind,
    dirty: dirtyFiles.length,
    blocking,
    fetchFailed,
    fetchAgeSeconds: fetchAgeSeconds(dir),
  };
}

/** The workspace and every sub-repo beside it. The workspace comes first because
 *  it is the one that governs the next session's rules. */
export async function workspaceState(workspaceRoot, { fetch = true } = {}) {
  const subRepoNames = fs.readdirSync(workspaceRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'worktrees')
    .filter((e) => fs.existsSync(path.join(workspaceRoot, e.name, '.git')))
    .map((e) => e.name)
    .sort();

  const [workspace, ...repos] = await Promise.all([
    repoState(workspaceRoot, 'workspace', { fetch }),
    ...subRepoNames.map((n) => repoState(path.join(workspaceRoot, n), n, { fetch })),
  ]);

  return { workspace, repos: repos.filter(Boolean) };
}

/** One verdict for the whole thing, in words that say what it COSTS rather than
 *  what git measured. `stale` is the one that matters: it means the next session
 *  starts with out-of-date instructions. */
export function verdict(state) {
  const w = state.workspace;
  if (!w) return { tone: 'warn', headline: 'Workspace state unknown', detail: 'No git repo found at the workspace root.' };
  if (w.fetchFailed) {
    return {
      tone: 'warn',
      headline: 'Could not check for updates',
      detail: 'The fetch from GitHub failed — offline, most likely. The counts below are from the last successful check.',
    };
  }
  if (w.behind && w.behind > 0) {
    return {
      tone: 'stale',
      headline: `Workspace is ${w.behind} update${w.behind === 1 ? '' : 's'} behind`,
      detail: w.blocking.length
        ? `New sessions are loading guidance that is ${w.behind} update(s) out of date. `
          + `${w.blocking.length} local file(s) are blocking the update: ${w.blocking.join(', ')}`
        : `New sessions are loading guidance that is ${w.behind} update(s) out of date. `
          + 'Nothing is blocking it — a sync will fix it.',
    };
  }
  return {
    tone: 'ok',
    headline: 'Workspace is up to date',
    detail: w.dirty > 0
      ? `New sessions load the latest guidance. ${w.dirty} local file(s) are uncommitted, but none block an update.`
      : 'New sessions load the latest guidance.',
  };
}
