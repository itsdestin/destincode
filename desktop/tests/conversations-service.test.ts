// Pins the Conversation Store composition root (conversations/service.ts):
// the startup + periodic reconciler kick, live transcript-event intake
// (debounced activity upserts + prompt mirror/push on turn-end), title/flag
// write-through, and the materialize-on-synced sweep. All collaborators
// (store, mirror, reconciler, sync-spaces) are faked via vi.hoisted, mirroring
// sync-spaces-service.test.ts — this tests ONLY the wiring, not the IO shells.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// vi.mock factories are hoisted above imports, so shared fake state must be
// created via vi.hoisted for the factories to close over it.
const h = vi.hoisted(() => {
  return {
    // Single fake store instance returned by createConversationStore(root).
    // root() is (re)assigned per createConversationStore call to echo the root
    // the service computed, so spaceTranscriptPath resolution is real.
    store: {
      upsert: vi.fn(async (_p: any) => ({ id: 'x' })),
      get: vi.fn(async () => null),
      list: vi.fn(async (_provider: string): Promise<any[]> => []),
      setFlag: vi.fn(async () => {}),
      setTitle: vi.fn(async () => {}),
      root: vi.fn(() => ''),
    },
    // Default reconciler NEVER resolves — that's how the non-blocking-start test
    // (carry-forward 2) proves startConversationStore doesn't await it. Callers
    // attach .catch, so a never-resolving promise causes no unhandled rejection.
    reconcile: vi.fn((_opts: any) => new Promise<number>(() => {})),
    mirrorIn: vi.fn((_o: any) => ({ copied: true })),
    materializeOut: vi.fn((_o: any) => ({ copied: true })),
    syncSpacesSyncNow: vi.fn(async (_spaceId?: string) => ({ ok: true })),
    // onSyncSpacesEvent subscribers — fireSync() drives them like the real
    // broadcast() fan-out would.
    syncListeners: new Set<(e: any) => void>(),
    managedRoots: null as any,
    // Saved folders returned by the mocked readFolders — configurable so the
    // knownFolders-wiring test can exercise both sources.
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
  getManagedRoots: () => h.managedRoots,
}));
vi.mock('../src/main/saved-folders', () => ({
  readFolders: () => h.savedFolders,
}));
// ccProjectSlug + shared/types are used REAL (pure / type-only).

function fireSync(e: any): void {
  for (const fn of h.syncListeners) fn(e);
}

async function freshService(opts?: {
  conversationsRoot?: string; projectsDir?: string; topicsDir?: string; device?: string;
}) {
  vi.resetModules();
  const svc = await import('../src/main/conversations/service');
  await svc.startConversationStore(opts);
  return svc;
}

function ev(over: Partial<any>): any {
  return { type: 'user-message', sessionId: 'desktop-1', uuid: 'u', timestamp: 1_700_000_000_000, data: {}, ...over };
}

let tmpRoot = '';

describe('conversations service composition root', () => {
  beforeEach(() => {
    vi.useRealTimers();
    h.syncListeners.clear();
    h.store.upsert.mockReset().mockResolvedValue({ id: 'x' } as any);
    h.store.list.mockReset().mockResolvedValue([]);
    h.store.setFlag.mockReset().mockResolvedValue(undefined as any);
    h.store.setTitle.mockReset().mockResolvedValue(undefined as any);
    h.reconcile.mockReset().mockImplementation(() => new Promise<number>(() => {}));
    h.mirrorIn.mockReset().mockReturnValue({ copied: true } as any);
    h.materializeOut.mockReset().mockReturnValue({ copied: true } as any);
    h.syncSpacesSyncNow.mockReset().mockResolvedValue({ ok: true } as any);
    h.savedFolders = [];
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-svc-'));
    h.managedRoots = { personalRoot: path.join(tmpRoot, 'Personal'), listProjects: () => [] };
  });
  afterEach(() => {
    vi.useRealTimers();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const startOpts = () => ({
    conversationsRoot: path.join(tmpRoot, 'Conversations'),
    projectsDir: path.join(tmpRoot, 'projects'),
    topicsDir: path.join(tmpRoot, 'topics'),
    device: 'test-device',
  });

  // 1 — kicks the reconciler at start, WITHOUT awaiting it (carry-forward 2).
  it('kicks the reconciler at start and resolves even though reconcile never settles', async () => {
    await freshService(startOpts()); // resolves despite the never-resolving reconcile mock
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    const opts = h.reconcile.mock.calls[0][0];
    expect(opts.projectsDir).toBe(startOpts().projectsDir);
    expect(opts.topicsDir).toBe(startOpts().topicsDir);
    expect(opts.device).toBe('test-device');
    expect(typeof opts.mirror).toBe('function');
  });

  // 1b — the reconciler is handed this device's known folders (managed projects
  // + saved folders) so it can recover exact projectKeys (whole-branch review
  // Finding 1). Without this wiring the reconciler truncates hyphenated names.
  it('passes managed + saved folder paths as knownFolders to the reconciler', async () => {
    h.managedRoots = {
      personalRoot: path.join(tmpRoot, 'Personal'),
      listProjects: () => [{ name: 'youcoded-dev', path: 'C:/Users/desti/youcoded-dev' }],
    };
    h.savedFolders = [{ path: 'C:/Users/desti/notes' }];
    await freshService(startOpts());
    const opts = h.reconcile.mock.calls[0][0];
    expect(opts.knownFolders).toEqual([
      'C:/Users/desti/youcoded-dev', // managed project
      'C:/Users/desti/notes',        // saved folder
    ]);
  });

  // 2 — an event upserts local-truth metadata keyed by the claude id. Asserted
  // via turn-complete (non-debounced) so the exact payload lands synchronously.
  it('an event upserts projectName/originalPath/lastActive/device', async () => {
    const svc = await freshService(startOpts());
    const cwd = path.join(tmpRoot, 'my-project');
    svc.noteSessionStarted('claude-abc', cwd);
    svc.noteTranscriptEvent('claude-abc', ev({ type: 'turn-complete', timestamp: 1_700_000_000_000 }));
    await Promise.resolve();
    expect(h.store.upsert).toHaveBeenCalledWith(expect.objectContaining({
      id: 'claude-abc',
      provider: 'claude',
      projectName: path.basename(cwd),
      originalPath: cwd,
      lastActive: new Date(1_700_000_000_000).toISOString(),
      device: 'test-device',
    }));
  });

  // 3 — turn-complete additionally mirrors the transcript and pushes 'personal'.
  it('turn-complete mirrors the jsonl and syncs the personal space promptly', async () => {
    const svc = await freshService(startOpts());
    const cwd = path.join(tmpRoot, 'proj-x');
    svc.noteSessionStarted('claude-xyz', cwd);
    svc.noteTranscriptEvent('claude-xyz', ev({ type: 'turn-complete' }));
    await Promise.resolve();
    expect(h.mirrorIn).toHaveBeenCalledTimes(1);
    const arg = h.mirrorIn.mock.calls[0][0];
    expect(arg.localJsonlPath).toContain('claude-xyz.jsonl');
    expect(arg.localJsonlPath).toContain(startOpts().projectsDir);
    expect(h.syncSpacesSyncNow).toHaveBeenCalledWith('personal');
  });

  // 4 — a personal 'synced'/updated event materializes records that resolve
  // locally; records with no local match are skipped.
  it('synced(updated) event materializes only records whose project resolves locally', async () => {
    const existingDir = path.join(tmpRoot, 'alpha');
    fs.mkdirSync(existingDir, { recursive: true });
    const recA = {
      id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', provider: 'claude',
      projectName: 'alpha', originalPath: existingDir,
      transcriptRef: 'claude/transcripts/alpha/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl',
    };
    const recB = {
      id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', provider: 'claude',
      projectName: 'ghost', originalPath: path.join(tmpRoot, 'nope-does-not-exist'),
      transcriptRef: 'claude/transcripts/ghost/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl',
    };
    // Set the store records AFTER start so the startup catch-up sweep (which
    // calls store.list synchronously during startConversationStore, before this
    // line) sees an empty list — this test isolates the SYNCED-event sweep.
    const svc = await freshService(startOpts());
    h.store.list.mockResolvedValue([recA, recB] as any);
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    expect(h.materializeOut).toHaveBeenCalledTimes(1);
    const arg = h.materializeOut.mock.calls[0][0];
    expect(arg.spaceTranscriptPath).toContain(recA.transcriptRef.replace(/\//g, path.sep));
    expect(arg.localJsonlPath).toContain(`${recA.id}.jsonl`);
    void svc;
  });

  // 4b — Part 1 (2026-07-13 dogfood): a catch-up sweep runs at STARTUP with no
  // synced event, so a peer version already sitting in the local space from a
  // previous run is materialized on launch. Records are set BEFORE start here so
  // the synchronous startup sweep observes them.
  it('runs a catch-up materialize sweep on startup (no synced event needed)', async () => {
    const dir = path.join(tmpRoot, 'startup-proj');
    fs.mkdirSync(dir, { recursive: true });
    const rec = {
      id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', provider: 'claude',
      projectName: 'startup-proj', originalPath: dir,
      transcriptRef: 'claude/transcripts/startup-proj/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee.jsonl',
    };
    h.store.list.mockResolvedValue([rec] as any);
    await freshService(startOpts()); // startup sweep fires — no fireSync
    await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${rec.id}.jsonl`);
  });

  // Review fix 1: the sweep must NEVER touch a LIVE session's transcript. A
  // same-conversation-on-two-devices pull would otherwise materializeOut over
  // the JSONL Claude Code is actively appending to (Windows EPERM containment
  // is unreliable — libuv opens with FILE_SHARE_DELETE; on POSIX the rename
  // always succeeds and CC keeps appending to the unlinked inode → chat view
  // freezes, local turns lost on handle close).
  it('the sweep SKIPS records whose id is a live session; others still materialize', async () => {
    const liveDir = path.join(tmpRoot, 'live-proj');
    const idleDir = path.join(tmpRoot, 'idle-proj');
    fs.mkdirSync(liveDir, { recursive: true });
    fs.mkdirSync(idleDir, { recursive: true });
    const liveRec = {
      id: 'cccccccc-cccc-cccc-cccc-cccccccccccc', provider: 'claude',
      projectName: 'live-proj', originalPath: liveDir,
      transcriptRef: 'claude/transcripts/live-proj/cccccccc-cccc-cccc-cccc-cccccccccccc.jsonl',
    };
    const idleRec = {
      id: 'dddddddd-dddd-dddd-dddd-dddddddddddd', provider: 'claude',
      projectName: 'idle-proj', originalPath: idleDir,
      transcriptRef: 'claude/transcripts/idle-proj/dddddddd-dddd-dddd-dddd-dddddddddddd.jsonl',
    };
    // Records set AFTER start (as in the previous test) so the startup catch-up
    // sweep sees an empty list and this test isolates the SYNCED-event sweep.
    const svc = await freshService(startOpts());
    h.store.list.mockResolvedValue([liveRec, idleRec] as any);
    svc.noteSessionStarted(liveRec.id, liveDir); // liveRec is a LIVE session here
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.materializeOut).toHaveBeenCalled());
    expect(h.materializeOut).toHaveBeenCalledTimes(1);
    expect(h.materializeOut.mock.calls[0][0].localJsonlPath).toContain(`${idleRec.id}.jsonl`);
  });

  // Review fix 4: start must be idempotent — a second start without stop must
  // not leak the first sync-spaces subscription (duplicate sweeps forever) or
  // the first periodic interval.
  it('a second start without stop leaves exactly ONE subscription and ONE interval', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    await svc.startConversationStore(startOpts()); // double start — no stop between
    // Exactly one sweep per synced event ⇒ store.list called once.
    h.store.list.mockClear();
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    await vi.waitFor(() => expect(h.store.list).toHaveBeenCalled());
    expect(h.store.list).toHaveBeenCalledTimes(1);
    // Exactly one periodic interval ⇒ one reconcile per 30-min tick.
    h.reconcile.mockClear();
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
    svc.stopConversationStore();
    vi.useRealTimers();
  });

  it('a non-personal or non-updated synced event does NOT materialize', async () => {
    h.store.list.mockResolvedValue([{ id: 'x', provider: 'claude', projectName: 'a', originalPath: '/x', transcriptRef: 'claude/transcripts/a/x.jsonl' }] as any);
    await freshService(startOpts());
    fireSync({ type: 'synced', spaceId: 'project:alpha', updated: true, pushed: false }); // wrong space
    fireSync({ type: 'synced', spaceId: 'personal', updated: false, pushed: true });      // not updated
    await new Promise((r) => setTimeout(r, 20));
    expect(h.materializeOut).not.toHaveBeenCalled();
  });

  // 5 — title write-through.
  it('noteTitleChanged writes through to store.setTitle', async () => {
    const svc = await freshService(startOpts());
    svc.noteTitleChanged('claude-t', 'My Title');
    expect(h.store.setTitle).toHaveBeenCalledWith('claude', 'claude-t', 'My Title');
  });

  // 6 — flag write-through.
  it('noteFlagChanged writes through to store.setFlag', async () => {
    const svc = await freshService(startOpts());
    svc.noteFlagChanged('claude-f', 'complete', true);
    expect(h.store.setFlag).toHaveBeenCalledWith('claude', 'claude-f', 'complete', true);
  });

  // 7 — stop() unsubscribes, clears the periodic timer AND pending debounce timers.
  it('stopConversationStore unsubscribes, stops the periodic reconciler and pending debounces', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    expect(h.reconcile).toHaveBeenCalledTimes(1); // start kick
    // Advance one periodic interval — reconcile fires again.
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);
    // Arm a pending debounce for a chatty event, then stop BEFORE its 5s window.
    svc.noteSessionStarted('claude-s', path.join(tmpRoot, 'p'));
    svc.noteTranscriptEvent('claude-s', ev({ type: 'assistant-text' }));
    svc.stopConversationStore();
    // A synced event after stop does nothing (unsubscribed + store nulled).
    fireSync({ type: 'synced', spaceId: 'personal', updated: true, pushed: false });
    // Advance well past the periodic interval AND the debounce window.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(h.reconcile).toHaveBeenCalledTimes(2);   // periodic timer cleared
    expect(h.materializeOut).not.toHaveBeenCalled(); // unsubscribed
    expect(h.store.upsert).not.toHaveBeenCalled();   // pending debounce cleared
    vi.useRealTimers();
  });

  // 8 — events for sessions never announced still upsert (no cwd known).
  it('an event for an unannounced session upserts with no originalPath', async () => {
    const svc = await freshService(startOpts());
    svc.noteTranscriptEvent('claude-unknown', ev({ type: 'turn-complete' }));
    await Promise.resolve();
    expect(h.store.upsert).toHaveBeenCalledTimes(1);
    const arg = h.store.upsert.mock.calls[0][0];
    expect(arg.id).toBe('claude-unknown');
    expect(arg.provider).toBe('claude');
    expect(arg.originalPath).toBeUndefined();
    expect(arg.projectName).toBeUndefined();
  });

  // 9 — chatty events debounce to ONE upsert; turn-complete cancels the pending one.
  it('two rapid chatty events coalesce into ONE upsert after the debounce window', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    svc.noteSessionStarted('claude-d', path.join(tmpRoot, 'd'));
    svc.noteTranscriptEvent('claude-d', ev({ type: 'assistant-text', uuid: 'a1' }));
    svc.noteTranscriptEvent('claude-d', ev({ type: 'assistant-text', uuid: 'a2' }));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(h.store.upsert).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('turn-complete cancels a pending debounce timer (no extra upsert later)', async () => {
    vi.useFakeTimers();
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(startOpts());
    svc.noteSessionStarted('claude-c', path.join(tmpRoot, 'c'));
    svc.noteTranscriptEvent('claude-c', ev({ type: 'assistant-text' })); // arms debounce
    svc.noteTranscriptEvent('claude-c', ev({ type: 'turn-complete' }));   // immediate upsert + cancel
    await Promise.resolve();
    expect(h.store.upsert).toHaveBeenCalledTimes(1);
    // The stale debounce timer must NOT fire a second upsert 5s later.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.store.upsert).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  // 10 — a store.upsert rejection does not produce an unhandled rejection.
  it('a rejecting store.upsert is swallowed (no unhandled rejection)', async () => {
    h.store.upsert.mockRejectedValue(new Error('lock timeout'));
    const svc = await freshService(startOpts());
    svc.noteSessionStarted('claude-r', path.join(tmpRoot, 'r'));
    svc.noteTranscriptEvent('claude-r', ev({ type: 'turn-complete' }));
    await new Promise((r) => setTimeout(r, 10));
    // World keeps turning: the prompt push still fired despite the upsert reject.
    expect(h.syncSpacesSyncNow).toHaveBeenCalledWith('personal');
  });

  // Guard: no managed roots + no explicit root → store stays off (no reconcile).
  it('stays off when neither an explicit root nor managed roots are available', async () => {
    h.managedRoots = null;
    vi.resetModules();
    const svc = await import('../src/main/conversations/service');
    await svc.startConversationStore(); // no opts, no managed roots
    expect(h.reconcile).not.toHaveBeenCalled();
    svc.stopConversationStore();
  });
});
