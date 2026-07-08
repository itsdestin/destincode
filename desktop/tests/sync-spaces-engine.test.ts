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
