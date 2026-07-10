// Pins the enable/disable transition serialization in sync-spaces/service.ts:
// enable(true) racing enable(false) must run strictly sequentially, and a
// superseded engine start must stop its own instance (no orphaned watchers).
// All collaborators are mocked — this tests ONLY the composition root's
// transition chaining, not the engine/transport themselves.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';

// vi.mock factories are hoisted above imports, so shared fake state must be
// created via vi.hoisted for the factories to close over it.
const h = vi.hoisted(() => {
  class FakeEngine {
    stopped = false;
    added: string[] = [];
    // syncSpace is a spy so the per-space / sync-everything tests can assert
    // which spaces were reconciled.
    syncSpace = vi.fn(async (_space: { id: string }): Promise<void> => {});
    // Test releases this to let a blocked addSpace proceed — simulates the
    // real engine suspending on chokidar's ready await mid-startEngine.
    releaseAddSpace: (() => void) | null = null;
    // Capture the onEvent callback (service.broadcast) so a test can fire an
    // engine event the way the real engine would, and assert on the stamp.
    constructor(_transport?: unknown, opts?: { onEvent?: (e: unknown) => void }) {
      h.onEvent = opts?.onEvent ?? null;
      h.engines.push(this);
    }
    async addSpace(space: { id: string }): Promise<void> {
      // The timestamp/per-space tests want enable() to resolve without manual
      // gating; the serialization tests keep the blocking gate (autoAddSpace off).
      if (h.autoAddSpace) { this.added.push(space.id); return; }
      await new Promise<void>((res) => { this.releaseAddSpace = res; });
      this.added.push(space.id);
    }
    async stop(): Promise<void> { this.stopped = true; }
  }
  return {
    engines: [] as InstanceType<typeof FakeEngine>[],
    FakeEngine,
    // Default single space keeps the existing serialization tests unchanged;
    // the per-space tests widen this to two projects.
    spaces: [{ id: 'personal', kind: 'personal', root: '/fake/personal' }] as Array<{ id: string; kind: string; root: string }>,
    autoAddSpace: false,
    // When true, the fake SpaceManager reports enabled at construction time —
    // makes startSyncSpaces launch its UNCHAINED boot startEngine, the only
    // path where a run can be superseded mid-flight by a disable/enable pair.
    initialEnabled: false,
    onEvent: null as null | ((e: unknown) => void),
    // SyncHub fake (Task 5): captures the opts createSyncHubSocket was called
    // with (so a test can read deviceName + fire opts.onEvent the way the real
    // socket would) plus spies for the surface the service drives.
    hub: {
      opts: null as any,
      setDesired: vi.fn(),
      sendSignal: vi.fn(() => true),
      isConnected: vi.fn(() => false),
      destroy: vi.fn(),
    },
  };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../src/main/sync-spaces/engine', () => ({ SpaceSyncEngine: h.FakeEngine }));
vi.mock('../src/main/sync-spaces/managed-roots', () => ({
  ManagedRoots: class {
    ensure(): void {}
    listProjects(): Array<{ name: string; path: string }> { return []; }
    // Reads the hoisted list live so a test can widen the space set before enable.
    spaces(): Array<{ id: string; kind: string; root: string }> { return h.spaces; }
  },
}));
vi.mock('../src/main/sync-spaces/space-manager', () => ({
  SpaceManager: class {
    private enabled = h.initialEnabled; // read at construction — see h.initialEnabled comment
    isEnabled(): boolean { return this.enabled; }
    setEnabled(v: boolean): void { this.enabled = v; }
    remoteFor(): string | null { return null; }
    async ensureRemote(): Promise<string> { return 'https://github.com/x/y.git'; }
  },
  // The real repoNameForSpace hashes the id; the service only needs a stable
  // space-id → repo-name mapping, so a deterministic stub keeps the signal
  // spaceKey assertions readable ('repo-project:beta' etc.).
  repoNameForSpace: (s: { id: string }) => `repo-${s.id}`,
}));
vi.mock('../src/main/sync-spaces/git-transport', () => ({
  GitTransport: class {
    async init(): Promise<void> {}
    async setRemote(): Promise<void> {}
  },
}));
vi.mock('../src/main/sync-spaces/daily-backup', () => ({
  DailyBackup: class { async runIfDue(): Promise<void> {} },
}));
vi.mock('../src/main/sync-hub-socket', () => ({
  // Return the shared spy surface; capture the opts so tests can drive the
  // socket's onEvent callback (connected / disconnected / signal).
  createSyncHubSocket: (opts: any) => {
    h.hub.opts = opts;
    return {
      setDesired: h.hub.setDesired,
      sendSignal: h.hub.sendSignal,
      isConnected: h.hub.isConnected,
      destroy: h.hub.destroy,
    };
  },
}));

async function freshService() {
  vi.resetModules();
  h.engines.length = 0;
  const svc = await import('../src/main/sync-spaces/service');
  await svc.startSyncSpaces(async () => [], () => {});
  return svc;
}

/** Wait until the Nth engine exists AND is suspended inside addSpace. Polls
 *  the live array — the engine is constructed asynchronously (inside the
 *  chained transition), so it can't be captured before calling this. */
async function waitForGate(index: number): Promise<void> {
  await vi.waitFor(() => {
    expect(h.engines.length).toBeGreaterThan(index);
    expect(h.engines[index].releaseAddSpace).toBeTruthy();
  });
}

describe('sync-spaces service transition serialization', () => {
  beforeEach(() => {
    h.engines.length = 0;
    // Reset per-test knobs so the serialization tests keep the default single
    // space + blocking addSpace gate they were written against.
    h.spaces = [{ id: 'personal', kind: 'personal', root: '/fake/personal' }];
    h.autoAddSpace = false;
    h.initialEnabled = false;
    h.onEvent = null;
    // Reset the SyncHub fake so setDesired/sendSignal/destroy call counts and
    // the captured opts don't bleed across tests.
    h.hub.opts = null;
    h.hub.setDesired.mockClear();
    h.hub.sendSignal.mockClear();
    h.hub.isConnected.mockClear();
    h.hub.destroy.mockClear();
  });

  it('disable issued mid-start waits for the start, then stops that engine (no interleave)', async () => {
    const svc = await freshService();
    const p1 = svc.syncSpacesEnable(true);
    await waitForGate(0);
    const e1 = h.engines[0];
    // Disable while the start is suspended inside addSpace. Serialization
    // means this must NOT stop the engine yet.
    const p2 = svc.syncSpacesEnable(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(e1.stopped).toBe(false);
    // Release the start; it completes, THEN the queued disable stops it.
    e1.releaseAddSpace!();
    const [s1, s2] = await Promise.all([p1, p2]);
    expect(e1.added).toEqual(['personal']); // start finished cleanly, not abandoned mid-loop
    expect(e1.stopped).toBe(true);          // queued disable then stopped it
    expect(s1.enabled).toBe(false);         // status reads run after BOTH queued transitions
    expect(s2.enabled).toBe(false);
    expect((await svc.syncSpacesStatus()).enabled).toBe(false);
  });

  it('rapid enable→disable→enable leaves exactly one live engine, all others stopped', async () => {
    const svc = await freshService();
    const p1 = svc.syncSpacesEnable(true);
    await waitForGate(0);
    const p2 = svc.syncSpacesEnable(false);
    const p3 = svc.syncSpacesEnable(true);
    h.engines[0].releaseAddSpace!();
    // Second start blocks on its own addSpace gate once the disable ran.
    await waitForGate(1);
    h.engines[1].releaseAddSpace!();
    await Promise.all([p1, p2, p3]);
    expect(h.engines[0].stopped).toBe(true);
    expect(h.engines[1].stopped).toBe(false);
    expect(h.engines[1].added).toEqual(['personal']);
    expect((await svc.syncSpacesStatus()).enabled).toBe(true);
  });

  // ---- Per-space sync-now + event timestamps (Project View UX, Task 2) ----

  // These use autoAddSpace so enable() resolves without manual gating, and a
  // two-project space set so "sync one" vs "sync everything" are distinguishable.
  async function enabledMultiSpaceService() {
    h.autoAddSpace = true;
    h.spaces = [
      { id: 'personal', kind: 'personal', root: '/fake/personal' },
      { id: 'project:alpha', kind: 'project', root: '/fake/alpha' },
      { id: 'project:beta', kind: 'project', root: '/fake/beta' },
    ];
    const svc = await freshService();
    await svc.syncSpacesEnable(true);
    return svc;
  }

  it('syncSpacesSyncNow(spaceId) syncs ONLY the matching space', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace.mockClear(); // drop the initial-reconcile calls from enable
    await svc.syncSpacesSyncNow('project:beta');
    expect(engine.syncSpace).toHaveBeenCalledTimes(1);
    expect(engine.syncSpace.mock.calls[0][0].id).toBe('project:beta');
  });

  it('syncSpacesSyncNow() with no arg still syncs every space', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace.mockClear();
    await svc.syncSpacesSyncNow();
    expect(engine.syncSpace.mock.calls.length).toBeGreaterThan(1);
  });

  it('broadcast stamps events with an `at` timestamp', async () => {
    const svc = await enabledMultiSpaceService();
    // Fire the engine's onEvent hook (= service.broadcast) the way the real
    // engine would when a space finishes syncing.
    h.onEvent!({ type: 'synced', spaceId: 'project:beta', pushed: true, updated: false });
    const st = await svc.syncSpacesStatus();
    const e = st.recentEvents.find((x: any) => x.spaceId === 'project:beta');
    expect(typeof (e as any).at).toBe('number');
  });

  // ---- SyncHub wiring (Task 5): signals in/out, reconcile, status ----

  it('enabling sync creates the hub socket (deviceName=hostname, setDesired true); disabling tears it down', async () => {
    const svc = await enabledMultiSpaceService();
    expect(h.hub.opts).toBeTruthy();
    expect(h.hub.opts.deviceName).toBe(os.hostname());
    expect(h.hub.setDesired).toHaveBeenCalledWith(true);
    await svc.syncSpacesEnable(false);
    expect(h.hub.setDesired).toHaveBeenCalledWith(false);
    expect(h.hub.destroy).toHaveBeenCalled();
  });

  it('a hub signal for a known repo name syncs exactly that space; unknown is a no-op', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace.mockClear(); // drop the initial-reconcile calls from enable
    h.hub.opts.onEvent({ type: 'signal', kind: 'space-updated', spaceKey: 'repo-project:beta' });
    expect(engine.syncSpace).toHaveBeenCalledTimes(1);
    expect(engine.syncSpace.mock.calls[0][0].id).toBe('project:beta');
    engine.syncSpace.mockClear();
    h.hub.opts.onEvent({ type: 'signal', kind: 'space-updated', spaceKey: 'repo-nope' });
    expect(engine.syncSpace).not.toHaveBeenCalled();
    // Keep the service in a clean state for teardown; unrelated to the assertion.
    void svc;
  });

  it('hub connected reconciles every space and flips syncHub to connected', async () => {
    const svc = await enabledMultiSpaceService();
    const engine = h.engines[0];
    engine.syncSpace.mockClear();
    h.hub.opts.onEvent({ type: 'connected' });
    const ids = engine.syncSpace.mock.calls.map((c: any) => c[0].id).sort();
    expect(ids).toEqual(['personal', 'project:alpha', 'project:beta']);
    expect((await svc.syncSpacesStatus()).syncHub).toBe('connected');
  });

  it('a push (synced, pushed:true) signals the room; pushed:false sends nothing', async () => {
    const svc = await enabledMultiSpaceService();
    h.hub.sendSignal.mockClear();
    h.onEvent!({ type: 'synced', spaceId: 'project:beta', pushed: true, updated: false });
    expect(h.hub.sendSignal).toHaveBeenCalledWith('space-updated', 'repo-project:beta');
    h.hub.sendSignal.mockClear();
    h.onEvent!({ type: 'synced', spaceId: 'project:beta', pushed: false, updated: true });
    expect(h.hub.sendSignal).not.toHaveBeenCalled();
    void svc;
  });

  it('syncHub is "off" when sync is disabled', async () => {
    h.autoAddSpace = true;
    h.spaces = [{ id: 'personal', kind: 'personal', root: '/fake/personal' }];
    const svc = await freshService();
    expect((await svc.syncSpacesStatus()).syncHub).toBe('off');
  });

  it('hub connect/disconnect emit stamped hub-status events into recentEvents', async () => {
    const svc = await enabledMultiSpaceService();
    h.hub.opts.onEvent({ type: 'connected' });
    h.hub.opts.onEvent({ type: 'disconnected' });
    const evs = (await svc.syncSpacesStatus()).recentEvents.filter((e: any) => e.type === 'hub-status');
    expect(evs.map((e: any) => e.status)).toEqual(['connected', 'disconnected']);
    expect(typeof (evs[0] as any).at).toBe('number');
  });

  it('a superseded boot start must not clobber hubStatus set by the newer live socket', async () => {
    // Boot with sync already enabled so startSyncSpaces launches an UNCHAINED
    // startEngine — the only run not serialized through `transition`, so it
    // can resume AFTER a disable/enable pair has installed a newer engine +
    // socket. The superseded run must bail without touching hubStatus (or
    // creating a socket): stamping 'connecting'/'off' here would make
    // syncSpacesStatus() lie about a live connection until the next reconnect.
    h.initialEnabled = true;
    vi.resetModules();
    h.engines.length = 0;
    const svc = await import('../src/main/sync-spaces/service');
    // Don't await — the boot start is suspended inside engines[0].addSpace.
    const bootP = svc.startSyncSpaces(async () => [], () => {});
    await waitForGate(0);
    // Rapid disable → enable while the boot start is still suspended. These are
    // chained, so the enable's start (engines[1]) runs after the disable.
    const pOff = svc.syncSpacesEnable(false);
    const pOn = svc.syncSpacesEnable(true);
    await waitForGate(1);
    h.engines[1].releaseAddSpace!();
    await Promise.all([pOff, pOn]);
    // The newer run's socket connects.
    h.hub.opts.onEvent({ type: 'connected' });
    expect((await svc.syncSpacesStatus()).syncHub).toBe('connected');
    // Now the superseded boot run resumes and bails — status must be untouched.
    h.engines[0].releaseAddSpace!();
    await bootP;
    expect((await svc.syncSpacesStatus()).syncHub).toBe('connected');
  });
});
