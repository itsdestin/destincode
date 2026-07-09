// Pins the enable/disable transition serialization in sync-spaces/service.ts:
// enable(true) racing enable(false) must run strictly sequentially, and a
// superseded engine start must stop its own instance (no orphaned watchers).
// All collaborators are mocked — this tests ONLY the composition root's
// transition chaining, not the engine/transport themselves.
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock factories are hoisted above imports, so shared fake state must be
// created via vi.hoisted for the factories to close over it.
const h = vi.hoisted(() => {
  class FakeEngine {
    stopped = false;
    added: string[] = [];
    // Test releases this to let a blocked addSpace proceed — simulates the
    // real engine suspending on chokidar's ready await mid-startEngine.
    releaseAddSpace: (() => void) | null = null;
    constructor() { h.engines.push(this); }
    async addSpace(space: { id: string }): Promise<void> {
      await new Promise<void>((res) => { this.releaseAddSpace = res; });
      this.added.push(space.id);
    }
    async syncSpace(): Promise<void> {}
    async stop(): Promise<void> { this.stopped = true; }
  }
  return { engines: [] as InstanceType<typeof FakeEngine>[], FakeEngine };
});

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));
vi.mock('../src/main/sync-spaces/engine', () => ({ SpaceSyncEngine: h.FakeEngine }));
vi.mock('../src/main/sync-spaces/managed-roots', () => ({
  ManagedRoots: class {
    ensure(): void {}
    listProjects(): Array<{ name: string; path: string }> { return []; }
    spaces(): Array<{ id: string; kind: string; root: string }> {
      return [{ id: 'personal', kind: 'personal', root: '/fake/personal' }];
    }
  },
}));
vi.mock('../src/main/sync-spaces/space-manager', () => ({
  SpaceManager: class {
    private enabled = false;
    isEnabled(): boolean { return this.enabled; }
    setEnabled(v: boolean): void { this.enabled = v; }
    remoteFor(): string | null { return null; }
    async ensureRemote(): Promise<string> { return 'https://github.com/x/y.git'; }
  },
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
  beforeEach(() => { h.engines.length = 0; });

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
});
