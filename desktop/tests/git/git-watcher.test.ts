import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  initGitWatchers, watchGit, unwatchGit, dropGitSubscriber, closeAllGitWatchers,
} from '../../src/main/git/git-watcher';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('git-watcher', () => {
  let root: string;
  let events: Array<{ repoRoot: string }>;
  beforeEach(async () => {
    root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-watch-'));
    await fs.promises.mkdir(path.join(root, '.git', 'refs', 'heads'), { recursive: true });
    await fs.promises.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    events = [];
    initGitWatchers((e) => events.push(e));
  });
  afterEach(async () => {
    closeAllGitWatchers();
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  it('refuses a root without .git', async () => {
    const bare = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-nogit-'));
    try { expect(watchGit(bare, 1).ok).toBe(false); }
    finally { await fs.promises.rm(bare, { recursive: true, force: true }); }
  });

  it('emits one debounced event for a burst of .git changes', async () => {
    expect(watchGit(root, 1).ok).toBe(true);
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'i1');
    await fs.promises.writeFile(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'i2');
    await wait(700); // debounce is 300ms; fs.watch latency varies by platform
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ repoRoot: root });
  });

  it('stops emitting after the last subscriber unwatches', async () => {
    watchGit(root, 1);
    watchGit(root, 2);
    unwatchGit(root, 1);
    unwatchGit(root, 2);
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x');
    await wait(500);
    expect(events).toEqual([]);
  });

  it('dropGitSubscriber releases every root a renderer held', async () => {
    watchGit(root, 7);
    dropGitSubscriber(7);
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x');
    await wait(500);
    expect(events).toEqual([]);
  });
});
