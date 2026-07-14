// Plan 2b Task 9 — pins the requester-side takeover flow (createRequesterTakeover).
// When the user resumes a conversation another device holds, THIS device asks the
// holder to hand off, polls the lease until it frees (or times out at 10s), then
// pulls the peer's final turn and acquires the lease. All collaborators are
// injected fakes; the poll loop is driven with fake timers. The flow must NEVER
// throw (spec §3 never-block) — errors surface as {outcome:'error'}/{ok:false}.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequesterTakeover } from '../src/main/conversations/takeover';

// Build a deps bundle whose success-path fakes push a label into a shared order
// log so tests can assert BOTH which steps ran and in WHAT order.
function makeDeps(opts: {
  // query returns these results in sequence; the last one repeats forever.
  queryResults: Array<{ held: boolean; device?: string }>;
  selfDevice?: string;
  takeoverThrows?: boolean;
  queryThrows?: boolean;
  forceThrows?: boolean;
}) {
  const order: string[] = [];
  let qi = 0;
  const deps = {
    order,
    leaseClient: {
      takeover: vi.fn(async (sid: string) => {
        order.push(`takeover:${sid}`);
        if (opts.takeoverThrows) throw new Error('takeover blew up');
      }),
      query: vi.fn(async (_sid: string) => {
        if (opts.queryThrows) throw new Error('query blew up');
        const r = opts.queryResults[Math.min(qi, opts.queryResults.length - 1)];
        qi += 1;
        return r;
      }),
      acquire: vi.fn(async (sid: string) => { order.push(`acquire:${sid}`); }),
    },
    syncNow: vi.fn(async () => { order.push('syncNow'); }),
    materializeOne: vi.fn(async (sid: string) => { order.push(`materialize:${sid}`); }),
    forceAcquire: vi.fn(async (sid: string) => {
      order.push(`force:${sid}`);
      if (opts.forceThrows) throw new Error('force blew up');
    }),
    // Real timer-backed delay so vi.advanceTimersByTimeAsync drives the poll.
    delay: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    selfDevice: opts.selfDevice ?? 'This-Device',
  };
  return deps;
}

describe('createRequesterTakeover', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('takeover: holder releases after 2 polls -> acquired, in order syncNow -> materialize -> acquire', async () => {
    // held twice (holder hasn't released yet), then free.
    const deps = makeDeps({
      queryResults: [{ held: true, device: 'Laptop-B' }, { held: true, device: 'Laptop-B' }, { held: false }],
    });
    const flow = createRequesterTakeover(deps as any);
    const p = flow.takeover('c1');
    // Drive the two 1s poll gaps.
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await p;
    expect(res).toEqual({ outcome: 'acquired' });
    // takeover first, then the free-path trio in the required order.
    expect(deps.order).toEqual(['takeover:c1', 'syncNow', 'materialize:c1', 'acquire:c1']);
    expect(deps.leaseClient.query).toHaveBeenCalledTimes(3);
  });

  it('takeover: already free on the FIRST query -> acquired fast without waiting a poll', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }] });
    const flow = createRequesterTakeover(deps as any);
    // No timer advance — the free check happens BEFORE the first sleep.
    const res = await flow.takeover('c1');
    expect(res).toEqual({ outcome: 'acquired' });
    expect(deps.leaseClient.query).toHaveBeenCalledTimes(1);
    expect(deps.order).toEqual(['takeover:c1', 'syncNow', 'materialize:c1', 'acquire:c1']);
  });

  it('takeover: a lease held by US (device === selfDevice) counts as free', async () => {
    const deps = makeDeps({ queryResults: [{ held: true, device: 'This-Device' }], selfDevice: 'This-Device' });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.takeover('c1');
    expect(res).toEqual({ outcome: 'acquired' });
    expect(deps.order).toContain('acquire:c1');
  });

  it('takeover: holder never releases -> timeout after 10s (no acquire)', async () => {
    const deps = makeDeps({ queryResults: [{ held: true, device: 'Laptop-B' }] });
    const flow = createRequesterTakeover(deps as any);
    const p = flow.takeover('c1');
    // Advance well past MAX_MS so every poll interval elapses and the loop exits.
    await vi.advanceTimersByTimeAsync(11_000);
    const res = await p;
    expect(res).toEqual({ outcome: 'timeout' });
    expect(deps.leaseClient.acquire).not.toHaveBeenCalled();
    expect(deps.syncNow).not.toHaveBeenCalled();
    expect(deps.materializeOne).not.toHaveBeenCalled();
  });

  it('takeover: takeover() throwing -> error', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }], takeoverThrows: true });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.takeover('c1');
    expect(res).toEqual({ outcome: 'error' });
  });

  it('takeover: query() throwing -> error', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }], queryThrows: true });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.takeover('c1');
    expect(res).toEqual({ outcome: 'error' });
  });

  it('force: forceAcquire + syncNow + materialize -> ok, in order', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }] });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.force('c1');
    expect(res).toEqual({ ok: true });
    expect(deps.order).toEqual(['force:c1', 'syncNow', 'materialize:c1']);
  });

  it('force: forceAcquire throwing -> {ok:false}', async () => {
    const deps = makeDeps({ queryResults: [{ held: false }], forceThrows: true });
    const flow = createRequesterTakeover(deps as any);
    const res = await flow.force('c1');
    expect(res).toEqual({ ok: false });
  });
});
