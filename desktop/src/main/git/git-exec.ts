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
    const { stdout, stderr } = await execFileP('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      // Never let git prompt — a hung credential prompt would wedge the handler.
      // MVP operations are all local, so no credentials are ever needed.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
