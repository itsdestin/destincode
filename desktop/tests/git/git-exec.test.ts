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
});
