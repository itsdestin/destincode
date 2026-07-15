import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

// RAW V4 stream-part shapes (see harness-session.test.ts): deltas carry `delta`, usage is nested.
const CHUNKS = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'p1' },
  { type: 'text-delta', id: 'p1', delta: 'Hi there' },
  { type: 'text-end', id: 'p1' },
  { type: 'finish', finishReason: { unified: 'stop' }, usage: { inputTokens: { total: 3 }, outputTokens: { total: 2 } } },
];
const factory = async () => new MockLanguageModelV4({ doStream: async () => ({ stream: simulateReadableStream({ chunks: CHUNKS }) }) }) as any;

// A ReadableStream that trickles chunks with a per-chunk delay so a turn can be
// caught mid-stream (for the destroy-while-streaming test). The enqueue loop is
// guarded so a mid-stream cancel (abort → iterator.return) doesn't surface as an
// unhandled rejection.
function delayedStream(chunks: any[], delayMs: number): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      try {
        for (const c of chunks) {
          await new Promise((r) => setTimeout(r, delayMs));
          controller.enqueue(c);
        }
        controller.close();
      } catch { /* stream cancelled mid-emit — expected on abort */ }
    },
  });
}
const delayedFactory = async () => new MockLanguageModelV4({ doStream: async () => ({ stream: delayedStream(CHUNKS, 15) }) }) as any;

describe('NativeSessionHost', () => {
  let root: string; let host: NativeSessionHost;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-host-'));
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null);
  });
  afterEach(async () => { await host.destroyAll(); fs.rmSync(root, { recursive: true, force: true }); });

  it('create → send → events forwarded AND persisted; getHistory replays them', async () => {
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await host.send('s-1', 'hello');
    await host.drain('s-1');   // wait for the append chain to settle
    expect(seen.map((e) => e.type)).toContain('turn-complete');
    const history = host.getHistory('s-1');
    expect(history).not.toBeNull();
    expect(history!.map((e) => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
    expect(history![1].data.text).toBe('Hi there');   // coalesced on disk
  });

  it('resume rebuilds a live session whose history includes the stored exchange', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await host.send('s-1', 'hello');
    await host.drain('s-1');
    await host.destroyAll();

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null);
    const resumed = await host2.resume('s-1', root);
    expect(resumed).toBe(true);
    expect(host2.getHistory('s-1')!.length).toBe(3);
    await host2.send('s-1', 'again');
    await host2.drain('s-1');
    // Two full turns now on disk: 2 × (user-message, assistant-text, turn-complete).
    expect(host2.getHistory('s-1')!.length).toBe(6);
    await host2.destroyAll();
  });

  it('list() surfaces sessions for the Resume Browser with provider tag', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const rows = host.list();
    expect(rows[0]).toMatchObject({ sessionId: 's-1', provider: 'native' });
  });

  it('getHistory returns null for unknown/non-native sessions (replay falls through to CC)', () => {
    expect(host.getHistory('nope')).toBeNull();
  });

  it('send to an unknown session returns false, does not throw', async () => {
    expect(await host.send('ghost', 'x')).toBe(false);
  });

  it('overlapping send() does not reject: second resolves false, first turn completes', async () => {
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    // Fire two sends without awaiting the first. HarnessSession.send() hard-throws
    // on re-entrancy; the host must swallow that so the fire-and-forget callers
    // (void nativeHost.send) can't produce an unhandledRejection.
    const p1 = host.send('s-1', 'first');
    const p2 = host.send('s-1', 'second');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe(true);
    expect(r2).toBe(false); // overlapping call dropped, not thrown
    await host.drain('s-1');
    expect(seen.map((e) => e.type)).toContain('turn-complete'); // first turn still completed
  });

  it('destroy() while a stream is mid-emit: no throw, coherent prefix persisted', async () => {
    const store = new SessionStore(new NativeHome(root));
    const midHost = new NativeSessionHost(store, delayedFactory, async () => null);
    const gotDelta = new Promise<void>((res) => {
      midHost.on('transcript-event', (e) => { if (e.type === 'assistant-text') res(); });
    });
    await midHost.create({ sessionId: 's-mid', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const p = midHost.send('s-mid', 'hi');  // don't await — destroy mid-stream
    await gotDelta;                          // stream is now mid-emit (delta out, no finish yet)
    await midHost.destroy('s-mid');          // stop the source, drain, flush
    await expect(p).resolves.toBe(true);     // send resolved cleanly (no rejection)
    // A coherent prefix is on disk — no torn/partial turn, no premature turn-complete.
    const events = store.readEvents('s-mid', root);
    expect(events.map((e) => e.type)).toEqual(['user-message', 'assistant-text']);
    await midHost.destroyAll();
  });

  it('a failed append does not wedge the chain — later events still persist', async () => {
    const store = new SessionStore(new NativeHome(root));
    const realAppend = store.append.bind(store);
    let threw = false;
    // Reject exactly once, on the assistant-text append; everything after must
    // still reach disk.
    vi.spyOn(store, 'append').mockImplementation(async (cwd, event) => {
      if (!threw && event.type === 'assistant-text') { threw = true; throw new Error('disk hiccup'); }
      return realAppend(cwd, event);
    });
    const failHost = new NativeSessionHost(store, factory, async () => null);
    await failHost.create({ sessionId: 's-f', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    await failHost.send('s-f', 'hello');
    await failHost.drain('s-f');
    expect(threw).toBe(true);
    const types = failHost.getHistory('s-f')!.map((e) => e.type);
    expect(types).toContain('user-message');   // persisted before the failure
    expect(types).toContain('turn-complete');  // chain kept going after the failure
    await failHost.destroyAll();
  });

  // ---- model ref-count (#1: unload a model when no session uses it) ----
  describe('model ref-count', () => {
    it('fires onModelReleased ONLY when the last session for a model is destroyed', async () => {
      const released: string[] = [];
      host.setModelReleasedHandler((id) => released.push(id));
      await host.create({ sessionId: 'a', cwd: root, binding: { providerId: 'local', modelId: 'M1' } });
      await host.create({ sessionId: 'b', cwd: root, binding: { providerId: 'local', modelId: 'M1' } });
      expect(host.sessionsForModel('M1').sort()).toEqual(['a', 'b']);

      await host.destroy('a');            // one of two → M1 still in use
      expect(released).toEqual([]);
      expect(host.sessionsForModel('M1')).toEqual(['b']);

      await host.destroy('b');            // last one → release M1
      expect(released).toEqual(['M1']);
      expect(host.sessionsForModel('M1')).toEqual([]);
    });

    it('setBinding swaps the ref-count: releases the old model, retains the new', async () => {
      const released: string[] = [];
      host.setModelReleasedHandler((id) => released.push(id));
      await host.create({ sessionId: 's', cwd: root, binding: { providerId: 'local', modelId: 'OLD' } });
      expect(host.modelForSession('s')).toBe('OLD');

      await host.setBinding('s', { providerId: 'local', modelId: 'NEW' });
      expect(released).toEqual(['OLD']);           // OLD had no other session → released
      expect(host.modelForSession('s')).toBe('NEW');
      expect(host.sessionsForModel('NEW')).toEqual(['s']);
    });

    it('modelForSession is null for an unknown session', () => {
      expect(host.modelForSession('nope')).toBeNull();
    });
  });
});
