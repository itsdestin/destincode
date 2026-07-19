import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { PermissionStore } from '../src/main/harness/permission-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { scriptedModel, stream, textChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';

// One turn, two steps: step 1 calls the (gated) Write tool; step 2 — after the
// tool result — stops with text. A FRESH instance per factory call so the
// per-step counter resets each turn. Write is chosen because it is permission-
// gated in 'ask' mode but auto-allowed in 'full-auto' (rulesForMode).
const writeThenStop = () => scriptedModel([
  stream(toolCallChunk('c1', 'Write', { file_path: 'note.txt', content: 'hi' }), finishChunk('tool-calls')),
  stream(...textChunks('t', 'done'), finishChunk('stop')),
]);
const writeFactory = async () => writeThenStop() as any;
// Resolves with the ask's _requestId the first time the host re-emits a native
// PermissionRequest (broker → host 'hook-event').
function firstAsk(h: NativeSessionHost): Promise<string> {
  return new Promise((res) => {
    const on = (e: any) => { if (e.type === 'PermissionRequest') { h.off('hook-event', on); res(e.payload._requestId); } };
    h.on('hook-event', on);
  });
}

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

  // SINGLE-WRITER GUARD (2026-07-18, investigation Break 4). resume() used to
  // wire a fresh HarnessSession without touching an existing live one. wire()
  // overwrites this.live's entry, but the ORPHAN's transcript-event listener
  // closes over the OLD entry — so it kept appending to the same JSONL, giving
  // two writers unordered against each other (native-home.ts:5-7 says session
  // files are single-writer by design, which is why they carry no file lock).
  //
  // Asserts on APPEND CALLS, not on map state: the map entry is not what keeps
  // the orphan alive, so a map-shaped assertion would pass on the broken code.
  it('resume() on an id that is still live destroys the orphan — no second writer', async () => {
    const store = new SessionStore(new NativeHome(root));
    const appends: string[] = [];
    const realAppend = store.append.bind(store);
    vi.spyOn(store, 'append').mockImplementation(async (cwd, event) => {
      appends.push(event.type);
      return realAppend(cwd, event);
    });
    // delayedFactory trickles chunks, so the first turn is genuinely mid-stream
    // when resume lands — the exact window where an orphan does its damage.
    const orphanHost = new NativeSessionHost(store, delayedFactory, async () => null);
    const gotDelta = new Promise<void>((res) => {
      orphanHost.on('transcript-event', (e) => { if (e.type === 'assistant-text') res(); });
    });
    await orphanHost.create({ sessionId: 's-orphan', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const p = orphanHost.send('s-orphan', 'hi'); // don't await — resume mid-stream
    await gotDelta;

    // Resume the SAME id while it is live. This is what a takeover-orphaned
    // session did on the next open.
    const resumed = await orphanHost.resume('s-orphan', root);
    expect(resumed).toBe(true);
    await expect(p).resolves.toBe(true); // the interrupted send still settles cleanly

    // Everything the old session could still have written must already be done:
    // resume() awaits destroy(), which aborts the stream, drains the append chain
    // and flushes the open part. Give the old stream's remaining chunk delays
    // (15ms each) generous room to fire if the abort did NOT take.
    const afterResume = appends.length;
    await new Promise((r) => setTimeout(r, 120));
    expect(appends.length).toBe(afterResume); // the orphan wrote nothing more

    // And the file is a coherent single-writer transcript, not an interleave.
    const events = store.readEvents('s-orphan', root);
    expect(events.map((e) => e.type)).toEqual(['user-message', 'assistant-text']);
    await orphanHost.destroyAll();
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

  // ---- Task 12: per-session permission mode + remembered rules ----
  describe('permission mode + remembered rules', () => {
    // A host wired with a REAL PermissionStore (over the temp home) + an injected
    // app version, driving the Write-then-stop turn.
    const permHost = () => new NativeSessionHost(
      new SessionStore(new NativeHome(root)), writeFactory, async () => null,
      new PermissionStore(new NativeHome(root)), '9.9.9',
    );

    it('setPermissionMode returns the applied mode; rejects unknown modes loudly', () => {
      expect(host.setPermissionMode('s', 'auto-edit')).toBe('auto-edit');
      expect(host.setPermissionMode('s', 'full-auto')).toBe('full-auto');
      // An unknown mode string is a renderer/wiring bug — throw, don't store garbage.
      expect(() => host.setPermissionMode('s', 'bogus' as any)).toThrow(/Unknown native permission mode/);
    });

    it('destroy resets the per-session mode: a resumed same-id session is back to ask', async () => {
      const p = permHost();
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      p.setPermissionMode('s', 'full-auto');
      await p.send('s', 'seed a turn so there is a stored header to resume');  // full-auto → no ask, resolves
      await p.drain('s');
      await p.destroy('s');   // must drop the mode entry, not leak it

      // Resume the SAME id: mode must be back to the default 'ask', so the Write
      // call raises a permission ask (it would NOT under a stale full-auto).
      const p2 = permHost();
      const ask = firstAsk(p2);   // resolves with the ask's _requestId
      const resumed = await p2.resume('s', root);
      expect(resumed).toBe(true);
      const seen: any[] = []; p2.on('transcript-event', (e) => seen.push(e));
      const turn = p2.send('s', 'write a file');
      const requestId = await ask;   // resolves ONLY if the resumed session is back to 'ask'
      expect(seen.map((e) => e.type)).not.toContain('turn-complete');  // paused on the ask
      p2.respondPermission(requestId, { decision: { behavior: 'deny' } });
      await turn;
      await p.destroyAll();
      await p2.destroyAll();
    });

    it('full-auto auto-allows a gated tool (decide reflects the mode — no ask fires)', async () => {
      const p = permHost();
      const asks: any[] = []; p.on('hook-event', (e) => { if (e.type === 'PermissionRequest') asks.push(e); });
      const seen: any[] = []; p.on('transcript-event', (e) => seen.push(e));
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      expect(p.setPermissionMode('s', 'full-auto')).toBe('full-auto');
      await p.send('s', 'write a file');   // resolves — no ask to wait on
      expect(asks).toHaveLength(0);                                  // full-auto → no permission ask
      expect(seen.map((e) => e.type)).toContain('turn-complete');
      await p.destroyAll();
    });

    it('a mode flip does NOT disturb a pending ask; it resolves by its own respond()', async () => {
      const p = permHost();
      const seen: any[] = []; p.on('transcript-event', (e) => seen.push(e));
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      // Default mode 'ask' → the Write call raises an ask and the turn pauses.
      // Don't await send() — it won't resolve until we respond.
      const ask = firstAsk(p);
      const turn = p.send('s', 'write a file');
      const requestId = await ask;
      expect(seen.map((e) => e.type)).not.toContain('turn-complete');   // paused on the ask
      // Flip the mode mid-ask. The pending ask must be UNTOUCHED (spec pending-ask
      // ruling) — decide() only re-reads the mode on the NEXT tool.
      p.setPermissionMode('s', 'full-auto');
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.map((e) => e.type)).not.toContain('turn-complete');   // still pending after the flip
      // The ORIGINAL ask resolves by its own respond(), not by the mode flip.
      expect(p.respondPermission(requestId, { decision: { behavior: 'allow' } })).toBe(true);
      await turn;
      expect(seen.map((e) => e.type)).toContain('turn-complete');
      await p.destroyAll();
    });

    it('Always allow persists a remembered rule via PermissionStore (host owns cwd scoping)', async () => {
      const store = new PermissionStore(new NativeHome(root));
      const p = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), writeFactory, async () => null, store, '9.9.9',
      );
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const ask = firstAsk(p);
      const turn = p.send('s', 'write a file');
      const requestId = await ask;
      // "Always allow": non-empty updatedPermissions signals the remember.
      p.respondPermission(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Write' }] });
      await turn;
      // remember() is fire-and-forget off the turn (mutateJson under a file lock);
      // poll until the persisted rule appears.
      let rules: any[] = [];
      for (let i = 0; i < 50; i++) {
        rules = await store.rulesFor(root);
        if (rules.some((r) => r.tool === 'Write' && r.action === 'allow')) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(rules.some((r) => r.tool === 'Write' && r.action === 'allow')).toBe(true);
      await p.destroyAll();
    });

    it('Always-allow sticks in-session even when the disk persist never resolves (in-memory union)', async () => {
      // A store whose remember() NEVER resolves (persist hang/failure) and whose
      // rulesFor never reflects the rule — so ONLY the in-memory union can make
      // the Always-allow stick.
      const hangingStore = {
        rulesFor: async () => [] as any[],
        remember: () => new Promise<void>(() => { /* never resolves */ }),
      };
      const p = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), writeFactory, async () => null, hangingStore, '9.9.9',
      );
      const asks: any[] = []; p.on('hook-event', (e) => { if (e.type === 'PermissionRequest') asks.push(e); });
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // Turn 1 (mode 'ask'): the Write raises ONE ask; respond Always-allow.
      const ask1 = firstAsk(p);
      const t1 = p.send('s', 'write once');
      p.respondPermission(await ask1, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Write' }] });
      await t1;
      expect(asks).toHaveLength(1);

      // Turn 2: the SAME gated call must NOT ask — the in-memory remembered rule
      // held even though the disk persist (remember) never resolved.
      const seen: any[] = []; p.on('transcript-event', (e) => seen.push(e));
      await p.send('s', 'write again');   // resolves — no ask to wait on
      expect(asks).toHaveLength(1);       // still just the first ask (no re-ask)
      expect(seen.map((e) => e.type)).toContain('turn-complete');
      await p.destroyAll();
    });
  });

  // ---- Task 13: preset selection + seeding + legacy 'chat' mapping ----
  describe('preset wiring', () => {
    const binding = { providerId: 'openrouter', modelId: 'm' } as const;

    it('create stamps the chosen preset in the header and seeds its default mode', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, async () => null);
      await h.create({ sessionId: 's1', cwd: root, binding, presetId: 'coder' });
      expect(store.readHeader('s1', root)?.harnessId).toBe('coder');
      expect(h.getPermissionMode('s1')).toBe('auto-edit');
      await h.destroyAll();
    });

    it('create defaults to assistant when no preset is given', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, async () => null);
      await h.create({ sessionId: 's2', cwd: root, binding });
      expect(store.readHeader('s2', root)?.harnessId).toBe('assistant');
      expect(h.getPermissionMode('s2')).toBe('ask');
      await h.destroyAll();
    });

    it("resume maps a legacy 'chat' header to assistant wiring without rewriting the header", async () => {
      // Seed a stored session whose header has the legacy harnessId:'chat'.
      const store = new SessionStore(new NativeHome(root));
      await store.create({ v: 1, sessionId: 'legacy1', harnessId: 'chat', binding, cwd: root, createdAt: Date.now() });

      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null);
      expect(await h.resume('legacy1', root)).toBe(true);
      expect(h.getHarnessId('legacy1')).toBe('assistant');
      expect(store.readHeader('legacy1', root)?.harnessId).toBe('chat'); // header untouched — mapping is read-side
      await h.destroyAll();
    });

    it('an explicit user mode flip still beats the preset default', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, async () => null);
      await h.create({ sessionId: 's3', cwd: root, binding, presetId: 'coder' });
      h.setPermissionMode('s3', 'ask');
      expect(h.getPermissionMode('s3')).toBe('ask');
      await h.destroyAll();
    });
  });
});
