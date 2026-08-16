// Pins the pause/resume gate added to conversations/service.ts (2026-08-15
// ordering fix): the startup reconcile + materialize sweeps must NOT run
// while pauseSweeps() is active — any trigger while paused (startup kick,
// periodic tick, a Personal 'synced' event) coalesces into ONE deferred run
// once resumeSweeps() lifts the gate. This is what lets main.ts run the
// one-shot slug repair without racing the sweeps (found on the real-data run
// — see pauseSweeps' WHY comment in service.ts). Mirrors the mocking setup in
// conversations-service.test.ts (same collaborators faked via vi.hoisted).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const h = vi.hoisted(() => {
  return {
    store: {
      upsert: vi.fn(async (_p: any) => ({ id: 'x' })),
      get: vi.fn(async () => null),
      list: vi.fn(async (_provider: string): Promise<any[]> => []),
      setFlag: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      setNote: vi.fn(async () => {}),
      remove: vi.fn(async (_provider: string, _id: string) => true),
      root: vi.fn(() => ''),
    },
    // Unlike conversations-service.test.ts, this file DOES want reconcile to
    // resolve (so a resumed run is observable as "completed"), so it defaults
    // to an immediately-resolving mock rather than the never-resolving one.
    reconcile: vi.fn(async (_opts: any) => 0),
    mirrorIn: vi.fn((_o: any) => ({ copied: true })),
    materializeOut: vi.fn((_o: any) => ({ copied: true })),
    syncSpacesSyncNow: vi.fn(async (_spaceId?: string) => ({ ok: true })),
    syncSpacesSyncNowAwaited: vi.fn(async (_spaceId?: string, _timeoutMs?: number) => {}),
    syncListeners: new Set<(e: any) => void>(),
    managedRoots: null as any,
    savedFolders: [] as Array<{ path: string }>,
  };
});

vi.mock('../src/main/conversations/conversation-store', () => ({
  createConversationStore: (root: string) => {
    h.store.root = vi.fn(() => root);
    return h.store;
  },
}));
vi.mock('../src/main/conversations/transcript-mirror', () => ({
  mirrorIn: (o: any) => h.mirrorIn(o),
  materializeOut: (o: any) => h.materializeOut(o),
}));
vi.mock('../src/main/conversations/reconciler', () => ({
  reconcile: (o: any) => h.reconcile(o),
}));
vi.mock('../src/main/sync-spaces/service', () => ({
  onSyncSpacesEvent: (fn: (e: any) => void) => {
    h.syncListeners.add(fn);
    return () => h.syncListeners.delete(fn);
  },
  syncSpacesSyncNow: (spaceId?: string) => h.syncSpacesSyncNow(spaceId),
  syncSpacesSyncNowAwaited: (spaceId?: string, timeoutMs?: number) => h.syncSpacesSyncNowAwaited(spaceId, timeoutMs),
  getManagedRoots: () => h.managedRoots,
}));
vi.mock('../src/main/saved-folders', () => ({
  readFolders: () => h.savedFolders,
}));

function fireSync(e: any): void {
  for (const fn of h.syncListeners) fn(e);
}

let tmpRoot = '';

describe('conversations service — sweep pause/resume gate', () => {
  beforeEach(() => {
    vi.useRealTimers();
    h.syncListeners.clear();
    h.store.upsert.mockReset().mockResolvedValue({ id: 'x' } as any);
    h.store.get.mockReset().mockResolvedValue(null as any);
    h.store.list.mockReset().mockResolvedValue([]);
    h.store.setFlag.mockReset().mockResolvedValue(undefined as any);
    h.store.setTitle.mockReset().mockResolvedValue(undefined as any);
    h.store.setNote.mockReset().mockResolvedValue(undefined as any);
    h.store.remove.mockReset().mockResolvedValue(true as any);
    h.reconcile.mockReset().mockResolvedValue(0 as any);
    h.mirrorIn.mockReset().mockReturnValue({ copied: true } as any);
    h.materializeOut.mockReset().mockReturnValue({ copied: true } as any);
    h.syncSpacesSyncNow.mockReset().mockResolvedValue({ ok: true } as any);
    h.syncSpacesSyncNowAwaited.mockReset().mockResolvedValue(undefined as any);
    h.savedFolders = [];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-svc-pause-'));
    h.managedRoots = { personalRoot: path.join(tmpRoot, 'Personal'), listProjects: () => [] };
    // Review fix (MINOR): see the identical override in
    // conversations-service.test.ts — without it, heldForkIds() calls in
    // service.ts read the developer's real ~/.youcoded/slug-repair-state.json.
    process.env.YOUCODED_SLUG_REPAIR_STATE = path.join(tmpRoot, 'slug-repair-state.json');
  });

  afterEach(() => {
    vi.useRealTimers();
    delete process.env.YOUCODED_SLUG_REPAIR_STATE;
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const startOpts = (extra?: Record<string, unknown>) => ({
    conversationsRoot: path.join(tmpRoot, 'Conversations'),
    projectsDir: path.join(tmpRoot, 'projects'),
    topicsDir: path.join(tmpRoot, 'topics'),
    device: 'test-device',
    ...extra,
  });

  it('startConversationStore({ pauseSweeps: true }) defers the startup reconcile and materialize; resumeSweeps runs each exactly once', async () => {
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts({ pauseSweeps: true }));
    // Neither startup kick ran while paused.
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.store.list).not.toHaveBeenCalledWith('native');

    svc.resumeSweeps();
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalledWith('native'));
    // Exactly one deferred run each — not one per pending trigger.
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    expect(h.store.list.mock.calls.filter((c) => c[0] === 'native')).toHaveLength(1);

    svc.stopConversationStore();
  });

  it('a trigger while paused is deferred and coalesced: pause, trigger twice, resume — runs once', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    // Start WITHOUT pauseSweeps so the startup kicks fire and settle first —
    // isolates this test to triggers that arrive AFTER startup.
    await svc.startConversationStore(startOpts());
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalledWith('native'));
    h.reconcile.mockClear();
    h.store.list.mockClear();

    svc.pauseSweeps();
    // Two materialize-eligible 'synced' events while paused.
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    // Two periodic-reconcile ticks while paused.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    // Nothing ran yet — everything is pending.
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.store.list).not.toHaveBeenCalledWith('native');

    svc.resumeSweeps();
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalledWith('native'));
    expect(h.reconcile).toHaveBeenCalledTimes(1); // coalesced, not 3 (startup tick excluded + 2 ticks)
    expect(h.store.list.mock.calls.filter((c) => c[0] === 'native')).toHaveLength(1); // coalesced, not 2

    svc.stopConversationStore();
    vi.useRealTimers();
  });

  it('resumeSweeps() with nothing pending is a no-op and resets the flag', async () => {
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    await vi.waitFor(() => expect(h.reconcile).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalledWith('native'));
    h.reconcile.mockClear();
    h.store.list.mockClear();

    // Never paused this test — resuming should do nothing.
    expect(() => svc.resumeSweeps()).not.toThrow();
    await new Promise((r) => setTimeout(r, 10));
    expect(h.reconcile).not.toHaveBeenCalled();
    expect(h.store.list).not.toHaveBeenCalled();

    // The flag really did reset: a trigger AFTER this no-op resume runs
    // immediately rather than staying stuck "paused".
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalledWith('native'));

    svc.stopConversationStore();
  });
});
