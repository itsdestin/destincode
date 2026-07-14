// Plan 2b Task 8 — pins the holder-side takeover sequence (createHolderTakeover).
// When another device requests a session THIS device holds, the holder must:
//   interrupt (ESC to PTY) -> flush local->space -> release lease -> pushMoved -> destroy
// The ORDER is load-bearing: MIRROR-BEFORE-RELEASE (the requester pulls on seeing
// the release, so the final turn must already be in the space) and
// RELEASE-BEFORE-DESTROY (release must land before the local session ends). All
// collaborators are injected fakes — this tests ONLY the sequence, not the IO.
import { describe, it, expect, vi } from 'vitest';
import { createHolderTakeover } from '../src/main/conversations/takeover';

// Build a deps bundle whose every fake pushes a label into a shared order log, so
// tests can assert both WHICH steps ran and in WHAT order.
function makeDeps(opts?: { liveDesktopIds?: string[]; flushRejects?: boolean }) {
  const order: string[] = [];
  const live = new Set(opts?.liveDesktopIds ?? []);
  const sessionIdMap = new Map<string, string>();
  const deps = {
    order,
    sessionIdMap,
    sessionManager: {
      // A desktop id is "live" only if it's in the live set.
      getSession: (id: string) => (live.has(id) ? { id } : undefined),
      sendInput: vi.fn((id: string, text: string) => { order.push(`interrupt:${id}:${JSON.stringify(text)}`); return true; }),
      destroySession: vi.fn((id: string) => { order.push(`destroy:${id}`); return true; }),
    },
    leaseClient: {
      release: vi.fn(async (sid: string) => { order.push(`release:${sid}`); }),
    },
    flushSessionToSpace: vi.fn(async (cid: string) => {
      order.push(`flush:${cid}`);
      if (opts?.flushRejects) throw new Error('flush blew up');
    }),
    pushMoved: vi.fn((did: string, device?: string) => { order.push(`push:${did}:${device ?? ''}`); }),
  };
  return deps;
}

describe('createHolderTakeover', () => {
  it('runs interrupt -> flush -> release -> pushMoved -> destroy for a live held session', async () => {
    const deps = makeDeps({ liveDesktopIds: ['desktop-1'] });
    // desktop-1 holds claude-abc; a stray other mapping must be ignored.
    deps.sessionIdMap.set('desktop-1', 'claude-abc');
    deps.sessionIdMap.set('desktop-2', 'claude-other');
    const handler = createHolderTakeover(deps as any);

    await handler('claude-abc', { deviceId: 'dev-b', device: 'Laptop-B' });

    expect(deps.order).toEqual([
      'interrupt:desktop-1:"\\u001b"', // single ESC byte to the PTY
      'flush:claude-abc',
      'release:claude-abc',
      'push:desktop-1:Laptop-B',       // desktopId reverse-mapped, from.device forwarded
      'destroy:desktop-1',
    ]);
    // The reverse-map picked the correct desktop id, not desktop-2.
    expect(deps.sessionManager.sendInput).toHaveBeenCalledWith('desktop-1', '\x1b');
    expect(deps.pushMoved).toHaveBeenCalledWith('desktop-1', 'Laptop-B');
  });

  it('mirror-before-release AND release-before-destroy hold', async () => {
    const deps = makeDeps({ liveDesktopIds: ['d1'] });
    deps.sessionIdMap.set('d1', 'c1');
    const handler = createHolderTakeover(deps as any);
    await handler('c1', { deviceId: 'x', device: 'X' });
    const iFlush = deps.order.indexOf('flush:c1');
    const iRelease = deps.order.indexOf('release:c1');
    const iDestroy = deps.order.indexOf('destroy:d1');
    expect(iFlush).toBeGreaterThanOrEqual(0);
    expect(iRelease).toBeGreaterThan(iFlush);   // MIRROR (flush) before RELEASE
    expect(iDestroy).toBeGreaterThan(iRelease); // RELEASE before DESTROY
  });

  it('with NO mapping for the claude id, only releases the lease (no interrupt/flush/push/destroy)', async () => {
    const deps = makeDeps({ liveDesktopIds: [] }); // empty map
    const handler = createHolderTakeover(deps as any);
    await handler('claude-ghost', { deviceId: 'x', device: 'X' });
    expect(deps.order).toEqual(['release:claude-ghost']);
    expect(deps.sessionManager.sendInput).not.toHaveBeenCalled();
    expect(deps.flushSessionToSpace).not.toHaveBeenCalled();
    expect(deps.pushMoved).not.toHaveBeenCalled();
    expect(deps.sessionManager.destroySession).not.toHaveBeenCalled();
  });

  it('with a mapping but the session no longer live (getSession undefined), only releases', async () => {
    // Mapping exists but the desktop id is not in the live set → not actually held.
    const deps = makeDeps({ liveDesktopIds: [] });
    deps.sessionIdMap.set('d-dead', 'claude-dead');
    const handler = createHolderTakeover(deps as any);
    await handler('claude-dead');
    expect(deps.order).toEqual(['release:claude-dead']);
  });

  it('never throws and runs release/push/destroy even when flush rejects', async () => {
    const deps = makeDeps({ liveDesktopIds: ['d1'], flushRejects: true });
    deps.sessionIdMap.set('d1', 'c1');
    const handler = createHolderTakeover(deps as any);
    // Must resolve (not reject) despite the flush rejection.
    await expect(handler('c1', { deviceId: 'x', device: 'X' })).resolves.toBeUndefined();
    // Each step is independently try/caught, so a flush reject does NOT abort the
    // rest — release/push/destroy still run.
    expect(deps.order).toEqual([
      'interrupt:d1:"\\u001b"',
      'flush:c1',
      'release:c1',
      'push:d1:X',     // from.device still forwarded despite the flush reject
      'destroy:d1',
    ]);
  });

  it('never throws even when the lease release rejects', async () => {
    const deps = makeDeps({ liveDesktopIds: ['d1'] });
    deps.sessionIdMap.set('d1', 'c1');
    (deps.leaseClient.release as any) = vi.fn(async () => { throw new Error('release failed'); });
    const handler = createHolderTakeover(deps as any);
    await expect(handler('c1', { deviceId: 'x', device: 'X' })).resolves.toBeUndefined();
    // push + destroy still run after a rejected release.
    expect(deps.pushMoved).toHaveBeenCalledWith('d1', 'X');
    expect(deps.sessionManager.destroySession).toHaveBeenCalledWith('d1');
  });
});
