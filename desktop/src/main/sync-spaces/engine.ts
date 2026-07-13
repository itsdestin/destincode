// desktop/src/main/sync-spaces/engine.ts
// Watch → debounce → sync (pull-then-push) per space, plus a poll loop that
// stands in for SyncHub signals until Plan 1b. Single-flight per space: a
// change arriving mid-sync queues exactly one follow-up sync.
import path from 'path';
import chokidar, { FSWatcher } from 'chokidar';
import type { SpaceSyncEvent, SyncSpace, SyncTransport } from './types';

interface EngineOpts {
  debounceMs?: number;  // default 15s (spec §8)
  pollMs?: number;      // default 120s (spec §6 degradation path); 0 disables
  onEvent: (e: SpaceSyncEvent) => void;
}

interface SpaceState {
  space: SyncSpace;
  watcher: FSWatcher;
  debounce: ReturnType<typeof setTimeout> | null;
  syncing: boolean;
  rerun: boolean;
  // The in-flight sync's promise, so stop() can await it. Without this, quit
  // teardown (and tests' temp-dir cleanup) races the git subprocesses a sync
  // spawns — on Windows their cwd/file handles block directory removal.
  current: Promise<void> | null;
}

// Coarse watcher-level filter only — intentionally narrower than the git layer's
// DEFAULT_IGNORES, which stays authoritative about what actually syncs. Each
// regex means: "this directory name appears anywhere in the path, with either
// slash style" (Windows \ or POSIX /).
const WATCH_IGNORED = [/(^|[\\/])\.youcoded([\\/]|$)/, /(^|[\\/])node_modules([\\/]|$)/, /(^|[\\/])\.git([\\/]|$)/];

export class SpaceSyncEngine {
  private states = new Map<string, SpaceState>();
  // Set once in stop(): a latch so an addSpace() suspended on its `await ready`
  // while the engine is torn down closes its watcher instead of inserting it
  // into the now-cleared states map — a watcher nothing would ever close, which
  // keeps syncing after the user turned sync off (until restart). Engines are
  // single-use, so the latch never needs resetting. (Review #3.)
  private stopped = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private debounceMs: number;
  private pollMs: number;
  private onEvent: (e: SpaceSyncEvent) => void;

  constructor(private transport: SyncTransport, opts: EngineOpts) {
    this.debounceMs = opts.debounceMs ?? 15_000;
    this.pollMs = opts.pollMs ?? 120_000;
    this.onEvent = opts.onEvent;
    if (this.pollMs > 0) {
      this.pollTimer = setInterval(() => {
        for (const st of this.states.values()) void this.syncSpace(st.space);
      }, this.pollMs);
      // Don't keep the process alive for polling alone.
      (this.pollTimer as any).unref?.();
    }
  }

  async addSpace(space: SyncSpace): Promise<void> {
    if (this.states.has(space.id)) return;
    await this.transport.init(space);
    const watcher = chokidar.watch(space.root, {
      ignored: WATCH_IGNORED,
      ignoreInitial: true,
      followSymlinks: false,       // spec §8: symlinks are not synced
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
    });
    // Wait for chokidar's initial scan to complete before returning. With
    // ignoreInitial:true, any file written *before* 'ready' is treated as a
    // pre-existing file and silently NOT emitted — so callers that write right
    // after addSpace() (and the engine tests) would never trigger a sync. The
    // 'error' path resolves too so a watch failure can't hang startup.
    await new Promise<void>(resolve => {
      watcher.once('ready', () => resolve());
      watcher.once('error', () => resolve());
    });
    // Torn down while we awaited 'ready' (disable landed mid-add): close this
    // watcher and DON'T register it — stop() already snapshotted the states map,
    // so a set() here would strand a live watcher forever (review #3).
    if (this.stopped) { await watcher.close(); return; }
    const st: SpaceState = { space, watcher, debounce: null, syncing: false, rerun: false, current: null };
    watcher.on('all', () => this.schedule(st));
    // A watcher that dies after startup (inotify exhaustion, permissions) must
    // surface as a sync error, not crash the app — an unhandled 'error' on a
    // Node EventEmitter throws. 'all' does NOT receive error events.
    watcher.on('error', (e: any) => this.onEvent({ type: 'error', spaceId: space.id, message: String(e?.message ?? e) }));
    this.states.set(space.id, st);
  }

  private schedule(st: SpaceState): void {
    if (st.debounce) clearTimeout(st.debounce);
    st.debounce = setTimeout(() => { st.debounce = null; void this.syncSpace(st.space); }, this.debounceMs);
  }

  /** Pull first (reduces non-fast-forward pushes), then push. Never throws. */
  async syncSpace(space: SyncSpace): Promise<void> {
    const st = this.states.get(space.id);
    if (!st) return;
    // Single-flight: if a sync is already running, flag exactly ONE follow-up
    // rerun (the finally block below fires it) — extra requests coalesce.
    if (st.syncing) { st.rerun = true; return; }
    st.syncing = true;
    // Keep the whole pull+push chain as a promise on the state so stop() can
    // await an in-flight sync instead of resolving with git still running.
    st.current = (async () => {
      try {
        const pull = await this.transport.pull(space);
        if (pull.conflictCopies.length) this.onEvent({ type: 'conflict', spaceId: space.id, copies: pull.conflictCopies });
        const push = await this.transport.push(space, `sync from ${space.id}`);
        if (push.oversize.length) this.onEvent({ type: 'oversize', spaceId: space.id, files: push.oversize });
        this.onEvent({ type: 'synced', spaceId: space.id, pushed: push.pushed, updated: pull.updated });
      } catch (e: any) {
        this.onEvent({ type: 'error', spaceId: space.id, message: String(e?.message ?? e) });
      } finally {
        st.syncing = false;
        st.current = null;
        if (st.rerun) { st.rerun = false; void this.syncSpace(space); }
      }
    })();
    await st.current;
  }

  /** Ids of the spaces this engine currently watches. Used by the service's
   *  reconcile to decide which stopped projects have a live space to detach. */
  liveSpaceIds(): string[] {
    return [...this.states.keys()];
  }

  /** Detach ONE space (Stop-syncing) without touching the folder or the others.
   *  Delete from the map FIRST so a finishing sync's queued rerun early-returns
   *  in syncSpace (same ordering as stop()); then close the watcher and await any
   *  in-flight sync (its git subprocesses hold handles in the space root — on
   *  Windows that blocks folder use until they exit). */
  async removeSpace(id: string): Promise<void> {
    const st = this.states.get(id);
    if (!st) return;
    this.states.delete(id);
    if (st.debounce) clearTimeout(st.debounce);
    await st.watcher.close();
    if (st.current) await st.current.catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopped = true; // latch: a concurrent addSpace bails after its ready await (review #3)
    if (this.pollTimer) clearInterval(this.pollTimer);
    // Snapshot then clear FIRST: a finishing sync's queued rerun re-enters
    // syncSpace, which early-returns once the state map is empty — otherwise
    // stop() could leave a fresh git chain running after it resolves.
    const states = [...this.states.values()];
    this.states.clear();
    for (const st of states) {
      if (st.debounce) clearTimeout(st.debounce);
      await st.watcher.close();
      // Await the in-flight sync: its git subprocesses hold handles inside the
      // space root, which blocks folder removal on Windows (app quit, tests).
      if (st.current) await st.current.catch(() => {});
    }
  }
}
