import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { PermissionStore } from '../src/main/harness/permission-store';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { scriptedModel, stream, textChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';

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
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null);
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

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null);
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

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null);
    const resumed = await host2.resume('s-1', root, { providerId: 'local', modelId: 'model-B' });
    expect(resumed).toBe(true);
    expect(host2.modelForSession('s-1')).toBe('model-B');
    expect(host2.getBinding('s-1')).toEqual({ providerId: 'local', modelId: 'model-B' });
    await host2.destroyAll();
  });

  it('resume WITHOUT an override still uses the header binding (no local match ⇒ no substitution)', async () => {
    await host.create({ sessionId: 's-2', cwd: root, binding: { providerId: 'openrouter', modelId: 'header-model' } });
    await host.destroy('s-2');

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null);
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
    const midHost = new NativeSessionHost(store, delayedFactory, async () => null, async () => null, async () => null);
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
    const orphanHost = new NativeSessionHost(store, delayedFactory, async () => null, async () => null, async () => null);
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
    const failHost = new NativeSessionHost(store, factory, async () => null, async () => null, async () => null);
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

  // ---- Task 4: the host tears down the pooled MCP connections at the SAME
  // app-quit path as its own sessions (destroyAll() is confirmed the real
  // teardown method — invoked by ipc-handlers.ts cleanup() from main.ts's
  // window-all-closed handler). Without this, an MCP server subprocess would
  // outlive the app.
  describe('MCP teardown (Task 4)', () => {
    it('destroyAll() also tears down the pooled MCP connections', async () => {
      const mcpDestroyAll = vi.fn(async () => {});
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null,
        undefined, undefined, undefined, undefined,
        { destroyAll: mcpDestroyAll },
      );
      await h.destroyAll();
      expect(mcpDestroyAll).toHaveBeenCalledTimes(1);
    });

    it('destroyAll() works fine with no mcpManager wired (pre-Task-6 wiring)', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null);
      await expect(h.destroyAll()).resolves.toBeUndefined();
    });
  });

  // ---- Task 6: the host is the ONE production caller of McpManager's
  // acquire()/release() — create()/resume() acquire this session's servers
  // and thread them into the HarnessSession; destroy() releases the hold. ----
  describe('MCP session wiring (Task 6)', () => {
    const fakeServer = (id: string) => ({
      id, label: id, tools: [], call: async () => ({ text: 'ok', isError: false }),
    });

    // A lease whose release() is a spy — the manager's release is no longer a
    // method on the manager, so the host can only give a hold back through the
    // object acquire() returned. See McpLease in mcp-manager.ts.
    const fakeLease = (servers: any[], release = vi.fn(async () => {})) => ({ servers, release });

    it('create() acquires this session\'s MCP servers and threads them into the session', async () => {
      const wanted = [fakeServer('srv0')];
      const acquire = vi.fn(async () => fakeLease(wanted));
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      expect(acquire).toHaveBeenCalledWith('s-1');
      const session = (h as any).live.get('s-1').session;
      expect(session.opts.mcpServers).toBe(wanted);
    });

    it('resume() acquires MCP servers for the resumed session', async () => {
      const wanted = [fakeServer('srv1')];
      const acquire = vi.fn(async () => fakeLease(wanted));
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      h.send('s-1', 'hello');
      await waitForTurnComplete(h, 1);
      await h.drain('s-1');
      await h.destroyAll();
      acquire.mockClear();

      const h2 = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      const resumed = await h2.resume('s-1', root);
      expect(resumed).toBe(true);
      expect(acquire).toHaveBeenCalledWith('s-1');
      const session = (h2 as any).live.get('s-1').session;
      expect(session.opts.mcpServers).toBe(wanted);
      await h2.destroyAll();
    });

    it('destroy() releases this session\'s hold on MCP servers', async () => {
      const release = vi.fn(async () => {});
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire: async () => fakeLease([], release) },
      );
      await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      await h.destroy('s-1');
      expect(release).toHaveBeenCalledTimes(1);
    });

    // Destroy → resume → destroy across two generations of ONE session id:
    // each destroy releases exactly one lease, the right one, exactly once.
    //
    // WHAT THIS DOES NOT PROVE: it does not discriminate a per-entry lease from
    // a sessionId-keyed "most recent lease" map — that mutation was run and
    // this test still passed, because sequentially the most-recent lease IS the
    // correct one. The generation-discrimination that IS load-bearing lives in
    // McpManager and is mutation-tested there (mcp-manager.test.ts, "the
    // outgoing generation of a resumed session..."). What this pins is the
    // plainer contract: a resume acquires a FRESH lease rather than reusing the
    // old one, and no generation's lease is ever released twice or skipped.
    it('each generation of a resumed session releases its own lease exactly once', async () => {
      const releaseA = vi.fn(async () => {});
      const releaseB = vi.fn(async () => {});
      const leases = [fakeLease([fakeServer('srv')], releaseA), fakeLease([fakeServer('srv')], releaseB)];
      let n = 0;
      const acquire = vi.fn(async () => leases[n++]);
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      await h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      h.send('s-1', 'hello');
      await waitForTurnComplete(h, 1);
      await h.drain('s-1');
      // Generation 1 goes away; generation 2 resumes under the SAME id.
      await h.destroy('s-1');
      expect(releaseA).toHaveBeenCalledTimes(1);
      expect(releaseB).not.toHaveBeenCalled();

      await h.resume('s-1', root);
      // Tearing generation 2 down must release ITS lease, and must not touch
      // generation 1's again.
      await h.destroy('s-1');
      expect(releaseB).toHaveBeenCalledTimes(1);
      expect(releaseA).toHaveBeenCalledTimes(1);
    });

    it('a registry-wide acquire failure does not block session creation — the session just opens with no MCP servers', async () => {
      const acquire = vi.fn(async () => { throw new Error('registry file corrupt'); });
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      await expect(h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } })).resolves.toBeUndefined();
      const session = (h as any).live.get('s-1').session;
      expect(session.opts.mcpServers).toBeUndefined();
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
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, contextLengthFor as any, providerTypeFor as any, async () => null);
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

    // Task 6c: the visionSupportFor closure's discovered value must actually
    // reach the resolved profile — this is the step that turns the catalog
    // plumbing (CatalogModel.supportsVision, DiscoveredModel.supportsVision,
    // visionFor()'s precedence) from dead fields into the real fix. A cloud
    // OpenRouter binding has no VISION_PROVIDERS default (openrouter is a
    // transport), so `true` from the closure is the ONLY way this profile
    // could come out true — pinning that a bare provider-default read would
    // fail this exact assertion.
    it('a discovered supportsVision:true from visionSupportFor reaches the resolved profile', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextLengthFor as any, providerTypeFor as any,
        async () => true,
      );
      await h.create({ sessionId: 'v', cwd: root, binding: { providerId: 'openrouter', modelId: 'vision-model' } });
      expect(profileOf(h, 'v').supportsVision).toBe(true);
      await h.destroyAll();
    });

    // The other half of the same wiring: a closure that can't answer (null —
    // "no source could answer", e.g. an OpenRouter cache miss or a non-OpenRouter
    // provider) must leave the profile EXACTLY as it resolved before this task —
    // openrouter has no VISION_PROVIDERS default, so this pins supportsVision: false.
    it('visionSupportFor returning null leaves the profile exactly as it was before this task', async () => {
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextLengthFor as any, providerTypeFor as any,
        async () => null,
      );
      await h.create({ sessionId: 'v2', cwd: root, binding: { providerId: 'openrouter', modelId: 'unknown-model' } });
      expect(profileOf(h, 'v2').supportsVision).toBe(false);
      await h.destroyAll();
    });

    // FIX-3 (whole-branch review): the registry context ceiling is a LOCAL concern.
    // matchKnownModel keys only on the model-id regex, so a HOSTED model whose id
    // matches a local family (OpenRouter `qwen/qwen3.5-9b` → the local Qwen 3.5 9B
    // entry, ceiling 262144) must NOT be clamped — its real cloud window (1M here)
    // passes through untouched. The identical id on a local-engine binding IS clamped.
    const contextOf = (h: NativeSessionHost, id: string) => ((h as any).live.get(id).session as any).opts.contextLength;

    it('a NON-local binding matching a registry family is NOT clamped to the registry ceiling', async () => {
      // Same model id, same raw 1M window; only the provider TYPE differs.
      const bigWindow = async () => 1_000_000;
      const typeFor = async (b: any) => (b.providerId === 'local' ? 'local-engine' : 'openrouter');
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, bigWindow as any, typeFor as any, async () => null);

      // Hosted (OpenRouter): real 1M window survives — no local registry clamp.
      await h.create({ sessionId: 'cloud', cwd: root, binding: { providerId: 'openrouter', modelId: 'qwen/qwen3.5-9b' } });
      expect(contextOf(h, 'cloud')).toBe(1_000_000);

      // Local-engine, same id: clamped down to the registry's trained ceiling.
      await h.create({ sessionId: 'local', cwd: root, binding: { providerId: 'local', modelId: 'qwen/qwen3.5-9b' } });
      expect(contextOf(h, 'local')).toBe(262144);
      await h.destroyAll();
    });
  });

  // ---- Task 12: per-session permission mode + remembered rules ----
  describe('permission mode + remembered rules', () => {
    // A host wired with a REAL PermissionStore (over the temp home) + an injected
    // app version, driving the Write-then-stop turn.
    const permHost = () => new NativeSessionHost(
      new SessionStore(new NativeHome(root)), writeFactory, async () => null, async () => null, async () => null,
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
        new SessionStore(new NativeHome(root)), writeFactory, async () => null, async () => null, async () => null, store, '9.9.9',
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
        new SessionStore(new NativeHome(root)), writeFactory, async () => null, async () => null, async () => null, hangingStore, '9.9.9',
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
      const h = new NativeSessionHost(store, factory, async () => null, async () => null, async () => null);
      await h.create({ sessionId: 's1', cwd: root, binding, presetId: 'coder' });
      expect(store.readHeader('s1', root)?.harnessId).toBe('coder');
      expect(h.getPermissionMode('s1')).toBe('auto-edit');
      await h.destroyAll();
    });

    it('create defaults to assistant when no preset is given', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, async () => null, async () => null, async () => null);
      await h.create({ sessionId: 's2', cwd: root, binding });
      expect(store.readHeader('s2', root)?.harnessId).toBe('assistant');
      expect(h.getPermissionMode('s2')).toBe('ask');
      await h.destroyAll();
    });

    it("resume maps a legacy 'chat' header to assistant wiring without rewriting the header", async () => {
      // Seed a stored session whose header has the legacy harnessId:'chat'.
      const store = new SessionStore(new NativeHome(root));
      await store.create({ v: 1, sessionId: 'legacy1', harnessId: 'chat', binding, cwd: root, createdAt: Date.now() });

      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, async () => null, async () => null, async () => null);
      expect(await h.resume('legacy1', root)).toBe(true);
      expect(h.getHarnessId('legacy1')).toBe('assistant');
      expect(store.readHeader('legacy1', root)?.harnessId).toBe('chat'); // header untouched — mapping is read-side
      await h.destroyAll();
    });

    it('an explicit user mode flip still beats the preset default', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, async () => null, async () => null, async () => null);
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
      host = new NativeSessionHost(new SessionStore(new NativeHome(root)), delayedFactory, async () => null, async () => null, async () => null);
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
      const errHost = new NativeSessionHost(new SessionStore(new NativeHome(root)), throwOnceFactory(), async () => null, async () => null, async () => null);
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
      const qHost = new NativeSessionHost(store, delayedFactory, async () => null, async () => null, async () => null);
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
      const qHost = new NativeSessionHost(store, delayedFactory, async () => null, async () => null, async () => null);
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

  // ---- Specialists (plan 1a, Task 5): createChild mints a CHILD session —
  // an ordinary HarnessSession marked by parentage, cold-started, with a
  // charter-capped tool + permission surface and no route to a user ask.
  describe('specialist children (Task 5)', () => {
    const EXPLORER = resolveSpecialist('explorer')!;
    // Boot a host we hold the store handle for (the suite's shared `host`
    // builds its store inline) so a test can read the child's header back.
    function bootHost(modelFactory: any = factory, skillCatalog?: any) {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, modelFactory, async () => null, async () => null, async () => null,
        undefined, undefined, undefined, skillCatalog,
      );
      return { store, h };
    }
    async function withParent(modelFactory: any = factory, skillCatalog?: any) {
      const { store, h } = bootHost(modelFactory, skillCatalog);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      return { store, h };
    }
    // The child's live HarnessSession — Task 7 reaches it the same way (through
    // the host's live map); here it is the only route to the child's tool surface.
    const childSession = (h: NativeSessionHost, id: string) => (h as any).live.get(id).session;
    const toolNames = (h: NativeSessionHost, id: string) => Object.keys(childSession(h, id).buildAiTools());

    it('createChild mints a child session with parent header fields and restricted tools', async () => {
      const { store, h } = await withParent();
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      });
      const header = store.readHeader(childId, root);
      expect(header?.parentSessionId).toBe('root-1');
      expect(header?.sessionKind).toBe('specialist');
      expect(header?.agentType).toBe('explorer');
      expect(header?.cwd).toBe(root);
      expect(header?.binding).toEqual({ providerId: 'openrouter', modelId: 'm' });   // inherits the parent's model
      // Exactly the definition's allowlist — no Write/Edit/Bash/TodoWrite/AskUserQuestion.
      expect(toolNames(h, childId).sort()).toEqual([...EXPLORER.allowedTools].sort());
      await h.destroyAll();
    });

    it('createChild rejects a workDir outside the parent cwd', async () => {
      const { h } = await withParent();
      await expect(h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: '/etc', parentToolCallId: 'tc-1',
      })).rejects.toThrow(/inside the parent/i);
      await h.destroyAll();
    });

    it('createChild accepts a subdirectory of the parent cwd (a narrower jail is fine)', async () => {
      const { store, h } = await withParent();
      const sub = path.join(root, 'sub');
      fs.mkdirSync(sub, { recursive: true });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: sub, parentToolCallId: 'tc-1',
      });
      expect(store.readHeader(childId, sub)?.cwd).toBe(sub);
      await h.destroyAll();
    });

    it('createChild refuses a parent that is not live — never a child with no owner', async () => {
      const { h } = await withParent();
      await expect(h.createChild('ghost', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      })).rejects.toThrow(/ghost/);
      await h.destroyAll();
    });

    it('a child session has no Skill tool and no Task tool (cold-start contract, depth 1)', async () => {
      // The host IS given a populated catalog, so the parent gets the Skill tool
      // — that is what makes the child's absence meaningful rather than an
      // artifact of the sandboxed HOME (tests/global-setup.ts) finding no skills.
      const catalog = { list: () => [{ id: 'journal', description: 'Write a journal entry' }], load: (id: string) => ({ id, displayName: id, description: 'd', body: 'b' }) };
      const { h } = await withParent(factory, catalog);
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      expect(toolNames(h, 'root-1')).toContain('Skill');   // the parent can reach skills…
      const names = toolNames(h, childId);
      expect(names).not.toContain('Skill');                // …the child cannot
      expect(names).not.toContain('Task');                 // depth 1 by toolset omission
      // Explicit-suppression pin: the child was HANDED an empty catalog rather
      // than left to fall back to createSkillCatalog(). Both look identical in
      // this suite (the sandboxed HOME has no skills either), so only reading
      // back what was injected can tell them apart — and in production that is
      // the difference between "no skills" and "the user's whole library".
      const injected = (childSession(h, childId) as any).opts.skillCatalog;
      expect(injected.list()).toEqual([]);
      expect(() => injected.load('journal')).toThrow(/No skill named/);
      // Same for MCP: no lease is acquired for a child, so no servers ride along.
      expect((childSession(h, childId) as any).opts.mcpServers).toBeUndefined();
      await h.destroyAll();
    });

    it('children are hidden from the Resume Browser list', async () => {
      const { h } = await withParent();
      await h.createChild('root-1', { specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1' });
      expect(h.list().map((r) => r.sessionId)).toEqual(['root-1']);
      await h.destroyAll();
    });

    it("a child's events persist under its OWN id and never reach the host emitter (display copies are Task 7)", async () => {
      const { store, h } = await withParent();
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const onHost: any[] = [];
      h.on('transcript-event', (e) => onHost.push(e));
      await childSession(h, childId).send('go');
      await h.drain(childId);
      // Persisted to the child's own JSONL...
      expect(store.readEvents(childId, root).map((e) => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
      // ...and NOT forwarded raw to the renderer: an un-stamped child event
      // would mint a conversation record for a session no window owns.
      expect(onHost.filter((e) => e.sessionId === childId)).toEqual([]);
      await h.destroyAll();
    });

    it("the child runs inside the launch envelope: a parent 'ask' for an in-charter tool never prompts", async () => {
      // Worker charter is read-write and lists Write; the parent sits in the
      // default 'ask' mode, where Write would normally raise a permission ask.
      // The envelope (the user's approval at spawn) converts that to an allow —
      // and no ask may reach the broker, because a child has no user.
      const WORKER = resolveSpecialist('worker')!;
      const writeOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Write', { file_path: 'child-note.txt', content: 'hi' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParent(async () => writeOnce());
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const asks: any[] = [];
      h.on('hook-event', (e) => asks.push(e));
      await childSession(h, childId).send('go');
      expect(asks).toEqual([]);                                           // no ask was raised
      expect(fs.existsSync(path.join(root, 'child-note.txt'))).toBe(true); // the tool actually ran
      await h.destroyAll();
    });

    it("the destructive deny-list cuts through the envelope: a spawn-approved child still cannot rm -rf", async () => {
      // Critical review fix: launch consent (the envelope) is consent for the
      // specialist's CHARTER of work, not for `rm -rf` — spec §5 says no charter
      // or envelope overrides the destructive deny-list. Worker is read-write and
      // has Bash, and the parent sits in the default 'ask' mode where the
      // deny-list layer marks `rm *` denyListed — exactly the shape that used to
      // fall into the envelope branch and come out an allow.
      const WORKER = resolveSpecialist('worker')!;
      fs.writeFileSync(path.join(root, 'marker.txt'), 'do not delete me');
      const rmOnce = () => scriptedModel([
        stream(toolCallChunk('c1', 'Bash', { command: 'rm -rf marker.txt' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParent(async () => rmOnce());
      const { childId } = await h.createChild('root-1', {
        specialist: WORKER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const asks: any[] = [];
      const events: any[] = [];
      h.on('hook-event', (e) => asks.push(e));
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      await childSession(h, childId).send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/destructive-action list/i);
      expect(fs.existsSync(path.join(root, 'marker.txt'))).toBe(true);   // never ran
      expect(asks).toEqual([]);                                          // no ask reached the host either
      await h.destroyAll();
    });

    it("an external-directory Read is declined by the wired ask policy, not the config-error stub (mutation-proof pin for createChild's askUser wiring)", async () => {
      // Important review fix: the Task 5.5 Step 4 pin (stepCap, below) exercises
      // askUser only through the max_steps gate, which short-circuits identically
      // whether `askUser: childAskPolicy()` is wired or deleted from createChild —
      // so that pin alone cannot catch the wiring being dropped. This drives a
      // DIFFERENT askUser call site: the external-directory forced ask
      // (harness-session.ts checkPathGuard 'external' verdict, ~:1830-1852). With
      // the policy wired, childAskPolicy denies it and the model reads the
      // DECLINED copy (~:1854, "user declined"). With askUser undefined,
      // harness-session's own guard answers first with the "No approval handler
      // is wired... configuration error" copy (~:1851) instead — the two are
      // mutually exclusive, so asserting the declined copy AND the absence of the
      // config-error copy discriminates policy-wired from policy-missing.
      const external = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-external-'));
      const outsideFile = path.join(external, 'secret.txt');
      fs.writeFileSync(outsideFile, 'outside the jail');
      const readOutside = () => scriptedModel([
        stream(toolCallChunk('c1', 'Read', { file_path: outsideFile }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const { h } = await withParent(async () => readOutside());
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      await childSession(h, childId).send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/user declined|dismissed/i);
      expect(res.data.toolResult).not.toMatch(/No approval handler is wired/i);
      fs.rmSync(external, { recursive: true, force: true });
      await h.destroyAll();
    });

    const writesOnce = (file: string) => async () => scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: file, content: 'x' }), finishChunk('tool-calls')),
      stream(...textChunks('t', 'done'), finishChunk('stop')),
    ]) as any;

    it('a tool the specialist does not have is refused by omission, naming what it DOES have', async () => {
      // Explorer is read-only and has no Write, so Write is never attached — the
      // driver's unknown-tool result answers first and the charter cap in
      // buildChildDecide is never consulted. That IS the contract: the outer
      // layer already names the available tools, so the model gets a next step
      // rather than retrying the same call.
      const { h } = await withParent(writesOnce('nope.txt'));
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      await childSession(h, childId).send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/Unknown tool Write/);
      expect(res.data.toolResult).toMatch(/Read, Glob, Grep/);
      expect(fs.existsSync(path.join(root, 'nope.txt'))).toBe(false);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(true);   // refusal, not a crash
      await h.destroyAll();
    });

    it('the read-only charter still refuses a write tool a definition wrongly listed', async () => {
      // The second cap earns its keep here: a definition that lists Write under a
      // read-only charter DOES get the tool attached, so the tool filter can no
      // longer help — decide() is what stops it, with a reason that says why.
      // (The same layer is what would catch a dynamically-attached tool, since
      // Skill and MCP tools are attached inside HarnessSession, not from `tools`.)
      const MISDECLARED = { ...EXPLORER, allowedTools: [...EXPLORER.allowedTools, 'Write'] };
      const { h } = await withParent(writesOnce('charter.txt'));
      const { childId } = await h.createChild('root-1', {
        specialist: MISDECLARED, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      await childSession(h, childId).send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/read-only charter/i);
      expect(fs.existsSync(path.join(root, 'charter.txt'))).toBe(false);
      await h.destroyAll();
    });

    // Task 5.5 step 4 — the behavioral pin the ask-policy exists for. Four paths
    // in harness-session call askUser directly, bypassing decide(); the step-cap
    // gate is one of them. Wired to a broker, the child's ask would go to a
    // sessionId no window owns, the reducer would drop it, and the promise would
    // never resolve — the child would hang until teardown. With the policy it
    // ends the turn cleanly.
    it("stepCap is enforced: the turn ends with stopReason 'max_steps' instead of hanging, and no ask is raised", async () => {
      const CAPPED = { ...EXPLORER, stepCap: 2 };   // definition-driven, not a global
      // A model that never stops calling tools (scriptedModel replays its last
      // script forever), so only the step cap can end this turn.
      const loops = () => scriptedModel([
        stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
      ]) as any;
      const { h } = await withParent(async () => loops());
      const { childId } = await h.createChild('root-1', {
        specialist: CAPPED, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const events: any[] = [];
      const asks: any[] = [];
      h.on('hook-event', (e) => asks.push(e));
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));

      await childSession(h, childId).send('go');   // must SETTLE — a hang fails by timeout

      const done = events.find((e) => e.type === 'turn-complete');
      expect(done).toBeDefined();
      expect(done.data.stopReason).toBe('max_steps');
      // The DEFINITION's cap is what stopped it, not the model-tier default:
      // exactly two steps ran. Without the harness.limits.maxSteps wiring this
      // model would loop to stepBudgetFor(modelId) — same stopReason, ~25 steps.
      expect(events.filter((e) => e.type === 'tool-use')).toHaveLength(2);
      expect(asks.filter((e) => e.payload?.sessionId === childId || e.payload?._sessionId === childId)).toEqual([]);
      expect(asks).toEqual([]);   // nothing reached the host emitter at all
      await h.destroyAll();
    });

    it("the child's permissions are keyed to the PARENT's project, not its work subdirectory", async () => {
      // buildDecide looks remembered "Always allow" rules up by cwd. A child
      // narrowed to a subdirectory must still read the rules the user granted
      // for the PROJECT — grants follow the project, not the subtree — so the
      // lookup has to use the parent's cwd even though the child runs in `sub`.
      const rulesFor = vi.fn(async () => []);
      const store = new SessionStore(new NativeHome(root));
      const globOnce = async () => scriptedModel([
        stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
        stream(...textChunks('t', 'done'), finishChunk('stop')),
      ]) as any;
      const h = new NativeSessionHost(store, globOnce, async () => null, async () => null, async () => null,
        { rulesFor, remember: async () => { /* no-op */ } });
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const sub = path.join(root, 'sub-perms');
      fs.mkdirSync(sub, { recursive: true });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: sub, parentToolCallId: 'tc-1',
      });
      rulesFor.mockClear();
      await childSession(h, childId).send('go');
      expect(rulesFor).toHaveBeenCalled();                                  // the child DID consult them
      expect(rulesFor.mock.calls.map((c) => c[0])).toEqual([root]);         // ...under the parent's cwd
      await h.destroyAll();
    });

    it('destroying the parent destroys its children and releases their model ref', async () => {
      const { h } = await withParent();
      const released: string[] = [];
      h.setModelReleasedHandler((id) => released.push(id));
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      expect(h.sessionsForModel('m').sort()).toEqual([childId, 'root-1'].sort());

      await h.destroy('root-1');
      expect(h.isNative(childId)).toBe(false);          // the child went with its parent
      expect(h.sessionsForModel('m')).toEqual([]);      // ...and gave back its model ref
      expect(released).toEqual(['m']);
      await h.destroyAll();
    });

    it('interrupting the parent interrupts its running children', async () => {
      const { h } = await withParent(delayedFactory);
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      const turn = childSession(h, childId).send('go');   // slow (delayedFactory) turn
      await new Promise((r) => setTimeout(r, 20));
      h.interrupt('root-1');
      await turn;                                         // settles — no hang
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
      await h.destroyAll();
    });
  });
});
