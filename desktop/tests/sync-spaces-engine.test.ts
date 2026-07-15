// desktop/tests/sync-spaces-engine.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SpaceSyncEngine } from '../src/main/sync-spaces/engine';
import type { SyncSpace, SyncTransport, SpaceSyncEvent } from '../src/main/sync-spaces/types';

function fakeTransport(): SyncTransport & { pushes: string[]; pulls: string[] } {
  const t: any = {
    pushes: [] as string[], pulls: [] as string[],
    init: vi.fn(async () => {}),
    hasRemote: vi.fn(async () => true),
    setRemote: vi.fn(async () => {}),
    push: vi.fn(async (s: SyncSpace) => { t.pushes.push(s.id); return { pushed: true, oversize: [] }; }),
    pull: vi.fn(async (s: SyncSpace) => { t.pulls.push(s.id); return { updated: false, conflictCopies: [] }; }),
    history: vi.fn(async () => []),
  };
  return t;
}

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-eng-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

describe('SpaceSyncEngine', () => {
  it('debounces file changes into one sync (pull then push)', async () => {
    const t = fakeTransport();
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 150, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'project:x', kind: 'project', root: tmp };
    await engine.addSpace(space);
    fs.writeFileSync(path.join(tmp, 'a.md'), '1');
    fs.writeFileSync(path.join(tmp, 'b.md'), '2');
    await vi.waitFor(() => expect(t.pushes.length).toBe(1), { timeout: 5000 });
    expect(t.pulls.length).toBe(1);                 // pull-before-push ordering
    expect(events.some(e => e.type === 'synced')).toBe(true);
    await engine.stop();
  });

  it('ignores changes under .youcoded/ and node_modules/', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: () => {} });
    await engine.addSpace({ id: 'project:x', kind: 'project', root: tmp });
    fs.mkdirSync(path.join(tmp, '.youcoded'), { recursive: true });
    fs.writeFileSync(path.join(tmp, '.youcoded', 'sync.log'), 'x');
    fs.mkdirSync(path.join(tmp, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'node_modules', 'y.js'), 'x');
    await new Promise(r => setTimeout(r, 500));
    expect(t.pushes.length).toBe(0);
    await engine.stop();
  });

  it('poll timer pulls without local changes', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 5000, pollMs: 120, onEvent: () => {} });
    await engine.addSpace({ id: 'personal', kind: 'personal', root: tmp });
    await vi.waitFor(() => expect(t.pulls.length).toBeGreaterThanOrEqual(1), { timeout: 5000 });
    await engine.stop();
  });

  it('single-flight: overlapping sync requests coalesce into exactly one rerun', async () => {
    const t = fakeTransport();
    // Make the FIRST pull hang until we release it, so we can pile up sync
    // requests while a sync is genuinely in flight.
    let releaseFirstPull: () => void = () => {};
    let firstPull = true;
    (t.pull as any).mockImplementation(async (s: SyncSpace) => {
      t.pulls.push(s.id);
      if (firstPull) {
        firstPull = false;
        await new Promise<void>(r => { releaseFirstPull = r; });
      }
      return { updated: false, conflictCopies: [] };
    });
    const engine = new SpaceSyncEngine(t, { debounceMs: 60_000, pollMs: 0, onEvent: () => {} });
    const space: SyncSpace = { id: 'project:x', kind: 'project', root: tmp };
    await engine.addSpace(space);
    const first = engine.syncSpace(space);                       // starts, blocks inside pull
    await vi.waitFor(() => expect(t.pulls.length).toBe(1), { timeout: 5000 });
    void engine.syncSpace(space);                                // mid-sync: sets the rerun flag
    void engine.syncSpace(space);                                // mid-sync again: must NOT queue a second rerun
    releaseFirstPull();
    await first;
    // Exactly two syncs total: the original + one coalesced rerun.
    await vi.waitFor(() => expect(t.pushes.length).toBe(2), { timeout: 5000 });
    await new Promise(r => setTimeout(r, 300));                  // settle: no third sync sneaks in
    expect(t.pushes.length).toBe(2);
    expect(t.pulls.length).toBe(2);
    await engine.stop();
  });

  it('warns ONCE per launch when the hidden history exceeds the size threshold', async () => {
    const t = fakeTransport();
    (t as any).maybeGc = vi.fn(async () => {});
    (t as any).gitDirSizeBytes = vi.fn(async () => 600); // > injected 500-byte threshold
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, sizeWarnBytes: 500, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'project:big', kind: 'project', root: tmp };
    await engine.addSpace(space);
    // Two independent syncs — the warning must fire on the first only.
    await engine.syncSpace(space);
    await engine.syncSpace(space);
    // Emitted as 'notice' (NOT 'error') so it never turns the sync dot red.
    const warnings = events.filter(e => e.type === 'notice' && /is large/.test((e as any).message));
    expect(warnings.length).toBe(1);
    // And crucially NO error event was produced by the healthy large space.
    expect(events.some(e => e.type === 'error')).toBe(false);
    expect((t as any).maybeGc).toHaveBeenCalled();
    await engine.stop();
  });

  it('a maybeGc failure never breaks the sync (best-effort maintenance)', async () => {
    const t = fakeTransport();
    (t as any).maybeGc = vi.fn(async () => { throw new Error('gc boom'); });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'project:x', kind: 'project', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    // The sync still reports success; the gc throw is swallowed (no error event).
    expect(events.some(e => e.type === 'synced')).toBe(true);
    expect(events.some(e => e.type === 'error')).toBe(false);
    await engine.stop();
  });

  it('emits error events instead of throwing (never-block, spec §13)', async () => {
    const t = fakeTransport();
    (t.push as any).mockImplementation(async () => { throw new Error('boom'); });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: e => events.push(e) });
    await engine.addSpace({ id: 'project:x', kind: 'project', root: tmp });
    fs.writeFileSync(path.join(tmp, 'a.md'), '1');
    await vi.waitFor(() => expect(events.some(e => e.type === 'error')).toBe(true), { timeout: 5000 });
    await engine.stop();
  });
});
