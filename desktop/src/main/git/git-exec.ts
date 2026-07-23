// Thin runner for the user's real repo. Deliberately NOT GitTransport
// (sync-spaces/git-transport.ts): that class pins GIT_DIR to the hidden
// .youcoded/sync.git and must never touch the user's own .git. Here we run
// plain `git` with cwd only — the repo is whatever the user's project is.
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 16 * 1024 * 1024; // large diffs; UnifiedDiff paginates client-side

export interface GitExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function execGit(cwd: string, args: string[]): Promise<GitExecResult> {
  try {
    // WHY: an app launched from a shell/hook that exports GIT_DIR, GIT_WORK_TREE
    // or GIT_INDEX_FILE would have every git call below silently retarget at
    // whatever repo/index those point to, instead of `cwd`. Strip them so this
    // runner always operates on the repo it was actually asked about.
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    const { stdout, stderr } = await execFileP('git', [
      // WHY: with the default core.quotepath=true, git C-quotes any filename
      // with non-ASCII bytes in porcelain/numstat/log output (e.g. "café.md"
      // becomes "caf\303\251.md"). That never matches the plain `rel` string
      // this service compares paths against, so accented filenames silently
      // fall out of status/diff/stage matching. Force it off on every call.
      '-c', 'core.quotepath=false',
      ...args,
    ], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      // Never let git prompt — a hung credential prompt would wedge the handler.
      // MVP operations are all local, so no credentials are ever needed.
      env,
    });
    return { code: 0, stdout: String(stdout), stderr: String(stderr) };
  } catch (err: unknown) {
    const e = err as { code?: number | string; stdout?: string; stderr?: string; message?: string };
    if (typeof e.code === 'number') {
      // git ran and exited nonzero — pass its real stderr through untouched
      return { code: e.code, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
    // spawn failure (git not installed, ENOENT) or timeout kill
    return { code: -1, stdout: '', stderr: e.stderr || e.message || String(err) };
  }
}

// dir -> repo toplevel (or null). Cached: the footer asks on every artifact
// switch and status refresh; rev-parse per keystroke would be wasteful.
// Invalidated wholesale on git:changed (Task 5) — repos appear/vanish rarely.
const rootCache = new Map<string, string | null>();

export async function resolveRepoRoot(dir: string): Promise<string | null> {
  const hit = rootCache.get(dir);
  if (hit !== undefined) return hit;
  const r = await execGit(dir, ['rev-parse', '--show-toplevel']);
  const root = r.code === 0 ? r.stdout.trim() : null;
  rootCache.set(dir, root);
  return root;
}

export function invalidateRepoRootCache(): void {
  rootCache.clear();
}
