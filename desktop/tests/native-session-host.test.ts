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

// M1: host.send() is now SYNCHRONOUS (dispatch-only) — it no longer blocks
// until the turn finishes, so tests that need to know a turn actually
// completed must wait on the transcript-event stream instead of on send()'s
// return value. Resolves once N 'turn-complete' events have been observed
// (attach-after-send is safe: JS won't yield to the async turn until the
// current synchronous call stack — including the send() call itself — empties).
function waitForTurnComplete(host: NativeSessionHost, n: number): Promise<void> {
  return new Promise((resolve) => {
    let count = 0;
    const onEvent = (e: any) => {
      if (e.type === 'turn-complete') {
        count += 1;
        if (count >= n) { host.off('transcript-event', onEvent); resolve(); }
      }
    };
    host.on('transcript-event', onEvent);
  });
}

// A ModelFactory whose FIRST call throws (HarnessSession.send() catches this
// inside its try/await and emits session-error, never a rejection) and whose
// every later call succeeds via the plain `factory` stream — proves a
// factory-throw turn doesn't strand the M1 send queue.
function throwOnceFactory() {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) throw new Error('doomed factory call');
    return factory();
  };
}

describe('NativeSessionHost', () => {
  let root: string; let host: NativeSessionHost;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-host-'));
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null, async () => null);
  });
  afterEach(async () => { await host.destroyAll(); fs.rmSync(root, { recursive: true, force: true }); });

  it('create → send → events forwarded AND persisted; getHistory replays them', async () => {
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    host.send('s-1', 'hello');       // M1: dispatch-only — wait for the turn separately
    await waitForTurnComplete(host, 1);
    await host.drain('s-1');   // wait for the append chain to settle
    expect(seen.map((e) => e.type)).toContain('turn-complete');
    const history = host.getHistory('s-1');
    expect(history).not.toBeNull();
    expect(history!.map((e) => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
    expect(history![1].data.text).toBe('Hi there');   // coalesced on disk
  });

  it('resume rebuilds a live session whose history includes the stored exchange', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    host.send('s-1', 'hello');       // M1: dispatch-only — wait for the turn separately
    await waitForTurnComplete(host, 1);
    await host.drain('s-1');
    await host.destroyAll();

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null, async () => null);
    const resumed = await host2.resume('s-1', root);
    expect(resumed).toBe(true);
    expect(host2.getHistory('s-1')!.length).toBe(3);
    host2.send('s-1', 'again');
    await waitForTurnComplete(host2, 1);
    await host2.drain('s-1');
    // Two full turns now on disk: 2 × (user-message, assistant-text, turn-complete).
    expect(host2.getHistory('s-1')!.length).toBe(6);
    await host2.destroyAll();
  });

  // Task 6: resume() takes an optional bindingOverride — the RESUME-TIME model
  // selector's pick, which must win over the persisted header binding. Ordering
  // matters: ipc-handlers.ts reads nativeHost.modelForSession() for the eager
  // loadModel() call the instant resume() returns, so the override has to be
  // applied INSIDE resume() (constructing the HarnessSession with it) rather
  // than via a post-hoc setBinding, which would race that read and load the
  // header's (possibly-absent) model instead.
  it('resume applies a binding override before anything reads the model', async () => {
    await host.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'ulid-A', modelId: 'model-A' } });
    await host.destroy('s-1');

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null);
    const resumed = await host2.resume('s-1', root, { providerId: 'local', modelId: 'model-B' });
    expect(resumed).toBe(true);
    expect(host2.modelForSession('s-1')).toBe('model-B');
    expect(host2.getBinding('s-1')).toEqual({ providerId: 'local', modelId: 'model-B' });
    await host2.destroyAll();
  });

  it('resume WITHOUT an override still uses the header binding (no local match ⇒ no substitution)', async () => {
    await host.create({ sessionId: 's-2', cwd: root, binding: { providerId: 'openrouter', modelId: 'header-model' } });
    await host.destroy('s-2');

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null);
    const resumed = await host2.resume('s-2', root);
    expect(resumed).toBe(true);
    expect(host2.modelForSession('s-2')).toBe('header-model');
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

  // M1: send() is now synchronous and returns a NativeSendResult (not a
  // Promise<boolean>) — 'not-live' replaces the old bare `false`.
  it('send to an unknown session returns failed/not-live, does not throw', () => {
    expect(host.send('ghost', 'x')).toEqual({ status: 'failed', reason: 'not-live' });
  });

  // The old 'overlapping send() does not reject: second resolves false' pin is
  // superseded by the M1 send queue below ('overlapping send queues FIFO and
  // both turns complete in order') — an overlapping send is now FIFO'd, not
  // dropped, so that assertion no longer describes the contract.

  it('destroy() while a stream is mid-emit: no throw, coherent prefix persisted', async () => {
    const store = new SessionStore(new NativeHome(root));
    const midHost = new NativeSessionHost(store, delayedFactory, async () => null, async () => null);
    const gotDelta = new Promise<void>((res) => {
      midHost.on('transcript-event', (e) => { if (e.type === 'assistant-text') res(); });
    });
    await midHost.create({ sessionId: 's-mid', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    // M1: send() dispatches synchronously now — 'sent' just means the turn
    // started, so the "no throw on destroy mid-stream" story moves to destroy().
    expect(midHost.send('s-mid', 'hi')).toEqual({ status: 'sent' });
    await gotDelta;                          // stream is now mid-emit (delta out, no finish yet)
    await expect(midHost.destroy('s-mid')).resolves.toBeUndefined(); // stop the source, drain, flush — no throw
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
    // M1: send() dispatches synchronously — 'sent' means the turn started, not
    // that resume() below is racing a still-pending promise.
    expect(orphanHost.send('s-orphan', 'hi')).toEqual({ status: 'sent' }); // resume mid-stream
    await gotDelta;

    // Resume the SAME id while it is live. This is what a takeover-orphaned
    // session did on the next open. resume() awaits destroy() of the orphan
    // underneath it, so the interrupted turn settles cleanly with no throw.
    const resumed = await orphanHost.resume('s-orphan', root);
    expect(resumed).toBe(true);

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
    const failHost = new NativeSessionHost(store, factory, async () => null, async () => null);
    await failHost.create({ sessionId: 's-f', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    failHost.send('s-f', 'hello');       // M1: dispatch-only — wait for the turn separately
    await waitForTurnComplete(failHost, 1);
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

  // ---- Task 5: the host resolves + threads a CapabilityProfile per binding ----
  describe('capability profile threading', () => {
    // Binding-aware fakes: a 'local' provider is a small local engine; anything
    // else is a cloud provider. Reach into the live session's resolved profile.
    const providerTypeFor = async (b: any) => (b.providerId === 'local' ? 'local-engine' : 'openrouter');
    const contextLengthFor = async (b: any) => (b.providerId === 'local' ? 8192 : 200_000);
    const profileOf = (h: NativeSessionHost, id: string) => ((h as any).live.get(id).session as any).profile;

    it('a small local-engine binding yields a simplified profile; a swap to cloud re-resolves to full', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, contextLengthFor as any, providerTypeFor as any);
      await h.create({ sessionId: 's', cwd: root, binding: { providerId: 'local', modelId: 'mystery-3b' } });
      expect(profileOf(h, 's').maxToolPresentation).toBe('simplified');
      expect(profileOf(h, 's').promptVariant).toBe('local-small');
      expect(profileOf(h, 's').doomLoopThreshold).toBe(2);

      // Swap to a cloud model — the re-resolved profile must flip to full posture.
      await h.setBinding('s', { providerId: 'openrouter', modelId: 'gpt-4o' });
      expect(profileOf(h, 's').maxToolPresentation).toBe('full');
      expect(profileOf(h, 's').doomLoopThreshold).toBe(3);
      await h.destroyAll();
    });
  });

  // ---- Task 12: per-session permission mode + remembered rules ----
  describe('permission mode + remembered rules', () => {
    // A host wired with a REAL PermissionStore (over the temp home) + an injected
    // app version, driving the Write-then-stop turn.
    const permHost = () => new NativeSessionHost(
      new SessionStore(new NativeHome(root)), writeFactory, async () => null, async () => null,
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
      p.send('s', 'seed a turn so there is a stored header to resume');  // full-auto → no ask
      await waitForTurnComplete(p, 1);
      await p.drain('s');
      await p.destroy('s');   // must drop the mode entry, not leak it

      // Resume the SAME id: mode must be back to the default 'ask', so the Write
      // call raises a permission ask (it would NOT under a stale full-auto).
      const p2 = permHost();
      const ask = firstAsk(p2);   // resolves with the ask's _requestId
      const resumed = await p2.resume('s', root);
      expect(resumed).toBe(true);
      const seen: any[] = []; p2.on('transcript-event', (e) => seen.push(e));
      const turnDone = waitForTurnComplete(p2, 1);
      p2.send('s', 'write a file');
      const requestId = await ask;   // resolves ONLY if the resumed session is back to 'ask'
      expect(seen.map((e) => e.type)).not.toContain('turn-complete');  // paused on the ask
      p2.respondPermission(requestId, { decision: { behavior: 'deny' } });
      await turnDone;
      await p.destroyAll();
      await p2.destroyAll();
    });

    it('full-auto auto-allows a gated tool (decide reflects the mode — no ask fires)', async () => {
      const p = permHost();
      const asks: any[] = []; p.on('hook-event', (e) => { if (e.type === 'PermissionRequest') asks.push(e); });
      const seen: any[] = []; p.on('transcript-event', (e) => seen.push(e));
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      expect(p.setPermissionMode('s', 'full-auto')).toBe('full-auto');
      p.send('s', 'write a file');   // no ask to wait on
      await waitForTurnComplete(p, 1);
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
      const turnDone = waitForTurnComplete(p, 1);
      p.send('s', 'write a file');
      const requestId = await ask;
      expect(seen.map((e) => e.type)).not.toContain('turn-complete');   // paused on the ask
      // Flip the mode mid-ask. The pending ask must be UNTOUCHED (spec pending-ask
      // ruling) — decide() only re-reads the mode on the NEXT tool.
      p.setPermissionMode('s', 'full-auto');
      await new Promise((r) => setTimeout(r, 20));
      expect(seen.map((e) => e.type)).not.toContain('turn-complete');   // still pending after the flip
      // The ORIGINAL ask resolves by its own respond(), not by the mode flip.
      expect(p.respondPermission(requestId, { decision: { behavior: 'allow' } })).toBe(true);
      await turnDone;
      expect(seen.map((e) => e.type)).toContain('turn-complete');
      await p.destroyAll();
    });

    it('Always allow persists a remembered rule via PermissionStore (host owns cwd scoping)', async () => {
      const store = new PermissionStore(new NativeHome(root));
      const p = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), writeFactory, async () => null, async () => null, store, '9.9.9',
      );
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const ask = firstAsk(p);
      const turnDone = waitForTurnComplete(p, 1);
      p.send('s', 'write a file');
      const requestId = await ask;
      // "Always allow": non-empty updatedPermissions signals the remember.
      p.respondPermission(requestId, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Write' }] });
      await turnDone;
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
        new SessionStore(new NativeHome(root)), writeFactory, async () => null, async () => null, hangingStore, '9.9.9',
      );
      const asks: any[] = []; p.on('hook-event', (e) => { if (e.type === 'PermissionRequest') asks.push(e); });
      await p.create({ sessionId: 's', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // Turn 1 (mode 'ask'): the Write raises ONE ask; respond Always-allow.
      const ask1 = firstAsk(p);
      const t1Done = waitForTurnComplete(p, 1);
      p.send('s', 'write once');
      p.respondPermission(await ask1, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Write' }] });
      await t1Done;
      expect(asks).toHaveLength(1);

      // Turn 2: the SAME gated call must NOT ask — the in-memory remembered rule
      // held even though the disk persist (remember) never resolved.
      const seen: any[] = []; p.on('transcript-event', (e) => seen.push(e));
      p.send('s', 'write again');   // no ask to wait on
      await waitForTurnComplete(p, 1);
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
      const h = new NativeSessionHost(store, factory, async () => null, async () => null);
      await h.create({ sessionId: 's1', cwd: root, binding, presetId: 'coder' });
      expect(store.readHeader('s1', root)?.harnessId).toBe('coder');
      expect(h.getPermissionMode('s1')).toBe('auto-edit');
      await h.destroyAll();
    });

    it('create defaults to assistant when no preset is given', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, async () => null, async () => null);
      await h.create({ sessionId: 's2', cwd: root, binding });
      expect(store.readHeader('s2', root)?.harnessId).toBe('assistant');
      expect(h.getPermissionMode('s2')).toBe('ask');
      await h.destroyAll();
    });

    it("resume maps a legacy 'chat' header to assistant wiring without rewriting the header", async () => {
      // Seed a stored session whose header has the legacy harnessId:'chat'.
      const store = new SessionStore(new NativeHome(root));
      await store.create({ v: 1, sessionId: 'legacy1', harnessId: 'chat', binding, cwd: root, createdAt: Date.now() });

      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null, async () => null);
      expect(await h.resume('legacy1', root)).toBe(true);
      expect(h.getHarnessId('legacy1')).toBe('assistant');
      expect(store.readHeader('legacy1', root)?.harnessId).toBe('chat'); // header untouched — mapping is read-side
      await h.destroyAll();
    });

    it('an explicit user mode flip still beats the preset default', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, async () => null, async () => null);
      await h.create({ sessionId: 's3', cwd: root, binding, presetId: 'coder' });
      h.setPermissionMode('s3', 'ask');
      expect(h.getPermissionMode('s3')).toBe('ask');
      await h.destroyAll();
    });
  });

  // ---- M1: per-session FIFO send queue + honest sent/queued/failed result ----
  describe('send queue (M1)', () => {
    // A fresh host per test, driven by delayedFactory (15ms/chunk) so a turn
    // stays genuinely in flight across several synchronous send() calls —
    // that's the window these tests exercise (queueing, the cap, interrupt,
    // destroy). Note send() itself sets entry.inFlight = true SYNCHRONOUSLY
    // before returning, so the queueing behavior below would hold even against
    // the fast `factory`; delayedFactory is used because it's what the brief
    // that authored these scenarios specifies and it makes the in-flight
    // window robust against future timing changes.
    let host: NativeSessionHost;
    let id: string;

    beforeEach(async () => {
      host = new NativeSessionHost(new SessionStore(new NativeHome(root)), delayedFactory, async () => null);
      id = 'q-1';
      await host.create({ sessionId: id, cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    });
    afterEach(async () => { await host.destroyAll(); });

    it('send to an unknown session returns failed/not-live', () => {
      expect(host.send('ghost', 'x')).toEqual({ status: 'failed', reason: 'not-live' });
    });

    it('overlapping send queues FIFO and both turns complete in order', async () => {
      const events: string[] = [];
      host.on('transcript-event', (e) => { if (e.type === 'user-message') events.push(e.data.text); });
      const r1 = host.send(id, 'first');
      const r2 = host.send(id, 'second');
      expect(r1).toEqual({ status: 'sent' });
      // Cancel/edit (M1 follow-up): a queued ack now carries a host-minted id
      // so the renderer can target this exact entry with removeQueued() later.
      expect(r2.status).toBe('queued');
      expect(typeof (r2 as { queueId: string }).queueId).toBe('string');
      expect((r2 as { queueId: string }).queueId.length).toBeGreaterThan(0);
      await waitForTurnComplete(host, 2);
      expect(events).toEqual(['first', 'second']); // user-message for 'second' fires only when drained
    });

    it('refuses honestly past the queue cap', () => {
      host.send(id, 'turn'); // in flight
      for (let i = 0; i < 10; i++) expect(host.send(id, `q${i}`).status).toBe('queued');
      expect(host.send(id, 'overflow')).toEqual({ status: 'failed', reason: 'queue-full' });
    });

    // ---- Cancel/edit queued messages (Task 11) ----
    describe('removeQueued', () => {
      it('removes a queued entry mid-queue — the drain skips it and it never emits user-message', async () => {
        const events: string[] = [];
        host.on('transcript-event', (e) => { if (e.type === 'user-message') events.push(e.data.text); });
        host.send(id, 'first');                                  // dispatched now
        const rA = host.send(id, 'a') as { status: 'queued'; queueId: string };
        const rB = host.send(id, 'b') as { status: 'queued'; queueId: string };
        expect(host.removeQueued(id, rA.queueId)).toBe(true);
        await waitForTurnComplete(host, 2);                      // 'first' + 'b' — 'a' was cut
        expect(events).toEqual(['first', 'b']);
        expect(rB.queueId).not.toBe(rA.queueId);
      });

      it('returns false for an id that already drained (shift() beat the removal)', async () => {
        host.send(id, 'first');
        const rA = host.send(id, 'a') as { status: 'queued'; queueId: string };
        await waitForTurnComplete(host, 2); // both turns finish — 'a' has been shift()'d and sent
        expect(host.removeQueued(id, rA.queueId)).toBe(false);
      });

      it('returns false on a dead/unknown session — never throws', () => {
        expect(host.removeQueued('ghost-session', 'whatever')).toBe(false);
      });

      it('returns false for an id that was never queued', () => {
        host.send(id, 'first'); // in flight, nothing queued yet
        expect(host.removeQueued(id, 'not-a-real-id')).toBe(false);
      });
    });

    it('interrupt aborts the current turn only — the queue still drains (pinned semantics)', async () => {
      const events: any[] = [];
      host.on('transcript-event', (e) => events.push(e));
      host.send(id, 'long');           // delayedFactory turn
      host.send(id, 'queued-survivor');
      // M1 ordering fix (2026-07-22): send() now defers the turn dispatch one
      // macrotask (setImmediate) so the invoke reply beats the transcript
      // event. Interrupting in the SAME tick as send() would race that gap
      // and no-op (the abort controller doesn't exist until the deferred turn
      // actually starts — see the WHY comment on send()); a real user's stop
      // click is always at least one tick after their send, so wait a
      // macrotask before interrupting so the turn is genuinely in flight.
      await new Promise((r) => setImmediate(r));
      host.interrupt(id);
      await waitForTurnComplete(host, 1);    // survivor's turn
      // Transcript contains user-interrupt for turn 1, then user-message 'queued-survivor'.
      const types = events.map((e) => e.type);
      expect(types).toContain('user-interrupt');
      expect(types).toContain('turn-complete');
      const interruptIdx = types.indexOf('user-interrupt');
      const survivorMsgIdx = events.findIndex((e) => e.type === 'user-message' && e.data.text === 'queued-survivor');
      expect(survivorMsgIdx).toBeGreaterThan(interruptIdx); // the queue only drains AFTER the interrupt settles turn 1
    });

    it('a failed turn (factory throw) does not strand the queue', async () => {
      const errHost = new NativeSessionHost(new SessionStore(new NativeHome(root)), throwOnceFactory(), async () => null);
      await errHost.create({ sessionId: 'e-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const types: string[] = [];
      errHost.on('transcript-event', (e) => types.push(e.type));
      const r1 = errHost.send('e-1', 'doomed');
      const r2 = errHost.send('e-1', 'after-error');
      expect(r1).toEqual({ status: 'sent' });
      expect(r2.status).toBe('queued'); // queueId is a fresh randomUUID — not asserted verbatim here
      await waitForTurnComplete(errHost, 1); // 'after-error' produced a turn-complete despite turn 1 erroring
      expect(types).toContain('session-error'); // turn 1 (doomed) errored, not stranded the queue
      expect(types).toContain('turn-complete');  // turn 2 (after-error) still ran and completed
      await errHost.destroyAll();
    });

    it('destroy mid-turn drops queued sends without unhandled rejection', async () => {
      const events: any[] = [];
      host.on('transcript-event', (e) => events.push(e));
      host.send(id, 'long');
      host.send(id, 'never-sent');
      await expect(host.destroy(id)).resolves.toBeUndefined(); // no throw
      expect(events.some((e) => e.type === 'user-message' && e.data.text === 'never-sent')).toBe(false);
    });

    // Fix for the ack-vs-transcript ordering race: send() now defers runTurns()
    // one macrotask (setImmediate) past its synchronous return so the invoke
    // reply beats the transcript-event. This opens a one-tick gap where a
    // destroy() landing in the SAME tick as send() (before the setImmediate
    // callback fires) races the still-scheduled turn: destroy() removes the
    // session's listeners synchronously, so when runTurns eventually calls
    // entry.session.send() the turn still runs (see the WHY comment on
    // send()) but is a zombie — no listener is left to forward or persist
    // anything. Must not throw and must not emit for the dropped text.
    it('destroy in the same tick as send() drops the turn without unhandled rejection', async () => {
      const events: any[] = [];
      host.on('transcript-event', (e) => events.push(e));
      host.send(id, 'same-tick');
      await expect(host.destroy(id)).resolves.toBeUndefined(); // no throw, no unhandled rejection
      // Give the deferred runTurns (setImmediate) + the now-zombie turn's
      // delayed stream room to play out in the background — it must stay
      // silent (destroy() already tore down the session's listeners).
      await new Promise((r) => setTimeout(r, 150));
      expect(events.some((e) => e.type === 'user-message' && e.data.text === 'same-tick')).toBe(false);
    });
  });

  // ---- Task 9: quiesce (takeover/teardown) ----
  // quiesce is deliberately STRONGER than interrupt(): interrupt aborts only the
  // current turn and lets the M1 FIFO queue keep draining (pinned above:
  // "interrupt aborts the current turn only"). For a takeover that is WRONG — a
  // queued message would start a NEW turn AFTER the flush and append past it,
  // corrupting the transcript the requester is about to pull. quiesce guarantees
  // the opposite: after it resolves, NO further appends happen until a new send.
  describe('quiesce (Task 9 — takeover/teardown)', () => {
    it('quiesce clears the queue, aborts mid-stream, and no appends occur after it resolves', async () => {
      const store = new SessionStore(new NativeHome(root));
      const appendSpy = vi.spyOn(store, 'append');
      const qHost = new NativeSessionHost(store, delayedFactory, async () => null);
      await qHost.create({ sessionId: 'qz', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      qHost.send('qz', 'long');              // slow (delayedFactory) turn in flight
      qHost.send('qz', 'queued-survivor');   // FIFO'd behind it — must NEVER run
      await new Promise((r) => setImmediate(r)); // let the first turn genuinely start

      await qHost.quiesce('qz');
      const appendsAtQuiesce = appendSpy.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80)); // the queue would have drained by now
      expect(appendSpy.mock.calls.length).toBe(appendsAtQuiesce); // queued-survivor never ran

      // The survivor's user-message never reached disk (its turn was cut before it started).
      const survivorMsgs = store.readEvents('qz', root)
        .filter((e) => e.type === 'user-message' && e.data.text === 'queued-survivor');
      expect(survivorMsgs).toHaveLength(0);
      await qHost.destroyAll();
    });

    it('quiesce catches a same-tick send (setImmediate defer) — the turn is aborted, never completed', async () => {
      const store = new SessionStore(new NativeHome(root));
      const appendSpy = vi.spyOn(store, 'append');
      const qHost = new NativeSessionHost(store, delayedFactory, async () => null);
      await qHost.create({ sessionId: 'qz2', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      // send() and quiesce() in the SAME synchronous tick. send() defers its
      // runTurns dispatch one macrotask (setImmediate), so an interrupt that ran
      // in this same tick would MISS the turn (the AbortController doesn't exist
      // until runTurns actually starts it). quiesce awaits one macrotask FIRST, so
      // it catches the just-dispatched turn and aborts it.
      qHost.send('qz2', 'same-tick');
      await qHost.quiesce('qz2');

      const appendsAtQuiesce = appendSpy.mock.calls.length;
      await new Promise((r) => setTimeout(r, 80));
      expect(appendSpy.mock.calls.length).toBe(appendsAtQuiesce); // no post-quiesce appends
      // Aborted mid-stream: the turn must NOT have reached turn-complete.
      const types = store.readEvents('qz2', root).map((e) => e.type);
      expect(types).not.toContain('turn-complete');
      await qHost.destroyAll();
    });
  });
});
