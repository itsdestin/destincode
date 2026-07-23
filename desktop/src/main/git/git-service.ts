// Git operations for the user's real repo (spec section 3). Every function is
// projectRoot-scoped and answers with plain serializable objects; the IPC
// handlers in ipc-handlers.ts add the known-root gate and broadcasting.
import fs from 'fs';
import path from 'path';
import { shell } from 'electron';
import { execGit, resolveRepoRoot } from './git-exec';
import {
  parsePorcelainV2, parseNumstat, parseLogRecords, parseUnifiedDiff,
  countsFromHunks, synthesizeAddHunk,
} from './porcelain';
import type {
  GitFileStatusResult, GitFileReviewResult, GitCommitFileDiffResult,
  GitOpResult, GitUncommitted, GitFileCounts,
} from '../../shared/git-types';

export const LOG_PAGE = 20;
const MAX_UNTRACKED_BYTES = 1024 * 1024; // beyond this, show as binary-style stub

// %H = sha, %s = subject, %aI = author date ISO; 0x1f/0x1e separators survive
// any subject content (newlines in subjects are impossible for %s).
const LOG_FORMAT = '%H%x1f%s%x1f%aI%x1e';

interface Located {
  repoRoot: string;
  abs: string;
  rel: string; // repo-relative, posix separators
}

function fail<T extends { ok: boolean; error?: string }>(base: Omit<T, 'ok' | 'error'>, error: string): T {
  return { ...(base as object), ok: false, error } as T;
}

function errText(r: { code: number; stderr: string }): string {
  return r.stderr.trim() || `git exited with code ${r.code}`;
}

async function locate(projectRoot: string, relPath: string): Promise<Located | 'outside' | null> {
  const abs = path.resolve(projectRoot, relPath);
  const inProject = path.relative(projectRoot, abs);
  // Defense in depth under the IPC known-root gate: an artifact path may never
  // escape its project root.
  if (inProject.startsWith('..') || path.isAbsolute(inProject)) return 'outside';
  const repoRoot = await resolveRepoRoot(projectRoot);
  if (!repoRoot) return null;
  const rel = path.relative(repoRoot, abs).split(path.sep).join('/');
  return { repoRoot, abs, rel };
}

const NOT_REPO: Omit<GitFileStatusResult, 'ok' | 'error'> = {
  isRepo: false, branch: null, counts: null, hasHistory: false, staged: false,
};

// Counts for a file HEAD has no copy of (untracked / staged-new / unborn
// HEAD): its whole content is the addition. Oversized or unreadable -> 0/0.
async function worktreeAddCounts(abs: string): Promise<GitFileCounts> {
  try {
    const stat = await fs.promises.stat(abs);
    if (stat.size > MAX_UNTRACKED_BYTES) return { added: 0, removed: 0 };
    return countsFromHunks([synthesizeAddHunk(await fs.promises.readFile(abs, 'utf8'))]);
  } catch { return { added: 0, removed: 0 }; }
}

export async function gitFileStatus(projectRoot: string, relPath: string): Promise<GitFileStatusResult> {
  const loc = await locate(projectRoot, relPath);
  if (loc === 'outside') return { ok: false, error: 'path-outside-project', ...NOT_REPO };
  if (!loc) return { ok: true, ...NOT_REPO };
  const { repoRoot, abs, rel } = loc;

  const status = await execGit(repoRoot, ['status', '--porcelain=v2', '--branch', '--untracked-files=all', '--', rel]);
  if (status.code !== 0) return { ok: false, error: errText(status), ...NOT_REPO };
  const parsed = parsePorcelainV2(status.stdout);
  const entry = parsed.files.find((f) => f.path === rel) ?? null;

  let counts: GitFileStatusResult['counts'] = null;
  if (entry?.untracked) {
    counts = await worktreeAddCounts(abs);
  } else if (entry) {
    const num = await execGit(repoRoot, ['diff', '--numstat', 'HEAD', '--', rel]);
    if (num.code === 0) {
      const m = parseNumstat(num.stdout).get(rel);
      counts = m ? { added: m.added, removed: m.removed } : { added: 0, removed: 0 };
    } else {
      // HEAD may be unborn (fresh git init, nothing committed yet) — the file
      // is effectively all-new, so count its content as additions.
      counts = await worktreeAddCounts(abs);
    }
  }

  // Any commit touching this path? --max-count=1 keeps it O(first hit).
  const hist = await execGit(repoRoot, ['rev-list', '--max-count=1', 'HEAD', '--', rel]);
  const hasHistory = hist.code === 0 && hist.stdout.trim().length > 0;

  return {
    ok: true, isRepo: true, branch: parsed.branch, counts,
    hasHistory, staged: entry?.staged ?? false,
  };
}

export async function gitFileReview(
  projectRoot: string, relPath: string, opts?: { logSkip?: number },
): Promise<GitFileReviewResult> {
  const base: Omit<GitFileReviewResult, 'ok' | 'error'> = {
    isRepo: false, branch: null, uncommitted: null, log: [], hasMore: false, stagedCount: 0,
  };
  const loc = await locate(projectRoot, relPath);
  if (loc === 'outside') return fail<GitFileReviewResult>(base, 'path-outside-project');
  if (!loc) return { ok: true, ...base };
  const { repoRoot, abs, rel } = loc;

  // Whole-repo status: branch + this file's entry + the repo-wide staged count
  // (the commit button label counts everything a commit would include).
  const status = await execGit(repoRoot, ['status', '--porcelain=v2', '--branch', '--untracked-files=all']);
  if (status.code !== 0) return fail<GitFileReviewResult>(base, errText(status));
  const parsed = parsePorcelainV2(status.stdout);
  const entry = parsed.files.find((f) => f.path === rel) ?? null;
  const stagedCount = parsed.files.filter((f) => f.staged).length;

  let uncommitted: GitUncommitted | null = null;
  if (entry) {
    // cat-file -e answers "does HEAD have a copy of this file?" — false for
    // untracked, staged-new AND unborn-HEAD repos, which all render as pure
    // additions (there is nothing to diff against).
    const inHead = !entry.untracked
      && (await execGit(repoRoot, ['cat-file', '-e', `HEAD:${rel}`])).code === 0;
    if (!inHead) {
      let hunks = [] as GitUncommitted['hunks'];
      let binary = false;
      try {
        const stat = await fs.promises.stat(abs);
        if (stat.size <= MAX_UNTRACKED_BYTES) hunks = [synthesizeAddHunk(await fs.promises.readFile(abs, 'utf8'))];
        else binary = true;
      } catch { binary = true; }
      uncommitted = { hunks, counts: countsFromHunks(hunks), staged: entry.staged, untracked: entry.untracked, inHead: false, binary };
    } else {
      const diff = await execGit(repoRoot, ['diff', 'HEAD', '--', rel]);
      if (diff.code !== 0) return fail<GitFileReviewResult>(base, errText(diff));
      const { hunks, binary } = parseUnifiedDiff(diff.stdout);
      uncommitted = { hunks, counts: countsFromHunks(hunks), staged: entry.staged, untracked: false, inHead: true, binary };
    }
  }

  const skip = opts?.logSkip ?? 0;
  // Ask for one extra record purely to learn whether a next page exists.
  const log = await execGit(repoRoot, [
    'log', '--follow', `--max-count=${LOG_PAGE + 1}`, `--skip=${skip}`,
    `--pretty=format:${LOG_FORMAT}`, '--', rel,
  ]);
  // git log exits 0 with empty output for a path with no commits (e.g. untracked)
  const entries = log.code === 0 ? parseLogRecords(log.stdout) : [];
  const hasMore = entries.length > LOG_PAGE;

  return {
    ok: true, isRepo: true, branch: parsed.branch,
    uncommitted, log: entries.slice(0, LOG_PAGE), hasMore, stagedCount,
  };
}

export async function gitCommitFileDiff(
  projectRoot: string, sha: string, relPath: string,
): Promise<GitCommitFileDiffResult> {
  const loc = await locate(projectRoot, relPath);
  // 'outside' (path escaped the project root) and null (no repo found here) are
  // distinct, real states — collapsing them into one error would misreport a
  // plain non-repo dir as a path-safety violation.
  if (loc === 'outside') return { ok: false, error: 'path-outside-project', hunks: [], binary: false };
  if (!loc) return { ok: false, error: 'not-a-git-repository', hunks: [], binary: false };
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) return { ok: false, error: 'invalid-sha', hunks: [], binary: false };
  // --format= suppresses the commit header so output is pure diff.
  const r = await execGit(loc.repoRoot, ['show', sha, '--format=', '--', loc.rel]);
  if (r.code !== 0) return { ok: false, error: errText(r), hunks: [], binary: false };
  const { hunks, binary } = parseUnifiedDiff(r.stdout);
  // Empty hunks is a real state (merge commit / rename-only) — the card body
  // renders the "no direct changes" line, not an error.
  return { ok: true, hunks, binary };
}

async function simpleOp(projectRoot: string, relPath: string, args: (rel: string) => string[]): Promise<GitOpResult> {
  const loc = await locate(projectRoot, relPath);
  // 'outside' (path escaped the project root) and null (no repo found here) are
  // distinct, real states — collapsing them into one error would misreport a
  // plain non-repo dir as a path-safety violation.
  if (loc === 'outside') return { ok: false, error: 'path-outside-project' };
  if (!loc) return { ok: false, error: 'not-a-git-repository' };
  const r = await execGit(loc.repoRoot, args(loc.rel));
  return r.code === 0 ? { ok: true } : { ok: false, error: errText(r) };
}

export function gitStage(projectRoot: string, relPath: string): Promise<GitOpResult> {
  return simpleOp(projectRoot, relPath, (rel) => ['add', '--', rel]);
}

export async function gitUnstage(projectRoot: string, relPath: string): Promise<GitOpResult> {
  const first = await simpleOp(projectRoot, relPath, (rel) => ['restore', '--staged', '--', rel]);
  if (first.ok) return first;
  // Unborn HEAD (repo with no commits): restore --staged cannot resolve HEAD.
  // The equivalent unstage there is rm --cached, which leaves the worktree
  // file untouched. Only fall back when HEAD verifiably does not resolve —
  // any other failure keeps its real stderr.
  const loc = await locate(projectRoot, relPath);
  if (loc && loc !== 'outside') {
    const head = await execGit(loc.repoRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    if (head.code !== 0) {
      const rm = await execGit(loc.repoRoot, ['rm', '--cached', '--force', '--', loc.rel]);
      if (rm.code === 0) return { ok: true };
    }
  }
  return first;
}

export async function gitCommit(projectRoot: string, message: string): Promise<GitOpResult> {
  if (!message.trim()) return { ok: false, error: 'empty-commit-message' };
  const repoRoot = await resolveRepoRoot(projectRoot);
  if (!repoRoot) return { ok: false, error: 'not-a-git-repository' };
  const r = await execGit(repoRoot, ['commit', '-m', message]);
  return r.code === 0 ? { ok: true } : { ok: false, error: r.stderr.trim() || r.stdout.trim() || `git exited with code ${r.code}` };
}

export async function gitDiscard(projectRoot: string, relPath: string): Promise<GitOpResult> {
  const loc = await locate(projectRoot, relPath);
  // 'outside' (path escaped the project root) and null (no repo found here) are
  // distinct, real states — collapsing them into one error would misreport a
  // plain non-repo dir as a path-safety violation.
  if (loc === 'outside') return { ok: false, error: 'path-outside-project' };
  if (!loc) return { ok: false, error: 'not-a-git-repository' };
  const status = await execGit(loc.repoRoot, ['status', '--porcelain=v2', '--untracked-files=all', '--', loc.rel]);
  if (status.code !== 0) return { ok: false, error: errText(status) };
  const entry = parsePorcelainV2(status.stdout).files.find((f) => f.path === loc.rel);
  if (!entry) return { ok: true }; // nothing to discard — already clean
  const trash = async (): Promise<GitOpResult> => {
    // Recoverable OS-trash delete, never `git clean` (spec section 5).
    try { await shell.trashItem(loc.abs); return { ok: true }; }
    catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
  };
  if (entry.untracked) return trash();
  const inHead = (await execGit(loc.repoRoot, ['cat-file', '-e', `HEAD:${loc.rel}`])).code === 0;
  if (!inHead) {
    // Staged-new (or unborn HEAD): there is no committed copy to restore, and
    // `checkout HEAD` would fail with a pathspec error. Unstage with
    // rm --cached (works before the first commit too), then trash.
    const rm = await execGit(loc.repoRoot, ['rm', '--cached', '--force', '--', loc.rel]);
    if (rm.code !== 0) return { ok: false, error: errText(rm) };
    return trash();
  }
  // Tracked with a HEAD copy: restore BOTH index and worktree copy to HEAD.
  const r = await execGit(loc.repoRoot, ['checkout', 'HEAD', '--', loc.rel]);
  return r.code === 0 ? { ok: true } : { ok: false, error: errText(r) };
}
