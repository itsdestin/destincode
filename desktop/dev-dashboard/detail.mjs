// What is actually IN a checkout — the answer to "it says unsaved work, so what?"
//
// The list view says a branch holds 40 uncommitted files. That is a fact you can
// do nothing with. This is the layer that turns it into: which files, what kind of
// files, what this branch was for, how long it has sat, whether it has an open PR
// — and therefore what to do about it.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const run = promisify(execFile);

async function git(dir, args, timeoutMs = 20000) {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

/** Like git(), but strips ONLY the trailing newline.
 *  WHY this exists: `status --porcelain` encodes state in the first two columns,
 *  and an unstaged edit is " M path". `.trim()` removes the leading space of the
 *  FIRST line only, so that one file's name silently lost its first character —
 *  a wrong filename shown confidently, and intermittent because it depends on
 *  which file git happens to list first. */
async function gitRaw(dir, args, timeoutMs = 20000) {
  try {
    const { stdout } = await run('git', ['-C', dir, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: timeoutMs,
    });
    return stdout.replace(/\n$/, '');
  } catch {
    return null;
  }
}

// Grouped for someone who does not read code. "14 files changed" says nothing;
// "9 notes, 3 bits of code, 2 pictures" says whether it is worth keeping.
const KIND = [
  { kind: 'Notes and documents', test: /\.(md|txt|rst)$/i },
  { kind: 'Pictures and video', test: /\.(png|jpe?g|svg|webp|gif|webm|mp4)$/i },
  { kind: 'Settings and data', test: /\.(json|ya?ml|toml|ini|lock)$/i },
  { kind: 'Code', test: /\.(ts|tsx|js|jsx|mjs|cjs|kt|java|py|sh|css|html)$/i },
];

function kindOf(file) {
  return KIND.find((k) => k.test.test(file))?.kind ?? 'Other files';
}

// git's porcelain codes, in words. XY where X is the index and Y the worktree.
function stateOf(code) {
  if (code.startsWith('??')) return 'new, never saved';
  if (code.includes('D')) return 'deleted';
  if (code.includes('A')) return 'added';
  if (code.includes('R')) return 'renamed';
  return 'edited';
}

/** Everything a row needs when you open it. Computed on demand, not for the list:
 *  this runs a diff and optionally shells out to `gh`, which is far too slow to do
 *  24 times on every page load. */
export async function checkoutDetail(checkout, { includePr = true } = {}) {
  const dir = checkout.path;

  const porcelain = await gitRaw(dir, ['status', '--porcelain']);
  const rawFiles = (porcelain ?? '').split('\n').filter(Boolean);

  // Line counts for tracked edits only — an untracked file has nothing to diff
  // against, and reporting 0 for it would read as "empty" rather than "brand new".
  const numstat = await git(dir, ['diff', '--numstat']);
  const churn = new Map();
  for (const line of (numstat ?? '').split('\n').filter(Boolean)) {
    const [add, del, file] = line.split('\t');
    churn.set(file, { added: Number(add) || 0, removed: Number(del) || 0 });
  }

  const files = rawFiles.map((l) => {
    const code = l.slice(0, 2);
    const file = l.slice(3).replace(/^"|"$/g, '');
    return {
      file,
      kind: kindOf(file),
      state: stateOf(code),
      ...(churn.get(file) ?? { added: null, removed: null }),
    };
  });

  const byKind = {};
  for (const f of files) (byKind[f.kind] ??= []).push(f);

  // %x1f is ASCII unit separator — a delimiter that cannot appear in a commit
  // subject, unlike any punctuation someone might actually type.
  const logOut = await git(dir, [
    'log', '--max-count=8', '--format=%h%x1f%s%x1f%cr%x1f%an', 'origin/master..HEAD',
  ]);
  const commits = (logOut ?? '').split('\n').filter(Boolean).map((l) => {
    const [sha, subject, when, author] = l.split('\x1f');
    return { sha, subject, when, author };
  });

  // How long this has sat. A branch untouched for three weeks holding the only
  // copy of something is a different kind of urgent from one touched an hour ago.
  const lastCommitIso = await git(dir, ['log', '-1', '--format=%cI']);
  const lastCommitRel = await git(dir, ['log', '-1', '--format=%cr']);

  let pr = null;
  if (includePr && checkout.branch) {
    try {
      const { stdout } = await run(
        'gh',
        ['pr', 'list', '--head', checkout.branch, '--state', 'all',
         '--json', 'number,title,state,url,isDraft', '--limit', '1'],
        { cwd: dir, timeout: 20000 },
      );
      const list = JSON.parse(stdout);
      pr = list[0] ?? null;
    } catch {
      // gh missing, unauthenticated, or offline. Absence of a PR record is not
      // evidence there is no PR, so the page says "could not check", never "none".
      pr = { unavailable: true };
    }
  }

  return {
    id: checkout.id,
    files,
    byKind,
    commits,
    lastCommitIso,
    lastCommitRel,
    pr,
    totals: {
      files: files.length,
      added: [...churn.values()].reduce((n, c) => n + c.added, 0),
      removed: [...churn.values()].reduce((n, c) => n + c.removed, 0),
    },
  };
}

/** Record everything in a checkout as a commit on a new wip branch, and push it.
 *
 *  WHY this is the one action the page performs rather than prompts for: done this
 *  way it is purely ADDITIVE and invisible. It builds the commit with git plumbing
 *  against a THROWAWAY INDEX, so the working tree, the real index, HEAD and the
 *  current branch are all left byte-for-byte as they were found. The files stay on
 *  disk, still uncommitted, exactly where a session working in that folder expects
 *  them — and a copy now also exists on GitHub.
 *
 *  The obvious implementation (checkout -b, add, commit, checkout back) is WRONG
 *  and was written first: committing the changes and then switching back to the
 *  original branch removes those files from the working tree. A session editing
 *  that folder would have watched its work disappear.
 *
 *  It does NOT clean up, remove worktrees, move any existing branch, or touch
 *  master. Those stay prompts. */
export async function backupWork(checkout) {
  const dir = checkout.path;
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  const branch = `wip/${checkout.name}-${stamp}`;

  const before = await git(dir, ['status', '--porcelain']);
  if (!before) {
    return { ok: false, error: 'Nothing to back up — this checkout has no uncommitted files.' };
  }
  const fileCount = before.split('\n').filter(Boolean).length;

  const head = await git(dir, ['rev-parse', 'HEAD']);
  if (!head) {
    return { ok: false, error: 'This checkout has no commits yet, so there is nothing to attach a backup to.' };
  }

  // A throwaway index in the system temp dir, NOT inside the repo: everything
  // below writes there instead of to .git/index, so a session staging files in
  // this folder at the same moment is unaffected.
  const tmpIndex = path.join(os.tmpdir(), `dev-dashboard-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

  const plumb = async (args, timeoutMs = 60000) => {
    try {
      const { stdout } = await run('git', ['-C', dir, ...args], { env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
      return stdout.trim();
    } catch (e) {
      return { __error: e.message };
    }
  };

  try {
    // Seed the throwaway index from HEAD, then stage everything on disk into it.
    // `add --all` still honours .gitignore, so node_modules is not swept in.
    const seeded = await plumb(['read-tree', head]);
    if (seeded?.__error) return { ok: false, error: `Could not prepare the backup: ${seeded.__error}` };

    const added = await plumb(['add', '--all']);
    if (added?.__error) return { ok: false, error: `Could not gather the files: ${added.__error}` };

    const tree = await plumb(['write-tree']);
    if (!tree || tree.__error) return { ok: false, error: `Could not record the files: ${tree?.__error ?? 'no tree written'}` };

    const message = `wip: dashboard backup of ${checkout.name}\n\n`
      + 'Snapshot of uncommitted work so it exists somewhere other than one disk.\n'
      + 'Taken automatically by the dev dashboard; not reviewed, not meant to merge as-is.\n';
    const commit = await plumb(['commit-tree', tree, '-p', head, '-m', message]);
    if (!commit || commit.__error) return { ok: false, error: `Could not create the backup commit: ${commit?.__error ?? 'none written'}` };

    // `branch <name> <sha>` creates a ref without checking anything out.
    const branched = await plumb(['branch', branch, commit]);
    if (branched?.__error) return { ok: false, error: `Could not create the branch ${branch}: ${branched.__error}` };

    const pushed = await plumb(['push', 'origin', `${branch}:${branch}`], 180000);
    const pushOk = !pushed?.__error;

    return {
      ok: true,
      branch,
      sha: commit.slice(0, 8),
      pushed: pushOk,
      filesBackedUp: fileCount,
      note: pushOk
        ? `Saved ${fileCount} file(s) as the branch ${branch} and pushed it to GitHub. Your files are untouched and still sitting in the folder.`
        : `Saved ${fileCount} file(s) locally as the branch ${branch}, but the push to GitHub failed: ${pushed.__error}. The copy exists on this disk only.`,
    };
  } finally {
    await fs.rm(tmpIndex, { force: true }).catch(() => {});
  }
}

