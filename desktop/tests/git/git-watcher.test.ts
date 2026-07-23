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
    // Guard: the error-handler teardown (root deleted while still watched)
    // may have already closed and removed this root's entry — tolerate that.
    try { closeAllGitWatchers(); } catch { /* already torn down */ }
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

  it('survives the watched root being deleted without unwatching first', async () => {
    // NOTE: on Linux, deleting a watched directory does not reliably make
    // fs.watch emit 'error' — inotify just stops delivering useful events
    // (verified empirically: rm -rf on a watched dir produced only 'rename'
    // change events, never 'error' or 'close'). The platforms/conditions the
    // review finding is guarding against (Windows, network filesystems,
    // inotify queue overflow) DO emit 'error' on the FSWatcher. To exercise
    // our handler deterministically regardless of platform, we spy on
    // fs.watch to capture the real FSWatcher instances it creates, then
    // manually fire 'error' on one of them after the real deletion — this
    // simulates exactly what those platforms do without depending on OS-
    // specific watch semantics.
    const watchSpy = vi.spyOn(fs, 'watch');
    expect(watchGit(root, 1).ok).toBe(true);
    const watchers = watchSpy.mock.results.map((r) => r.value as fs.FSWatcher);
    expect(watchers.length).toBeGreaterThan(0);

    // Simulate `git worktree remove` / external surgery: the root (and its
    // .git dir) disappears while we're still subscribed, with no unwatchGit
    // call first.
    await fs.promises.rm(root, { recursive: true, force: true });

    // This used to throw an uncaught exception (no 'error' listener on an
    // EventEmitter) and crash the Electron main process.
    expect(() => watchers[0].emit('error', new Error('simulated ENOENT'))).not.toThrow();
    await wait(200);

    // Confirm the entry actually self-healed: a fresh subscribe on the now-
    // missing root goes back through the existsSync check and reports
    // {ok:false}, rather than reusing a stale map entry.
    expect(watchGit(root, 9).ok).toBe(false);
    watchSpy.mockRestore();
  });

  it('same subscriber watching the same root twice needs two unwatches before events stop', async () => {
    expect(watchGit(root, 1).ok).toBe(true);
    expect(watchGit(root, 1).ok).toBe(true); // refcount for subscriber 1 is now 2
    unwatchGit(root, 1); // refcount 2 -> 1, entry must still be alive
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x1');
    await wait(500);
    expect(events.length).toBe(1);

    unwatchGit(root, 1); // refcount 1 -> 0, last subscriber gone, entry closes
    events = [];
    await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x2');
    await wait(500);
    expect(events).toEqual([]);
  });

  it('dropGitSubscriber releases multiple roots held by one subscriber at once', async () => {
    const root2 = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ycd-git-watch2-'));
    await fs.promises.mkdir(path.join(root2, '.git', 'refs', 'heads'), { recursive: true });
    await fs.promises.writeFile(path.join(root2, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    try {
      expect(watchGit(root, 5).ok).toBe(true);
      expect(watchGit(root2, 5).ok).toBe(true);
      dropGitSubscriber(5);
      await fs.promises.writeFile(path.join(root, '.git', 'index'), 'x');
      await fs.promises.writeFile(path.join(root2, '.git', 'index'), 'x');
      await wait(500);
      expect(events).toEqual([]);
    } finally {
      await fs.promises.rm(root2, { recursive: true, force: true });
    }
  });
});
