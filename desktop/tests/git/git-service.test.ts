import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { shell } from 'electron'; // vitest alias -> tests/__mocks__/electron.ts
import {
  gitFileStatus, gitFileReview, gitCommitFileDiff,
  gitStage, gitUnstage, gitCommit, gitDiscard, LOG_PAGE,
} from '../../src/main/git/git-service';
import { invalidateRepoRootCache } from '../../src/main/git/git-exec';

function hasGit(): boolean {
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; }
}
function sh(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@t.t',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@t.t',
    },
  });
}

describe.skipIf(!hasGit())('git-service (integration, real git)', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-svc-'));
    invalidateRepoRootCache();
    sh(root, ['init', '-b', 'main']);
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
    sh(root, ['add', '.']);
    sh(root, ['commit', '-m', 'initial']);
  });
  afterEach(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('fileStatus: clean tracked file -> no counts, hasHistory true', async () => {
    const r = await gitFileStatus(root, 'a.txt');
    expect(r).toMatchObject({ ok: true, isRepo: true, branch: 'main', counts: null, hasHistory: true, staged: false });
  });

  it('fileStatus: modified file -> counts vs HEAD', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'one\nTWO\nthree\n');
    const r = await gitFileStatus(root, 'a.txt');
    expect(r.counts).toEqual({ added: 2, removed: 1 });
  });

  it('fileStatus: non-repo dir -> isRepo false, ok true', async () => {
    const bare = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-norepo-'));
    try {
      const r = await gitFileStatus(bare, 'x.txt');
      expect(r).toMatchObject({ ok: true, isRepo: false, counts: null, hasHistory: false });
    } finally { await fs.promises.rm(bare, { recursive: true, force: true }); }
  });

  it('fileStatus: escaping relPath is refused', async () => {
    const r = await gitFileStatus(root, '../outside.txt');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path-outside-project');
  });

  it('mutation op in a non-repo dir reports not-a-git-repository, not path-outside-project', async () => {
    const bare = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-norepo-'));
    try {
      const r = await gitStage(bare, 'x.txt');
      expect(r.ok).toBe(false);
      expect(r.error).toBe('not-a-git-repository');
    } finally { await fs.promises.rm(bare, { recursive: true, force: true }); }
  });

  it('mutation op with an escaping relPath still reports path-outside-project', async () => {
    const r = await gitStage(root, '../outside.txt');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('path-outside-project');
  });

  it('fileReview: modified file -> uncommitted hunks + log + stagedCount', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'one\nTWO\n');
    const r = await gitFileReview(root, 'a.txt');
    expect(r.ok).toBe(true);
    expect(r.uncommitted?.untracked).toBe(false);
    expect(r.uncommitted?.inHead).toBe(true);
    expect(r.uncommitted?.counts).toEqual({ added: 1, removed: 1 });
    expect(r.uncommitted?.hunks[0].lines).toContain('-two');
    expect(r.log).toHaveLength(1);
    expect(r.log[0].subject).toBe('initial');
    expect(r.hasMore).toBe(false);
    expect(r.stagedCount).toBe(0);
  });

  it('fileReview: untracked file -> synthesized all-additions hunk', async () => {
    await fs.promises.writeFile(path.join(root, 'new.txt'), 'alpha\nbeta\n');
    const r = await gitFileReview(root, 'new.txt');
    expect(r.uncommitted?.untracked).toBe(true);
    expect(r.uncommitted?.inHead).toBe(false);
    expect(r.uncommitted?.hunks).toEqual([
      { oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+alpha', '+beta'] },
    ]);
    expect(r.log).toEqual([]);
  });

  it('fileReview: oversize untracked file renders as a binary stub, not synthesized hunks', async () => {
    await fs.promises.writeFile(path.join(root, 'huge.txt'), 'x'.repeat(1024 * 1024 + 1));
    const r = await gitFileReview(root, 'huge.txt');
    expect(r.uncommitted).toMatchObject({ untracked: true, binary: true, hunks: [] });
  });

  it('stage/unstage flip index state and stagedCount', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'changed\n');
    expect((await gitStage(root, 'a.txt')).ok).toBe(true);
    expect((await gitFileStatus(root, 'a.txt')).staged).toBe(true);
    expect((await gitFileReview(root, 'a.txt')).stagedCount).toBe(1);
    expect((await gitUnstage(root, 'a.txt')).ok).toBe(true);
    expect((await gitFileStatus(root, 'a.txt')).staged).toBe(false);
  });

  it('commit commits the index and clears the uncommitted card', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'committed\n');
    await gitStage(root, 'a.txt');
    const c = await gitCommit(root, 'test: from the drawer');
    expect(c.ok).toBe(true);
    const r = await gitFileReview(root, 'a.txt');
    expect(r.uncommitted).toBeNull();
    expect(r.log[0].subject).toBe('test: from the drawer');
  });

  it('commit with empty index fails with real git stderr', async () => {
    const c = await gitCommit(root, 'nothing to commit');
    expect(c.ok).toBe(false);
    expect(c.error!.length).toBeGreaterThan(0); // git's own message, passed through
  });

  it('commitFileDiff returns the hunks of a past commit for the file', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
    sh(root, ['add', '.']); sh(root, ['commit', '-m', 'add three']);
    const sha = sh(root, ['rev-parse', 'HEAD']).trim();
    const d = await gitCommitFileDiff(root, sha, 'a.txt');
    expect(d.ok).toBe(true);
    expect(d.hunks[0].lines).toContain('+three');
  });

  it('commitFileDiff rejects a malformed sha before touching git', async () => {
    const d = await gitCommitFileDiff(root, 'not-a-sha!', 'a.txt');
    expect(d).toMatchObject({ ok: false, error: 'invalid-sha' });
  });

  it('discard tracked restores HEAD content', async () => {
    await fs.promises.writeFile(path.join(root, 'a.txt'), 'garbage\n');
    expect((await gitDiscard(root, 'a.txt')).ok).toBe(true);
    expect(await fs.promises.readFile(path.join(root, 'a.txt'), 'utf8')).toBe('one\ntwo\n');
  });

  it('discard untracked goes through shell.trashItem, never git clean', async () => {
    const p = path.join(root, 'junk.txt');
    await fs.promises.writeFile(p, 'x\n');
    expect((await gitDiscard(root, 'junk.txt')).ok).toBe(true);
    expect(shell.trashItem).toHaveBeenCalledWith(p);
  });

  it('discard of a staged-but-never-committed file unstages then trashes', async () => {
    const p = path.join(root, 'staged-new.txt');
    await fs.promises.writeFile(p, 'x\n');
    sh(root, ['add', 'staged-new.txt']);
    expect((await gitDiscard(root, 'staged-new.txt')).ok).toBe(true);
    expect(shell.trashItem).toHaveBeenCalledWith(p);
    // Index no longer holds it (the mocked trash leaves the file on disk, so
    // git now sees it as plain untracked — proving rm --cached ran).
    expect(sh(root, ['status', '--porcelain']).trim()).toBe('?? staged-new.txt');
  });

  it('fileStatus sees an untracked file inside an untracked directory', async () => {
    await fs.promises.mkdir(path.join(root, 'newdir'));
    await fs.promises.writeFile(path.join(root, 'newdir', 'inner.txt'), 'a\nb\n');
    const r = await gitFileStatus(root, 'newdir/inner.txt');
    expect(r.counts).toEqual({ added: 2, removed: 0 });
  });

  it('fileReview works in a repo with no commits yet (unborn HEAD)', async () => {
    const fresh = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-unborn-'));
    try {
      sh(fresh, ['init']);
      await fs.promises.writeFile(path.join(fresh, 'f.txt'), 'hello\n');
      sh(fresh, ['add', 'f.txt']);
      const r = await gitFileReview(fresh, 'f.txt');
      expect(r.ok).toBe(true);
      expect(r.uncommitted?.inHead).toBe(false);
      expect(r.uncommitted?.hunks[0].lines).toEqual(['+hello']);
      expect(r.log).toEqual([]);
    } finally { await fs.promises.rm(fresh, { recursive: true, force: true }); }
  });

  it('discard on unborn HEAD unstages (rm --cached) then trashes, leaving the file untracked', async () => {
    const fresh = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-unborn-'));
    try {
      sh(fresh, ['init']);
      await fs.promises.writeFile(path.join(fresh, 'f.txt'), 'hello\n');
      sh(fresh, ['add', 'f.txt']);
      const r = await gitDiscard(fresh, 'f.txt');
      expect(r.ok).toBe(true);
      expect(shell.trashItem).toHaveBeenCalledWith(path.join(fresh, 'f.txt'));
      // The mocked trash leaves the file on disk, so git now sees it as plain
      // untracked — proving rm --cached ran against the unresolvable HEAD.
      expect(sh(fresh, ['status', '--porcelain']).trim()).toBe('?? f.txt');
    } finally { await fs.promises.rm(fresh, { recursive: true, force: true }); }
  });

  it('unstage on unborn HEAD falls back to rm --cached, leaving the file untracked', async () => {
    const fresh = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-unborn-'));
    try {
      sh(fresh, ['init']);
      await fs.promises.writeFile(path.join(fresh, 'f.txt'), 'hello\n');
      sh(fresh, ['add', 'f.txt']);
      const r = await gitUnstage(fresh, 'f.txt');
      expect(r.ok).toBe(true);
      expect(sh(fresh, ['status', '--porcelain']).trim()).toBe('?? f.txt');
    } finally { await fs.promises.rm(fresh, { recursive: true, force: true }); }
  });

  it('LOG_PAGE caps the log and reports hasMore', async () => {
    for (let i = 0; i < LOG_PAGE + 2; i++) {
      await fs.promises.writeFile(path.join(root, 'a.txt'), `rev ${i}\n`);
      sh(root, ['add', '.']); sh(root, ['commit', '-m', `rev ${i}`]);
    }
    const r = await gitFileReview(root, 'a.txt');
    expect(r.log).toHaveLength(LOG_PAGE);
    expect(r.hasMore).toBe(true);
    const page2 = await gitFileReview(root, 'a.txt', { logSkip: LOG_PAGE });
    expect(page2.log.length).toBeGreaterThan(0);
  });
});
