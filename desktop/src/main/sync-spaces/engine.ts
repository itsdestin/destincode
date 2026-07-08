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
}

const WATCH_IGNORED = [/(^|[\\/])\.youcoded([\\/]|$)/, /(^|[\\/])node_modules([\\/]|$)/, /(^|[\\/])\.git([\\/]|$)/];

export class SpaceSyncEngine {
  private states = new Map<string, SpaceState>();
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
    const st: SpaceState = { space, watcher, debounce: null, syncing: false, rerun: false };
    watcher.on('all', () => this.schedule(st));
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
    if (st.syncing) { st.rerun = true; return; }
    st.syncing = true;
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
      if (st.rerun) { st.rerun = false; void this.syncSpace(space); }
    }
  }

  async stop(): Promise<void> {
    if (this.pollTimer) clearInterval(this.pollTimer);
    for (const st of this.states.values()) {
      if (st.debounce) clearTimeout(st.debounce);
      await st.watcher.close();
    }
    this.states.clear();
  }
}
