import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, listCheckouts } from '../dev-dashboard/checkouts.mjs';

describe('classify', () => {
  it('calls uncommitted files unsaved even when nothing is ahead', () => {
    // The bug this replaces: context-inject.sh reads ahead===0 as "candidate for
    // cleanup" before looking at the dirty count, so the site-themes worktree —
    // 40 uncommitted files, 0 commits, no remote — was labelled safe to delete.
    expect(classify({ dirty: 40, ahead: 0, pushed: false, merged: false })).toBe('unsaved');
  });

  it('calls uncommitted files unsaved even on a fully merged branch', () => {
    expect(classify({ dirty: 1, ahead: 0, pushed: true, merged: true })).toBe('unsaved');
  });

  it('calls clean unpushed commits unpushed', () => {
    expect(classify({ dirty: 0, ahead: 2, pushed: false, merged: false })).toBe('unpushed');
  });

  it('calls pushed-but-unmerged work pushed', () => {
    expect(classify({ dirty: 0, ahead: 2, pushed: true, merged: false })).toBe('pushed');
  });

  it('calls merged clean work safe', () => {
    expect(classify({ dirty: 0, ahead: 0, pushed: true, merged: true })).toBe('safe');
  });

  it('calls an empty clean worktree safe', () => {
    expect(classify({ dirty: 0, ahead: 0, pushed: false, merged: false })).toBe('safe');
  });
});

describe('listCheckouts against a real repo', () => {
  let root: string;
  let repo: string;

  const g = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe' }).toString().trim();

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-'));
    const origin = path.join(root, 'origin.git');
    repo = path.join(root, 'repo');
    execFileSync('git', ['init', '--bare', '-b', 'master', origin], { stdio: 'pipe' });
    execFileSync('git', ['clone', origin, repo], { stdio: 'pipe' });
    g(repo, 'config', 'user.email', 't@t.t');
    g(repo, 'config', 'user.name', 'T');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    g(repo, 'add', 'a.txt');
    g(repo, 'commit', '-m', 'base');
    g(repo, 'push', 'origin', 'master');

    // unsaved: a branch with NO commits and one uncommitted file. This is the
    // exact shape that got mislabelled "candidate for cleanup" on 2026-09-01.
    const wtUnsaved = path.join(root, 'wt-unsaved');
    g(repo, 'worktree', 'add', '-b', 'only-copy', wtUnsaved, 'master');
    fs.writeFileSync(path.join(wtUnsaved, 'scratch.txt'), 'the only copy\n');

    // unpushed: one local commit, never pushed, clean.
    const wtUnpushed = path.join(root, 'wt-unpushed');
    g(repo, 'worktree', 'add', '-b', 'local-only', wtUnpushed, 'master');
    fs.writeFileSync(path.join(wtUnpushed, 'b.txt'), 'two\n');
    g(wtUnpushed, 'add', 'b.txt');
    g(wtUnpushed, 'commit', '-m', 'local');

    // safe: a branch at master, clean, nothing ahead.
    g(repo, 'worktree', 'add', '-b', 'done', path.join(root, 'wt-done'), 'master');
  });

  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  it('gives each worktree the right pill', async () => {
    const list = await listCheckouts(repo, { base: 'origin/master' });
    const by = (n: string) => list.find((c: { name: string }) => c.name === n)!;
    expect(by('wt-unsaved').status).toBe('unsaved');
    expect(by('wt-unsaved').dirty).toBe(1);
    expect(by('wt-unpushed').status).toBe('unpushed');
    expect(by('wt-unpushed').ahead).toBe(1);
    expect(by('wt-done').status).toBe('safe');
  });

  it('marks the main checkout, and only it', async () => {
    // git lists the main checkout first. It is never a cleanup candidate —
    // everything else hangs off it — so the page must be able to tell it apart.
    const list = await listCheckouts(repo, { base: 'origin/master' });
    const mains = list.filter((c: { isMain: boolean }) => c.isMain);
    expect(mains).toHaveLength(1);
    expect(mains[0].path).toBe(repo);
  });

  it('gives every checkout a stable id and never leaks a path into it', async () => {
    const list = await listCheckouts(repo, { base: 'origin/master' });
    expect(list.every((c: { id: string }) => /^[a-zA-Z0-9-]+$/.test(c.id))).toBe(true);
  });
});
