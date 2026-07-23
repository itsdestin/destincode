import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execGit, resolveRepoRoot, invalidateRepoRootCache } from '../../src/main/git/git-exec';

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

describe.skipIf(!hasGit())('git-exec (integration, real git)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-exec-'));
    invalidateRepoRootCache();
  });
  afterEach(async () => {
    await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('execGit returns code 0 + stdout on success', async () => {
    const r = await execGit(dir, ['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('git version');
  });

  it('execGit returns nonzero code + real stderr on failure', async () => {
    const r = await execGit(dir, ['rev-parse', '--show-toplevel']);
    expect(r.code).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain('not a git repository');
  });

  it('resolveRepoRoot finds the toplevel from a subdirectory and caches', async () => {
    await execGit(dir, ['init']);
    const sub = path.join(dir, 'a', 'b');
    await fs.promises.mkdir(sub, { recursive: true });
    const root = await resolveRepoRoot(sub);
    expect(root && (await fs.promises.realpath(root))).toBe(await fs.promises.realpath(dir));
    // cached: second call resolves identically without re-shelling (same value)
    expect(await resolveRepoRoot(sub)).toBe(root);
  });

  it('resolveRepoRoot returns null outside any repo', async () => {
    expect(await resolveRepoRoot(dir)).toBeNull();
  });

  it('strips inherited GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE so calls stay targeted at cwd', async () => {
    // An app launched from a shell/hook that exports these would otherwise
    // have every git call below silently retarget at whatever repo/index
    // those env vars point to, instead of the `dir` this runner was given.
    const other = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-exec-other-'));
    try {
      await execGit(other, ['init']);
      const prevGitDir = process.env.GIT_DIR;
      const prevGitWorkTree = process.env.GIT_WORK_TREE;
      process.env.GIT_DIR = path.join(other, '.git');
      process.env.GIT_WORK_TREE = other;
      try {
        await execGit(dir, ['init']);
        // If GIT_DIR/GIT_WORK_TREE had leaked through, this would report
        // `other` as the toplevel instead of `dir`.
        const r = await execGit(dir, ['rev-parse', '--show-toplevel']);
        expect(r.code).toBe(0);
        expect(await fs.promises.realpath(r.stdout.trim())).toBe(await fs.promises.realpath(dir));
      } finally {
        if (prevGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prevGitDir;
        if (prevGitWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = prevGitWorkTree;
      }
    } finally {
      await fs.promises.rm(other, { recursive: true, force: true });
    }
  });
});
