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

// These are fs.watch INTEGRATION tests — they wait on real filesystem events,
// so their wall-clock scales with machine load and vitest's parallel pool
// guarantees load. The 5000ms literal these replaced took the macOS leg of beta
// run 29701441150 red TWICE on 2026-07-19, with a DIFFERENT victim test each
// run ('debounces file changes…' then 'emits error events…') — the signature of
// a too-tight budget, not a broken assertion. Windows and Linux passed both times.
//
// Note for whoever touches this next: PR #163 swapped this family's fixed
// sleep()s for vi.waitFor bounded-retry polling, which was right — but
// vi.waitFor carries its OWN fixed ceiling, so the budget moved rather than
// disappeared. One named knob per file; do NOT reintroduce inline literals (an
// inline third arg on it() silently overrides vi.setConfig — the #163 trap).
const WAIT_MS = 60_000;

describe('SpaceSyncEngine', () => {
  it('debounces file changes into one sync (pull then push)', async () => {
    const t = fakeTransport();
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 150, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'project:x', kind: 'project', root: tmp };
    await engine.addSpace(space);
    fs.writeFileSync(path.join(tmp, 'a.md'), '1');
    fs.writeFileSync(path.join(tmp, 'b.md'), '2');
    await vi.waitFor(() => expect(t.pushes.length).toBe(1), { timeout: WAIT_MS });
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

  it('ignores the ephemeral *.json.lock dirs cas-write creates', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: () => {} });
    await engine.addSpace({ id: 'personal', kind: 'personal', root: tmp });
    // cas-write.ts takes a mkdir-based lock (`<file>.json.lock`) around every
    // conversation/registry write and removes it milliseconds later. Chokidar
    // racing that rmdir on Windows throws EPERM, which surfaced to the user as
    // a red "Couldn't sync" on a sync that was working fine.
    fs.mkdirSync(path.join(tmp, 'e4b946bb-f310-4499-b677-e6c890453ca5.json.lock'), { recursive: true });
    await new Promise(r => setTimeout(r, 500));
    expect(t.pushes.length).toBe(0);
    await engine.stop();
  });

  it('still syncs real lockfiles a user keeps in a project (Cargo.lock)', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: () => {} });
    await engine.addSpace({ id: 'project:x', kind: 'project', root: tmp });
    // The lock-dir ignore is scoped to `.json.lock` precisely so real lockfiles
    // (Cargo.lock, Gemfile.lock, poetry.lock) keep triggering an instant sync.
    fs.writeFileSync(path.join(tmp, 'Cargo.lock'), 'x');
    await vi.waitFor(() => expect(t.pushes.length).toBe(1), { timeout: WAIT_MS });
    await engine.stop();
  });

  it('poll timer pulls without local changes', async () => {
    const t = fakeTransport();
    const engine = new SpaceSyncEngine(t, { debounceMs: 5000, pollMs: 120, onEvent: () => {} });
    await engine.addSpace({ id: 'personal', kind: 'personal', root: tmp });
    await vi.waitFor(() => expect(t.pulls.length).toBeGreaterThanOrEqual(1), { timeout: WAIT_MS });
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
    await vi.waitFor(() => expect(t.pulls.length).toBe(1), { timeout: WAIT_MS });
    void engine.syncSpace(space);                                // mid-sync: sets the rerun flag
    void engine.syncSpace(space);                                // mid-sync again: must NOT queue a second rerun
    releaseFirstPull();
    await first;
    // Exactly two syncs total: the original + one coalesced rerun.
    await vi.waitFor(() => expect(t.pushes.length).toBe(2), { timeout: WAIT_MS });
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

  it('folds a push-retry recovery pull into the synced event (updated) and emits its conflicts', async () => {
    const t = fakeTransport();
    // The caller-visible pull sees nothing new; the peer's changes arrive via
    // the PUSH's internal recovery pull (concurrent-push race). The engine must
    // OR the flags and emit the recovery conflicts — otherwise the materialize
    // sweep / discovery / conflict notice never fire for changes that ARE on disk.
    (t.push as any).mockImplementation(async (s: SyncSpace) => {
      t.pushes.push(s.id);
      return { pushed: true, oversize: [], updated: true, conflictCopies: ['doc (from Other, 2026-07-15).md'] };
    });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    const synced = events.find(e => e.type === 'synced') as Extract<SpaceSyncEvent, { type: 'synced' }>;
    expect(synced).toBeDefined();
    expect(synced.updated).toBe(true);
    const conflict = events.find(e => e.type === 'conflict') as Extract<SpaceSyncEvent, { type: 'conflict' }>;
    expect(conflict).toBeDefined();
    expect(conflict.copies).toEqual(['doc (from Other, 2026-07-15).md']);
    await engine.stop();
  });

  // ---- Honest-state-machine pins (2026-07-22) ----------------------------
  // A space with no remote must NEVER emit 'synced': pull/push silently no-op
  // without one, and that phantom success superseded the real provisioning
  // error under latestUnresolvedError — a fresh device showed green
  // "All synced" while it had never contacted GitHub (beta.8 macOS VM bug).

  it('never emits synced for a remote-less space (no provisioner: errors instead)', async () => {
    const t = fakeTransport();
    (t.hasRemote as any).mockImplementation(async () => false);
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e) });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    expect(events.some(e => e.type === 'synced')).toBe(false);
    expect(events.some(e => e.type === 'error')).toBe(true);
    // And it never reached the (silently no-opping) pull/push.
    expect(t.pulls.length).toBe(0);
    expect(t.pushes.length).toBe(0);
    await engine.stop();
  });

  it('provisions a remote-less space via ensureProvisioned, then really syncs', async () => {
    const t = fakeTransport();
    let provisioned = false;
    (t.hasRemote as any).mockImplementation(async () => provisioned);
    const ensureProvisioned = vi.fn(async () => { provisioned = true; });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e), ensureProvisioned });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    expect(ensureProvisioned).toHaveBeenCalledTimes(1);
    expect(t.pulls.length).toBe(1);
    expect(t.pushes.length).toBe(1);
    expect(events.some(e => e.type === 'synced')).toBe(true);
    expect(events.some(e => e.type === 'error')).toBe(false);
    // Already-provisioned spaces don't re-provision on the next cycle.
    await engine.syncSpace(space);
    expect(ensureProvisioned).toHaveBeenCalledTimes(1);
    await engine.stop();
  });

  it('self-heals: provisioning failure surfaces VERBATIM each cycle until it succeeds', async () => {
    const t = fakeTransport();
    let provisioned = false;
    (t.hasRemote as any).mockImplementation(async () => provisioned);
    // First two cycles fail like a stock machine (gh absent); third succeeds
    // (user installed gh / connected GitHub) — no restart, no toggle-cycle.
    const ensureProvisioned = vi.fn()
      .mockRejectedValueOnce(new Error('GitHub CLI (gh) is not installed — sync needs it to create your private repos'))
      .mockRejectedValueOnce(new Error('GitHub CLI (gh) is not installed — sync needs it to create your private repos'))
      .mockImplementation(async () => { provisioned = true; });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 50, pollMs: 0, onEvent: e => events.push(e), ensureProvisioned });
    const space: SyncSpace = { id: 'personal', kind: 'personal', root: tmp };
    await engine.addSpace(space);
    await engine.syncSpace(space);
    await engine.syncSpace(space);
    // The plain-language cause reaches the event stream verbatim, EVERY cycle —
    // re-emission is what keeps it alive past latestUnresolvedError's
    // "a later synced supersedes" rule.
    const errs = events.filter(e => e.type === 'error') as Extract<SpaceSyncEvent, { type: 'error' }>[];
    expect(errs.length).toBe(2);
    expect(errs[0].message).toMatch(/GitHub CLI \(gh\) is not installed/);
    expect(events.some(e => e.type === 'synced')).toBe(false);
    // Cause fixed → the very next cycle provisions and completes a real sync.
    await engine.syncSpace(space);
    expect(events.some(e => e.type === 'synced')).toBe(true);
    await engine.stop();
  });

  it('emits error events instead of throwing (never-block, spec §13)', async () => {
    const t = fakeTransport();
    (t.push as any).mockImplementation(async () => { throw new Error('boom'); });
    const events: SpaceSyncEvent[] = [];
    const engine = new SpaceSyncEngine(t, { debounceMs: 100, pollMs: 0, onEvent: e => events.push(e) });
    await engine.addSpace({ id: 'project:x', kind: 'project', root: tmp });
    fs.writeFileSync(path.join(tmp, 'a.md'), '1');
    await vi.waitFor(() => expect(events.some(e => e.type === 'error')).toBe(true), { timeout: WAIT_MS });
    await engine.stop();
  });
});
