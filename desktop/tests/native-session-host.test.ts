import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost, SUBAGENT_DISPLAY_TYPES, mergeChildEvents } from '../src/main/harness/native-session-host';
import { PermissionStore } from '../src/main/harness/permission-store';
import { cwdToProjectSlug } from '../src/main/transcript-watcher';
import type { PermissionRule } from '../src/shared/permission-types';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { scriptedModel, stream, textChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS } from '../src/main/harness/specialists/limits';
import { OWNER } from '../src/main/harness/specialists/delegation-ledger';
import { ModelSearchTool } from '../src/main/harness/tools/model-search';
import type { CatalogModel } from '../src/shared/provider-types';

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

// Fix pass 2 (Task 13): the constructor's 3rd param collapsed from a bare
// contextLengthFor(binding) => Promise<number|null> into ONE closure that
// also answers the engine's slot count (contextAndSlotsFor). Most fixtures
// below don't care about either value — this stub answers "no source could
// tell" for both, matching the old `async () => null`'s intent.
const NO_CONTEXT = async () => ({ contextLength: null, totalSlots: null });

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
    host = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
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

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
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

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
    const resumed = await host2.resume('s-1', root, { providerId: 'local', modelId: 'model-B' });
    expect(resumed).toBe(true);
    expect(host2.modelForSession('s-1')).toBe('model-B');
    expect(host2.getBinding('s-1')).toEqual({ providerId: 'local', modelId: 'model-B' });
    await host2.destroyAll();
  });

  it('resume WITHOUT an override still uses the header binding (no local match ⇒ no substitution)', async () => {
    await host.create({ sessionId: 's-2', cwd: root, binding: { providerId: 'openrouter', modelId: 'header-model' } });
    await host.destroy('s-2');

    const host2 = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
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
    const midHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
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
    const orphanHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
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
    const failHost = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
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
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined,
        { destroyAll: mcpDestroyAll },
      );
      await h.destroyAll();
      expect(mcpDestroyAll).toHaveBeenCalledTimes(1);
    });

    it('destroyAll() works fine with no mcpManager wired (pre-Task-6 wiring)', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
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
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
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
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
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
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
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
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
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
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
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
        new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined,
        { destroyAll: async () => {}, acquire },
      );
      await expect(h.create({ sessionId: 's-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } })).resolves.toBeUndefined();
      const session = (h as any).live.get('s-1').session;
      expect(session.opts.mcpServers).toBeUndefined();
    });
  });

  // ---- Task 6 review fix 2: the per-parent slot/writer bookkeeping had zero
  // host-level tests before this — everything exercising it went through
  // tools/task.ts's fakes (task-tool.test.ts), which never touch the REAL host
  // methods. Drives reserveSpecialist/releaseReservation directly, keyed by an
  // arbitrary parent id (no live session needed — these are pure bookkeeping
  // over host-owned Maps, enforced independently of whether a parent session
  // actually exists).
  //
  // Task 1 (plan 1b): tryReserveSpecialistSlot/releaseSpecialistSlot are gone
  // — reserveSpecialist folds the slot check AND the writer-busy check into
  // ONE synchronous call, so a throw or an await between "checked" and "set"
  // can no longer let two parallel Task calls both win the same reservation.
  // ----
  describe('specialist slot + writer-lock bookkeeping (Task 6)', () => {
    it('ceiling: HOSTED_MAX_CONCURRENT_SPECIALISTS reserves succeed for one parent, the next is refused', () => {
      for (let i = 0; i < HOSTED_MAX_CONCURRENT_SPECIALISTS; i++) {
        expect(host.reserveSpecialist('A', { writer: false }).ok).toBe(true);
      }
      // Task 13: no live session under 'A' → maxSpecialistsFor's defensive
      // fallback (HOSTED_MAX_CONCURRENT_SPECIALISTS), carried on the refusal
      // as `max` so tools/task.ts can render the REAL resolved number.
      expect(host.reserveSpecialist('A', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: HOSTED_MAX_CONCURRENT_SPECIALISTS });
    });

    it('per-parent isolation: an UNRELATED parent is unaffected by A being at capacity', () => {
      for (let i = 0; i < HOSTED_MAX_CONCURRENT_SPECIALISTS; i++) host.reserveSpecialist('A', { writer: false });
      expect(host.reserveSpecialist('A', { writer: false }).ok).toBe(false);   // A is full
      expect(host.reserveSpecialist('B', { writer: false }).ok).toBe(true);    // B's own ceiling is untouched
    });

    it('release: freeing one slot lets A reserve again; releasing to zero drops the map entry', () => {
      const tokens: any[] = [];
      for (let i = 0; i < HOSTED_MAX_CONCURRENT_SPECIALISTS; i++) {
        const r = host.reserveSpecialist('A', { writer: false });
        if (r.ok) tokens.push(r.token);
      }
      expect(host.reserveSpecialist('A', { writer: false }).ok).toBe(false);
      host.releaseReservation(tokens.pop());
      const refilled = host.reserveSpecialist('A', { writer: false });    // one freed → one more fits
      expect(refilled.ok).toBe(true);
      if (refilled.ok) tokens.push(refilled.token);
      // Release every reservation currently held (back at the ceiling after the
      // line above) down to zero — the map entry must not linger at 0 forever
      // (releaseReservation's own header: "so a parent that never delegates
      // again doesn't linger in the map").
      for (const t of tokens) host.releaseReservation(t);
      expect((host as any).specialistSlots.has('A')).toBe(false);
    });

    it('releasing a token for a parent with no live reservation is a harmless no-op', () => {
      expect(() => host.releaseReservation({ parentId: 'never-reserved', writer: false })).not.toThrow();
      expect((host as any).specialistSlots.has('never-reserved')).toBe(false);
    });

    it('writer lock: busy only for the parent that holds it, never an unrelated parent; clearing it frees the parent up', () => {
      // WHY read the map directly rather than through a query method:
      // isSpecialistWriterBusy was removed as dead production code (nothing
      // outside tests ever called it — reserveSpecialist inlines the same
      // check). No public setter exists either — spawnSpecialist/
      // bindReservation is the only production writer, and it always tears
      // the lock back down before ever returning. Reaching the Map directly
      // is how a sibling Task call's in-flight writer lock — read while it is
      // still IN FLIGHT — actually gets pinned at the host level rather than
      // only through task-tool.test.ts's fakes.
      expect((host as any).activeWriterChild.has('A')).toBe(false);
      (host as any).activeWriterChild.set('A', 'child-x');
      expect((host as any).activeWriterChild.has('A')).toBe(true);
      expect((host as any).activeWriterChild.has('B')).toBe(false);     // per-parent isolation
      (host as any).activeWriterChild.delete('A');
      expect((host as any).activeWriterChild.has('A')).toBe(false);
    });

    // ---- Task 1 (plan 1b): the actual fix. 1a's writer-lock gate was a
    // check-then-set split across an await (tools/task.ts checked
    // isWriterBusy(), native-session-host.ts's spawnSpecialist set the lock
    // AFTER await createChild(...)) — safe only because the driver ran one
    // tool at a time. Two Task calls issued in the SAME parallel tool-call
    // step interleave at that await, and both could see "not busy" before
    // either set the lock. reserveSpecialist closes that window by doing the
    // check AND the set in one synchronous call. ----
    it('reserves slot and writer atomically — two synchronous writer reservations, second refused', () => {
      const a = host.reserveSpecialist('parent-1', { writer: true });
      const b = host.reserveSpecialist('parent-1', { writer: true });
      expect(a.ok).toBe(true);
      expect(b).toEqual({ ok: false, reason: 'writer-busy' });
    });

    it('a released writer reservation frees the writer lock even when no child was ever bound', () => {
      const a = host.reserveSpecialist('parent-1', { writer: true });
      if (!a.ok) throw new Error('unexpected');
      host.releaseReservation(a.token);
      expect(host.reserveSpecialist('parent-1', { writer: true }).ok).toBe(true);
    });

    it('readers do not consume the writer lock and cap at the profile max', () => {
      for (let i = 0; i < 4; i++) expect(host.reserveSpecialist('parent-1', { writer: false }).ok).toBe(true);
      expect(host.reserveSpecialist('parent-1', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: HOSTED_MAX_CONCURRENT_SPECIALISTS });
    });
  });

  // ---- Task 13: maxSpecialistsFor now resolves the PARENT'S OWN live
  // CapabilityProfile snapshot (capability-profile.ts's maxConcurrentSpecialists)
  // instead of the flat HOSTED_MAX_CONCURRENT_SPECIALISTS constant — a local
  // session's real ceiling can be smaller than hosted's. The fallback constant
  // above still applies whenever no live session backs the parent id (the
  // 'never created' cases in the describe block above). ----
  describe('specialist concurrency cap follows the profile (Task 13)', () => {
    const providerTypeFor = async (b: any) => (b.providerId === 'local' ? 'local-engine' : 'openrouter');
    // Fix pass 2: contextLengthFor collapsed into contextAndSlotsFor — this
    // fixture doesn't care about slots (totalSlots: null keeps the Layer 3
    // fallback/unknown-model floor of 1 in play for the first two tests).
    const contextAndSlotsFor = async (b: any) => ({ contextLength: b.providerId === 'local' ? 8192 : 200_000, totalSlots: null });

    it('a local-engine parent (unknown model → Layer 3 fallback) caps reservations at 1, not the hosted constant', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 'local-parent', cwd: root, binding: { providerId: 'local', modelId: 'mystery-3b' } });
      expect(h.reserveSpecialist('local-parent', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('local-parent', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 1 });
      await h.destroyAll();
    });

    it('a cloud/hosted parent is unaffected — still caps at HOSTED_MAX_CONCURRENT_SPECIALISTS', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any, async () => null);
      await h.create({ sessionId: 'cloud-parent', cwd: root, binding: { providerId: 'openrouter', modelId: 'gpt-4o' } });
      for (let i = 0; i < HOSTED_MAX_CONCURRENT_SPECIALISTS; i++) {
        expect(h.reserveSpecialist('cloud-parent', { writer: false }).ok).toBe(true);
      }
      expect(h.reserveSpecialist('cloud-parent', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: HOSTED_MAX_CONCURRENT_SPECIALISTS });
      await h.destroyAll();
    });

    // Fix pass (gap the review found): DiscoveredModel.totalSlots was built and
    // tested at the capability-profile.ts layer, but nothing threaded a REAL
    // engine reading into it — every local session silently fell back to the
    // conservative floor of 1, a regression from the pre-Task-13 flat cap of 4.
    // This is the closing link: a contextAndSlotsFor closure that answers a
    // live 2-slot reading for a KNOWN local model (qwen3.6-35b-moe matches
    // KNOWN_MODELS, 'full' tier, same modelId capability-profile.test.ts
    // already proves clamps to a live reading) must make the HOST actually
    // enforce 2, not 1 and not the hosted 4. Fix pass 2 folds the old separate
    // slotCountFor closure into this same one — see the constructor param's
    // comment for why that removes the shared-state race this test's sibling
    // (below, "no cross-talk") now covers directly.
    it('a KNOWN local model with a live 2-slot engine reading caps reservations at 2', async () => {
      const localTwoSlots = async (b: any) => ({ contextLength: b.providerId === 'local' ? 8192 : 200_000, totalSlots: b.providerId === 'local' ? 2 : null });
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, localTwoSlots as any, providerTypeFor as any, async () => null,
      );
      await h.create({ sessionId: 'local-parent-2', cwd: root, binding: { providerId: 'local', modelId: 'qwen3.6-35b-moe-q4' } });
      expect(h.reserveSpecialist('local-parent-2', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('local-parent-2', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('local-parent-2', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 2 });
      await h.destroyAll();
    });

    // Fix pass 2 concurrency regression: the OLD design shared one /props
    // reading between two closures (contextLengthFor, slotCountFor) through a
    // variable scoped at the ipc-handlers.ts wiring site — correct only if
    // every resolveContextAndProfile call awaited both closures back-to-back
    // with nothing else able to run in between. Two local-engine sessions
    // starting while the OTHER is still mid-resolution is exactly the
    // interleaving that variable could not survive. The new design has no
    // shared state to interleave: this drives two overlapping create() calls
    // for two DIFFERENT local bindings with two DIFFERENT slot counts and
    // proves each session's resolved cap is its own — never the other's,
    // never zeroed by the other landing in between.
    it('two overlapping local-engine session starts each resolve their OWN slot count — no cross-talk', async () => {
      let releaseA: () => void;
      const stallA = new Promise<void>((res) => { releaseA = res; });
      // Both ids must match a KNOWN_MODELS entry — an unknown local model hits
      // the Layer 3 fallback, which floors to 1 UNCONDITIONALLY regardless of
      // totalSlots (capability-profile.ts's localFallback), which would mask
      // the exact cross-talk this test exists to catch. 'model-a' hits the
      // Qwen 3.6 MoE entry, 'model-b' the Qwen 3.5 9B entry — different
      // families, so a mix-up between them is unambiguous.
      //
      // model-a's read stalls mid-flight (simulating its /props round trip
      // still being in the air) until the test explicitly releases it —
      // model-b's read resolves immediately, landing WHILE model-a is still
      // pending. The old shared-variable design could not tell these apart.
      const contextAndSlotsFor = async (b: any) => {
        if (b.modelId === 'model-a-qwen3.6-35b-moe') { await stallA; return { contextLength: 8192, totalSlots: 2 }; }
        return { contextLength: 8192, totalSlots: 4 };
      };
      const h = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any, async () => null,
      );

      const createA = h.create({ sessionId: 'race-a', cwd: root, binding: { providerId: 'local', modelId: 'model-a-qwen3.6-35b-moe' } });
      // Started WHILE createA is still stalled inside its own contextAndSlotsFor
      // await — the exact overlap the review flagged.
      await h.create({ sessionId: 'race-b', cwd: root, binding: { providerId: 'local', modelId: 'model-b-qwen3.5-9b' } });
      releaseA!();
      await createA;

      // race-a's own reading (2 slots) — NOT 4 (race-b's), NOT 1 (floored by
      // a stale/null read).
      expect(h.reserveSpecialist('race-a', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('race-a', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('race-a', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 2 });

      // race-b's own reading (4 slots) — unaffected by race-a's later resolve.
      for (let i = 0; i < 4; i++) expect(h.reserveSpecialist('race-b', { writer: false }).ok).toBe(true);
      expect(h.reserveSpecialist('race-b', { writer: false })).toEqual({ ok: false, reason: 'at-capacity', max: 4 });

      await h.destroyAll();
    });
  });

  // ---- Task 5: the host resolves + threads a CapabilityProfile per binding ----
  describe('capability profile threading', () => {
    // Binding-aware fakes: a 'local' provider is a small local engine; anything
    // else is a cloud provider. Reach into the live session's resolved profile.
    const providerTypeFor = async (b: any) => (b.providerId === 'local' ? 'local-engine' : 'openrouter');
    const contextAndSlotsFor = async (b: any) => ({ contextLength: b.providerId === 'local' ? 8192 : 200_000, totalSlots: null });
    const profileOf = (h: NativeSessionHost, id: string) => ((h as any).live.get(id).session as any).profile;

    it('a small local-engine binding yields a simplified profile; a swap to cloud re-resolves to full', async () => {
      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any, async () => null);
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
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any,
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
        new SessionStore(new NativeHome(root)), factory, contextAndSlotsFor as any, providerTypeFor as any,
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
      const bigWindow = async () => ({ contextLength: 1_000_000, totalSlots: null });
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
      new SessionStore(new NativeHome(root)), writeFactory, NO_CONTEXT, async () => null, async () => null,
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
        new SessionStore(new NativeHome(root)), writeFactory, NO_CONTEXT, async () => null, async () => null,
        store, '9.9.9',
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
        // Present only to satisfy RememberedRuleStore, which the revocation task
        // widened with remove/removeProject. Never called in this test.
        remove: async () => false,
        removeProject: async () => false,
      };
      const p = new NativeSessionHost(
        new SessionStore(new NativeHome(root)), writeFactory, NO_CONTEXT, async () => null, async () => null,
        hangingStore, '9.9.9',
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

  // ---- M5 2a Task 7: revocation that reaches a LIVE session ----
  // The whole feature rests on this. buildDecide() unions the on-disk rules with
  // the per-session `rememberedFor` map on EVERY permission decision, so deleting
  // a rule from disk alone leaves a running session still granting exactly what
  // the user just revoked. These tests drive REAL turns (writeFactory builds a
  // fresh scripted model per turn, so every turn genuinely re-attempts the gated
  // Write) and assert on whether the session asks again — the only observable
  // that proves the revoke actually landed.
  describe('revokeRule / revokeProject', () => {
    const binding = { providerId: 'openrouter', modelId: 'm' } as const;

    /** A host wired to the given remembered-rule store, driving the Write-then-stop turn. */
    const revokeHost = (permStore: any) => new NativeSessionHost(
      new SessionStore(new NativeHome(root)), writeFactory, NO_CONTEXT, async () => null, async () => null,
      permStore, '9.9.9',
    );

    /** Drive one whole turn whose gated Write is answered with "Always allow".
     *  Sequential by construction — firstAsk/waitForTurnComplete are host-wide,
     *  not per-session, so two of these must never overlap. */
    async function alwaysAllowTurn(p: NativeSessionHost, sessionId: string, text: string): Promise<void> {
      const ask = firstAsk(p);
      const done = waitForTurnComplete(p, 1);
      p.send(sessionId, text);
      p.respondPermission(await ask, { decision: { behavior: 'allow' }, updatedPermissions: [{ tool: 'Write' }] });
      await done;
    }

    /** Drive one whole turn and report whether it raised a permission ask.
     *  Answers any ask with a deny so the turn always finishes — a firstAsk()
     *  await would hang forever on the (expected) no-ask path. */
    async function turnAsked(p: NativeSessionHost, sessionId: string, text: string): Promise<boolean> {
      let asked = false;
      const onHook = (e: any) => {
        if (e.type !== 'PermissionRequest' || asked) return;
        asked = true;
        p.respondPermission(e.payload._requestId, { decision: { behavior: 'deny' } });
      };
      p.on('hook-event', onHook);
      const done = waitForTurnComplete(p, 1);
      p.send(sessionId, text);
      await done;
      p.off('hook-event', onHook);
      return asked;
    }

    /** The disk persist behind "Always allow" is fire-and-forget (mutateJson under
     *  a file lock), so wait for it to land before revoking — otherwise remove()
     *  could run BEFORE the write and report a miss that is really a race. */
    async function waitForStoredRule(store: PermissionStore, cwd: string): Promise<PermissionRule> {
      for (let i = 0; i < 100; i++) {
        const hit = (await store.rulesFor(cwd)).find((r) => r.tool === 'Write' && r.action === 'allow');
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('the remembered Write rule never reached disk');
    }

    it('stops a live session granting the revoked rule', async () => {
      const store = new PermissionStore(new NativeHome(root));
      const p = revokeHost(store);
      await p.create({ sessionId: 's', cwd: root, binding });

      await alwaysAllowTurn(p, 's', 'write once');
      expect(await turnAsked(p, 's', 'write again')).toBe(false);   // remembered — no ask

      // Pass the rule AS STORED, which carries a grantedAt key the in-memory copy
      // never had. Matching must be on the (tool, pattern, action) TRIPLE — a
      // whole-object comparison would silently stop dropping the in-memory rule.
      const stored = await waitForStoredRule(store, root);
      expect((stored as any).grantedAt).toBeTypeOf('string');
      await expect(p.revokeRule(cwdToProjectSlug(root), stored)).resolves.toBe(true);

      // Disk is clear AND the SAME still-running session asks again. If revokeRule
      // had only touched disk, rememberedFor would still grant and this stays false.
      expect(await store.rulesFor(root)).toEqual([]);
      expect(await turnAsked(p, 's', 'write a third time')).toBe(true);
      await p.destroyAll();
    });

    it('clears sessions whose cwd differs in spelling but shares the slug', async () => {
      // cwdToProjectSlug collapses spaces to '-' exactly as it does '/', so these
      // two REAL, distinct directories genuinely share one entry on disk.
      const spacedCwd = path.join(root, 'my project');
      const dashedCwd = path.join(root, 'my-project');
      fs.mkdirSync(spacedCwd); fs.mkdirSync(dashedCwd);
      expect(cwdToProjectSlug(spacedCwd)).toBe(cwdToProjectSlug(dashedCwd));   // the premise

      // A store that never grants and never persists: rulesFor is always [], so
      // the ONLY thing that can make either session grant is its in-memory copy —
      // which is precisely what a slug-keyed drop has to clear in BOTH sessions.
      // (A real store would also mean the first session's disk write silently
      // pre-granted the second one, so it could never build an in-memory copy.)
      const memoryOnlyStore = {
        rulesFor: async () => [] as any[],
        remember: async () => { /* no-op */ },
        remove: async () => true,
        removeProject: async () => true,
      };
      const p = revokeHost(memoryOnlyStore);
      await p.create({ sessionId: 'spaced', cwd: spacedCwd, binding });
      await p.create({ sessionId: 'dashed', cwd: dashedCwd, binding });
      await alwaysAllowTurn(p, 'spaced', 'write once');
      await alwaysAllowTurn(p, 'dashed', 'write once');
      expect(await turnAsked(p, 'spaced', 'again')).toBe(false);
      expect(await turnAsked(p, 'dashed', 'again')).toBe(false);

      await p.revokeRule(cwdToProjectSlug(spacedCwd), { tool: 'Write', pattern: 'note.txt', action: 'allow' });

      // Path equality would have cleared at most one of these.
      expect(await turnAsked(p, 'spaced', 'after revoke')).toBe(true);
      expect(await turnAsked(p, 'dashed', 'after revoke')).toBe(true);
      await p.destroyAll();
    });

    it('leaves an unrelated project untouched', async () => {
      const mineCwd = path.join(root, 'mine');
      const otherCwd = path.join(root, 'other');
      fs.mkdirSync(mineCwd); fs.mkdirSync(otherCwd);
      const memoryOnlyStore = {
        rulesFor: async () => [] as any[],
        remember: async () => { /* no-op */ },
        remove: async () => true,
        removeProject: async () => true,
      };
      const p = revokeHost(memoryOnlyStore);
      await p.create({ sessionId: 'mine', cwd: mineCwd, binding });
      await p.create({ sessionId: 'other', cwd: otherCwd, binding });
      await alwaysAllowTurn(p, 'mine', 'write once');
      await alwaysAllowTurn(p, 'other', 'write once');

      await p.revokeRule(cwdToProjectSlug(mineCwd), { tool: 'Write', pattern: 'note.txt', action: 'allow' });

      expect(await turnAsked(p, 'mine', 'after revoke')).toBe(true);
      expect(await turnAsked(p, 'other', 'after revoke')).toBe(false);   // untouched
      await p.destroyAll();
    });

    it('returns false when the store matched nothing', async () => {
      const p = revokeHost(new PermissionStore(new NativeHome(root)));
      await expect(
        p.revokeRule('-never-granted', { tool: 'Bash', pattern: 'ls', action: 'allow' }),
      ).resolves.toBe(false);
      await p.destroyAll();
    });

    it('revokeProject clears the whole slice on disk AND in the live session', async () => {
      const store = new PermissionStore(new NativeHome(root));
      const p = revokeHost(store);
      await p.create({ sessionId: 's', cwd: root, binding });
      await alwaysAllowTurn(p, 's', 'write once');
      await waitForStoredRule(store, root);
      expect(await turnAsked(p, 's', 'write again')).toBe(false);

      await expect(p.revokeProject(cwdToProjectSlug(root))).resolves.toBe(true);

      expect(await store.list()).toEqual([]);
      expect(await turnAsked(p, 's', 'after revoke')).toBe(true);
      await p.destroyAll();
    });

    it('revokeProject returns false for a slug with nothing stored', async () => {
      const p = revokeHost(new PermissionStore(new NativeHome(root)));
      await expect(p.revokeProject('-never-granted')).resolves.toBe(false);
      await p.destroyAll();
    });
  });

  // ---- Task 13: preset selection + seeding + legacy 'chat' mapping ----
  describe('preset wiring', () => {
    const binding = { providerId: 'openrouter', modelId: 'm' } as const;

    it('create stamps the chosen preset in the header and seeds its default mode', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
      await h.create({ sessionId: 's1', cwd: root, binding, presetId: 'coder' });
      expect(store.readHeader('s1', root)?.harnessId).toBe('coder');
      expect(h.getPermissionMode('s1')).toBe('auto-edit');
      await h.destroyAll();
    });

    it('create defaults to assistant when no preset is given', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
      await h.create({ sessionId: 's2', cwd: root, binding });
      expect(store.readHeader('s2', root)?.harnessId).toBe('assistant');
      expect(h.getPermissionMode('s2')).toBe('ask');
      await h.destroyAll();
    });

    it("resume maps a legacy 'chat' header to assistant wiring without rewriting the header", async () => {
      // Seed a stored session whose header has the legacy harnessId:'chat'.
      const store = new SessionStore(new NativeHome(root));
      await store.create({ v: 1, sessionId: 'legacy1', harnessId: 'chat', binding, cwd: root, createdAt: Date.now() });

      const h = new NativeSessionHost(new SessionStore(new NativeHome(root)), factory, NO_CONTEXT, async () => null, async () => null);
      expect(await h.resume('legacy1', root)).toBe(true);
      expect(h.getHarnessId('legacy1')).toBe('assistant');
      expect(store.readHeader('legacy1', root)?.harnessId).toBe('chat'); // header untouched — mapping is read-side
      await h.destroyAll();
    });

    it('an explicit user mode flip still beats the preset default', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(store, factory, NO_CONTEXT, async () => null, async () => null);
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
      host = new NativeSessionHost(new SessionStore(new NativeHome(root)), delayedFactory, NO_CONTEXT, async () => null, async () => null);
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
      const errHost = new NativeSessionHost(new SessionStore(new NativeHome(root)), throwOnceFactory(), NO_CONTEXT, async () => null, async () => null);
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
      const qHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
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
      const qHost = new NativeSessionHost(store, delayedFactory, NO_CONTEXT, async () => null, async () => null);
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
        store, modelFactory, NO_CONTEXT, async () => null, async () => null,
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
      // Task 8: the child's assigned fun name lands in the header's existing
      // `title` field — the transcript header/list machinery renders it for
      // free, no new plumbing needed beyond this write.
      expect(header?.title).toMatch(/^\w+ the \w+ (Explorer|Researcher|Reviewer|Worker)$/);
      // Exactly the definition's allowlist — no Write/Edit/Bash/TodoWrite/AskUserQuestion.
      expect(toolNames(h, childId).sort()).toEqual([...EXPLORER.allowedTools].sort());
      await h.destroyAll();
    });

    // Task 14: opts.binding, when tools/task.ts already resolved an override
    // (a designated tier or a validated specific id), is what the CHILD
    // actually launches on — not the parent's own binding. Every field that
    // reads `binding` downstream (the header, retainModel's ref-count, the
    // child's own HarnessSession) must agree on the OVERRIDE, not silently
    // fall back to the parent's.
    it('createChild launches on opts.binding when one is given, not the parent\'s own model', async () => {
      const { store, h } = await withParent();
      const override = { providerId: 'anthropic', modelId: 'claude-opus-5' };
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        binding: override,
      });
      const header = store.readHeader(childId, root);
      expect(header?.binding).toEqual(override);                 // NOT the parent's { providerId: 'openrouter', modelId: 'm' }
      expect(h.modelForSession(childId)).toBe('claude-opus-5');   // retainModel ref-counted the RESOLVED model
      expect(h.sessionsForModel('claude-opus-5')).toEqual([childId]);
      expect(h.sessionsForModel('m')).toEqual(['root-1']);        // the parent's own ref is untouched
      await h.destroyAll();
    });

    it('createChild falls back to the parent\'s binding when opts.binding is omitted (pre-Task-14 default, unchanged)', async () => {
      const { store, h } = await withParent();
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      });
      const header = store.readHeader(childId, root);
      expect(header?.binding).toEqual({ providerId: 'openrouter', modelId: 'm' });
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
      const h = new NativeSessionHost(store, globOnce, NO_CONTEXT, async () => null, async () => null,
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

    // ---- Task 6 review fix 1 (kept, retargeted at Task 7's real run loop):
    // spawnSpecialist's finally block once released only the writer lock,
    // leaving the child createChild() minted (live entry, disk header,
    // retainModel ref, childrenOf registration) alive forever on EVERY Task
    // call. Mirrors "destroying the parent destroys its children and releases
    // their model ref" above, but drives the teardown through spawnSpecialist
    // directly rather than through destroy(). The FAILED-run half of the same
    // guard lives in specialist-run.test.ts. --
    it('a completed spawnSpecialist run does not leak the minted child (leak guard)', async () => {
      const { store, h } = await withParent();
      const released: string[] = [];
      h.setModelReleasedHandler((id) => released.push(id));

      // The suite's default `factory` answers with one text step ("Hi there"),
      // which IS this child's report — a one-shot specialist that says its
      // piece and is torn down.
      const { childId, report } = await h.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        // Task 1 (plan 1b): spawnSpecialist now binds a caller-supplied
        // reservation rather than reserving one itself — this test drives the
        // run loop directly (below tools/task.ts), so it hands a plain reader
        // token rather than going through reserveSpecialist.
        token: { parentId: 'root-1', writer: false },
      });
      expect(report).toContain('Hi there');

      // The persisted record still names it as this parent's child.
      const childRow = store.list({ includeChildren: true }).find((r) => r.parentSessionId === 'root-1');
      expect(childRow?.sessionId).toBe(childId);

      // No live child entry survives the run — the leak guard's whole point.
      expect((h as any).live.has(childId)).toBe(false);
      expect(h.isNative(childId)).toBe(false);
      // De-registered from the parent's live children set too (destroy() does
      // this; a leaked child would still show up here).
      expect((h as any).childrenOf.get('root-1')?.has(childId)).toBeFalsy();
      // store.list() still carries the REAL persisted record (the child did
      // genuinely exist for a moment) but exactly once — no duplicate, no
      // dangling live-only phantom with no matching header.
      expect(store.list({ includeChildren: true }).filter((r) => r.sessionId === childId)).toHaveLength(1);

      // The child's model ref did NOT leak: destroying the parent (its only
      // remaining user of 'm') now fully releases the model. Before this fix,
      // the leaked child's retainModel() ref would keep 'm' referenced
      // forever even after the parent was gone — exactly "a local model could
      // never unload" from the review finding.
      await h.destroy('root-1');
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

    // Task 2 (plan 1b), Step 4: interrupt(parentId) — the Stop button — must
    // NOT cascade to a BACKGROUND child (deliberate 1b change from the test
    // above, which pins the FOREGROUND case). spawnSpecialist itself only
    // ever records background: false (Task 2's own scope is the foreground
    // flow; a real background-spawn path is a later task), so this test
    // reaches the private ledger directly to stamp a background: true record
    // — same pattern this suite already uses for other private state
    // ((host as any).live, .childrenOf, etc).
    it('interrupt(parentId) does NOT cascade to a BACKGROUND specialist child — it keeps working', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, delayedFactory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const { childId } = await h.createChild('root-1', {
        specialist: EXPLORER, prompt: 'p', workDir: root, parentToolCallId: 'tc-1',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc-1', agentType: EXPLORER.id, title: 'Bg the Explorer',
        workDir: root, description: EXPLORER.description, background: true,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });

      const events: any[] = [];
      childSession(h, childId).on('transcript-event', (e: any) => events.push(e));
      const turn = childSession(h, childId).send('go'); // slow (delayedFactory) turn

      await new Promise((r) => setTimeout(r, 20));
      h.interrupt('root-1'); // Stop button — must NOT reach the background child

      // The child was never told to stop, and it's still live.
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(false);
      expect((h as any).live.has(childId)).toBe(true);
      await turn; // let its turn settle naturally, undisturbed

      const rec = (h as any).ledger.listFor(root, 'root-1');
      expect(rec.find((r: any) => r.childId === childId)?.status).toBe('running');

      // Teardown is still stronger than interrupt — destroy takes it down
      // regardless of foreground/background (spec §1 cascade-cancel).
      await h.destroyAll();
      expect((h as any).live.has(childId)).toBe(false);
    });
  });

  // Task 5 (plan 1b): the per-turn specialist status block. wire() attaches
  // opts.specialistStatus to every ROOT session; this suite pins what that
  // callback reports given a stamped ledger, reaching the private ledger
  // directly (same pattern the Task 2 tests above use) rather than driving a
  // real specialist run end-to-end.
  describe('specialist status block (Task 5, plan 1b)', () => {
    it('the host status block lists running and undelivered-finished specialists and omits delivered ones', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-running', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-finished', parentToolCallId: 'tc-2', agentType: 'researcher', title: 'Otis',
        workDir: root, description: 'd', background: true,
        status: 'completed', startedAt: Date.now(), endedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-delivered', parentToolCallId: 'tc-3', agentType: 'writer', title: 'Priya',
        workDir: root, description: 'd', background: true,
        status: 'completed', startedAt: Date.now(), endedAt: Date.now(), delivered: true, owner: OWNER, missedSteers: [],
      });

      const rootSession = (h as any).live.get('root-1').session;
      const status: string | null = rootSession.opts.specialistStatus?.();

      expect(status).toBeTruthy();
      expect(status).toContain('Nadia');
      expect(status).toContain('running');
      expect(status).toContain('Otis');
      expect(status).toContain('report delivery pending');
      // Delivered specialist never appears.
      expect(status).not.toContain('Priya');

      await h.destroyAll();
    });

    it('returns null (and wires nothing to inject) when the session has no delegations at all', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      const rootSession = (h as any).live.get('root-1').session;
      expect(rootSession.opts.specialistStatus?.()).toBeNull();

      await h.destroyAll();
    });

    // Fix pass, Finding 1: DelegationRecord.steps is only ever written AT
    // COMPLETION (spawnSpecialist's success-path patch) — recordStart never
    // sets it, so a RUNNING record's `steps` is always undefined. The old
    // `r.steps ?? 0` rendered a permanently-wrong "step 0" for the entire
    // life of every running child. Pin that the running line never claims a
    // step count it doesn't have.
    it('a running specialist with no live step count omits the step clause instead of claiming "step 0"', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-running', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [],
      });

      const rootSession = (h as any).live.get('root-1').session;
      const status: string | null = rootSession.opts.specialistStatus?.();

      expect(status).toBeTruthy();
      expect(status).not.toContain('step 0');
      expect(status).not.toMatch(/step \d/);

      await h.destroyAll();
    });

    // Fix pass, Finding 2: `stale` only ever means "at least SPECIALIST_IDLE_
    // STALE_MS has elapsed" (setStale in this file never fires sooner) — the
    // real elapsed time can be far larger (e.g. the 5m in-tool threshold, or
    // just more wall-clock time). The old wording ("no activity for 2m") read
    // as an exact measurement. Pin that the floor is now stated as a floor.
    it('a stale running specialist reports the idle threshold as an "at least" floor, not a measurement', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-stale', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false, owner: OWNER, missedSteers: [], stale: true,
      });

      const rootSession = (h as any).live.get('root-1').session;
      const status: string | null = rootSession.opts.specialistStatus?.();

      expect(status).toContain('no activity for at least 2m');

      await h.destroyAll();
    });

    // Fix pass, Finding 3: claimUndelivered() (delegation-ledger.ts) only
    // ever claims status === 'completed' records — a 'failed' or
    // 'interrupted' record NEVER gets delivered. The old code gave every
    // undelivered non-running record the identical "finished — report
    // delivery pending" line, which then repeated, unchanged and false, on
    // every future turn. Pin that failed/interrupted get their own honest
    // line naming what happened, using the record's real failureText (never
    // a guessed cause), and that "delivery pending" wording never appears
    // for them.
    it('failed and interrupted specialists get an honest line naming what happened, never "delivery pending"', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-failed', parentToolCallId: 'tc-1', agentType: 'debugger', title: 'Fiona',
        workDir: root, description: 'd', background: true,
        status: 'failed', startedAt: Date.now(), endedAt: Date.now(), delivered: false, owner: OWNER,
        missedSteers: [], failureText: 'ENOENT: no such file or directory',
      });
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-interrupted', parentToolCallId: 'tc-2', agentType: 'writer', title: 'Greg',
        workDir: root, description: 'd', background: true,
        status: 'interrupted', startedAt: Date.now(), endedAt: Date.now(), delivered: false, owner: OWNER,
        missedSteers: [],
      });

      const rootSession = (h as any).live.get('root-1').session;
      const status: string | null = rootSession.opts.specialistStatus?.();
      const lines = (status ?? '').split('\n');

      const failedLine = lines.find((l) => l.startsWith('Fiona'));
      expect(failedLine).toBe('Fiona (debugger): failed — ENOENT: no such file or directory — no report will arrive');
      expect(failedLine).not.toContain('delivery pending');

      const interruptedLine = lines.find((l) => l.startsWith('Greg'));
      expect(interruptedLine).toBe('Greg (writer): interrupted — no report will arrive');
      expect(interruptedLine).not.toContain('delivery pending');

      await h.destroyAll();
    });
  });

  // Fix pass, Finding 1: toolWiring() used to hardcode `catalog: async () =>
  // null` unconditionally, so ModelSearch and a per-hire specific-model-id
  // override could NEVER see a real catalog even when one was available —
  // every specific id was refused regardless of whether it existed. This
  // proves the fix: when the constructor's `toolServices` param carries a
  // `modelCatalog` closure (exactly how ipc-handlers.ts wires it — see its
  // own construction site), the session's assembled services.models.catalog()
  // resolves to REAL rows, and ModelSearch reports actual matches instead of
  // the "catalog not loaded" fallback.
  describe('a real catalog reaches services.models.catalog() (Task 14 fix pass, Finding 1)', () => {
    const CATALOG: CatalogModel[] = [
      { id: 'anthropic/claude-opus-5', providerId: 'openrouter', label: 'Claude Opus 5', pricing: { in: 15, out: 75 }, contextLength: 200_000 },
    ];

    it('services.models.catalog() resolves to the injected modelCatalog closure\'s rows, not null', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined,
        { modelCatalog: async () => CATALOG },
        undefined, undefined,
        new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const session = (h as any).live.get('root-1').session;
      const catalog = await session.opts.toolServices.models.catalog();
      expect(catalog).toEqual(CATALOG);
      await h.destroyAll();
    });

    it('ModelSearch, run through the real wiring, returns actual matches instead of the "catalog not loaded" refusal', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined,
        { modelCatalog: async () => CATALOG },
        undefined, undefined,
        new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const session = (h as any).live.get('root-1').session;
      const ctx = {
        sessionId: 'root-1', cwd: root, signal: new AbortController().signal,
        readRegistry: new Map(), todos: [] as any[], services: session.opts.toolServices,
      };
      const result = await ModelSearchTool.execute({ query: 'claude' } as any, ctx as any);
      expect(result.isError).toBeUndefined();
      expect(result.text).toContain('anthropic/claude-opus-5');
      expect(result.text).not.toContain('Model list is unavailable right now (catalog not loaded)');
      await h.destroyAll();
    });

    it('without a modelCatalog closure, the catalog stays null (unchanged pre-fix-pass default — no behavior change)', async () => {
      const store = new SessionStore(new NativeHome(root));
      const h = new NativeSessionHost(
        store, factory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined,
        new NativeHome(root),
      );
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const session = (h as any).live.get('root-1').session;
      const catalog = await session.opts.toolServices.models.catalog();
      expect(catalog).toBeNull();
      await h.destroyAll();
    });
  });

  // Task 9 (plan 1b) — restart recovery + subagent-card replay. Unrelated to
  // the "Task 9" label on the `quiesce` describe above (Phase 1 Plan A used
  // its own numbering) — both names are pinned in their own commit history,
  // not renamed here to avoid an unrelated diff.
  //
  // Reconcile needs a REAL ledger (a NativeHome pointed at the test's tmp
  // root), same as the Task 4 background-delivery suite in
  // specialist-run.test.ts — the delivery loop and reconcile both read/write
  // it directly, so a fake would just be reimplementing the real thing.
  describe('restart recovery + subagent-card replay (Task 9, plan 1b)', () => {
    const EXPLORER = resolveSpecialist('explorer')!;

    function bootHost(home: NativeHome, store: SessionStore, modelFactory: any = factory) {
      return new NativeSessionHost(
        store, modelFactory, NO_CONTEXT, async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, home,
      );
    }

    it('resuming a parent marks dead-owner running children as interrupted, honestly — and leaves a live owner\'s record untouched', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // A record whose owner is a process that does not exist — the shape a
      // real crash-and-restart leaves behind (nothing ever marked it
      // 'interrupted' because the process that would have died mid-flight).
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-dead', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false,
        owner: { pid: 999999, instanceId: 'dead-instance' }, missedSteers: [],
      });
      // A record owned by THIS process (OWNER is a module singleton, so it
      // reads as alive to every host built in this test file) — reconcile
      // must never touch a live owner's record.
      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-alive', parentToolCallId: 'tc-2', agentType: 'explorer', title: 'Otis',
        workDir: root, description: 'd', background: true,
        status: 'running', startedAt: Date.now(), delivered: false,
        owner: OWNER, missedSteers: [],
      });
      await h.destroy('root-1'); // parent goes away without ever marking either child

      const h2 = bootHost(home, store);
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      const records = (h2 as any).ledger.listFor(root, 'root-1');
      const dead = records.find((r: any) => r.childId === 'child-dead');
      expect(dead?.status).toBe('interrupted'); // honest — the child really did stop
      expect(dead?.endedAt).toBeDefined();

      const alive = records.find((r: any) => r.childId === 'child-alive');
      expect(alive?.status).toBe('running'); // untouched — its owner is still around

      await h2.destroyAll();
    });

    it('an undelivered background report from before the restart is delivered at the first idle boundary', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-done', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'find the config loader', background: true,
        status: 'completed', startedAt: Date.now() - 60_000, endedAt: Date.now(), steps: 3,
        rawReport: 'REPORT: found it in src/config.ts', delivered: false, owner: OWNER, missedSteers: [],
      });
      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      const events: any[] = [];
      h2.on('transcript-event', (e) => events.push(e));
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      await vi.waitFor(() => {
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
      });
      const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
      expect(injected.type).toBe('user-message');
      expect(injected.data.text).toContain('REPORT: found it in src/config.ts');

      const rec = (h2 as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === 'child-done');
      expect(rec?.delivered).toBe(true);

      await h2.destroyAll();
    });

    it('a report CLAIMED by a dead instance but never confirmed is re-delivered after restart', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await (h as any).ledger.recordStart(root, 'root-1', {
        childId: 'child-claimed', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
        workDir: root, description: 'find the config loader', background: true,
        status: 'completed', startedAt: Date.now() - 60_000, endedAt: Date.now(), steps: 2,
        rawReport: 'REPORT: config lives in src/config.ts', delivered: false, owner: OWNER,
        missedSteers: [], claimedBy: { pid: 999999, instanceId: 'gone' }, claimedAt: Date.now() - 30_000,
      });
      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      const events: any[] = [];
      h2.on('transcript-event', (e) => events.push(e));
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      await vi.waitFor(() => {
        expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
      });
      // Settle a bit longer — a duplicate delivery (the bug this reconcile
      // pass exists to prevent) would show up as a SECOND injected event.
      await new Promise((r) => setTimeout(r, 30));
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);

      const rec = (h2 as any).ledger.listFor(root, 'root-1').find((r: any) => r.childId === 'child-claimed');
      expect(rec?.delivered).toBe(true);

      await h2.destroyAll();
    });

    it('getHistory splices stamped child events immediately after the parent Task tool-use', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      // What a real turn produces when the model calls Task (task.ts): a
      // tool-use event on the PARENT's own transcript, then a tool-result once
      // the specialist's report comes back. Appended directly rather than
      // driven through a scripted Task tool-call — the Task tool's own
      // execute() path is exercised in task-tool.test.ts; this test only needs
      // the parent-side shape getHistory splices against.
      await store.append(root, {
        type: 'tool-use', sessionId: 'root-1', uuid: 'u-tool-use', timestamp: Date.now(),
        data: { toolUseId: 'tc-1', toolName: 'Task', toolInput: { agent: 'explorer' } },
      });

      const { childId, report } = await h.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });
      expect(report).toContain('Hi there'); // the suite's default `factory`'s one text step

      await store.append(root, {
        type: 'tool-result', sessionId: 'root-1', uuid: 'u-tool-result', timestamp: Date.now(),
        data: { toolUseId: 'tc-1', toolResult: report },
      });

      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      const resumed = await h2.resume('root-1', root);
      expect(resumed).toBe(true);

      const events = h2.getHistory('root-1')!;
      const taskIdx = events.findIndex((e) => e.type === 'tool-use' && e.data.toolName === 'Task');
      expect(taskIdx).toBeGreaterThanOrEqual(0);
      // Immediately after — not just "somewhere after".
      expect(events[taskIdx + 1].data.agentId).toBe(childId);
      expect(events[taskIdx + 1].data.parentAgentToolUseId).toBe(events[taskIdx].data.toolUseId);
      // Every stamped (agentId-bearing) event is display-safe — nothing else
      // rode along under the parent's id.
      const stamped = events.filter((e) => e.data.agentId);
      expect(stamped.length).toBeGreaterThan(0);
      expect(stamped.every((e) => SUBAGENT_DISPLAY_TYPES.has(e.type))).toBe(true);

      await h2.destroyAll();
    });

    it('replayed stamped events preserve partId so the reducer coalesces deltas identically', async () => {
      const home = new NativeHome(root);
      const store = new SessionStore(home);
      const h = bootHost(home, store);
      await h.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

      await store.append(root, {
        type: 'tool-use', sessionId: 'root-1', uuid: 'u-tool-use', timestamp: Date.now(),
        data: { toolUseId: 'tc-1', toolName: 'Task', toolInput: { agent: 'explorer' } },
      });

      await h.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });

      // The child's own persisted assistant-text event, straight off disk —
      // this is the source of truth the replay must match, not a guess.
      const childHeader = store.list({ includeChildren: true }).find((r) => r.parentSessionId === 'root-1')!;
      const childOwnEvents = store.readEvents(childHeader.sessionId, root);
      const originalText = childOwnEvents.find((e) => e.type === 'assistant-text')!;
      expect(originalText.data.partId).toBeTruthy(); // sanity: the fixture really does carry one

      await h.destroy('root-1');

      const h2 = bootHost(home, store);
      await h2.resume('root-1', root);

      const events = h2.getHistory('root-1')!;
      const replayedText = events.find((e) => e.type === 'assistant-text' && e.data.agentId === childHeader.sessionId)!;
      expect(replayedText.data.partId).toBe(originalText.data.partId);

      await h2.destroyAll();
    });
  });

  // mergeChildEvents (Task 9, plan 1b) — the pure splice function, tested
  // directly per the brief rather than only through getHistory() above.
  describe('mergeChildEvents (pure function)', () => {
    const rec = (over: Partial<any> = {}) => ({
      childId: 'child-1', parentToolCallId: 'tc-1', agentType: 'explorer', title: 'Nadia',
      workDir: '/x', description: 'd', background: false, status: 'completed',
      startedAt: 0, delivered: true, owner: OWNER, missedSteers: [], ...over,
    });
    const ev = (type: string, over: Partial<any> = {}): any => ({
      type, sessionId: 'child-1', uuid: `u-${Math.random()}`, timestamp: 0, data: {}, ...over,
    });

    it('splices the stamped block immediately after the matching parent Task tool-use event', () => {
      const parentEvents = [
        ev('user-message', { sessionId: 'root-1' }),
        ev('tool-use', { sessionId: 'root-1', data: { toolUseId: 'tc-1', toolName: 'Task' } }),
        ev('turn-complete', { sessionId: 'root-1' }),
      ];
      const childEvents = [ev('assistant-text', { data: { text: 'child said this' } })];
      const merged = mergeChildEvents('root-1', parentEvents, [{ record: rec(), events: childEvents }]);
      expect(merged).toHaveLength(4);
      expect(merged[1].type).toBe('tool-use');
      expect(merged[2].type).toBe('assistant-text');
      expect(merged[2].sessionId).toBe('root-1');
      expect(merged[2].data.agentId).toBe('child-1');
      expect(merged[2].data.parentAgentToolUseId).toBe('tc-1');
      expect(merged[3].type).toBe('turn-complete');
    });

    it('filters child events down to the display-safe subset — turn-complete/user-message never ride along', () => {
      const parentEvents = [ev('tool-use', { sessionId: 'root-1', data: { toolUseId: 'tc-1' } })];
      const childEvents = [
        ev('user-message', { data: { text: 'the brief' } }),
        ev('assistant-text', { data: { text: 'ok' } }),
        ev('turn-complete', {}),
      ];
      const merged = mergeChildEvents('root-1', parentEvents, [{ record: rec(), events: childEvents }]);
      expect(merged.map((e) => e.type)).toEqual(['tool-use', 'assistant-text']);
    });

    // Explicit requirement (brief): a crash between minting the child and
    // appending the parent's own Task tool-use event leaves a ledger record
    // with no matching parent event — must be skipped, never guessed at.
    it('skips a record defensively when its parentToolCallId has no matching parent tool-use event', () => {
      const parentEvents = [ev('user-message', { sessionId: 'root-1' })];
      const childEvents = [ev('assistant-text', { data: { text: 'orphaned' } })];
      const merged = mergeChildEvents('root-1', parentEvents, [{ record: rec(), events: childEvents }]);
      expect(merged).toEqual(parentEvents); // untouched — no guess, no drop of parent events
    });

    it('splices multiple children after their OWN respective parent tool-use events, in order', () => {
      const parentEvents = [
        ev('tool-use', { sessionId: 'root-1', data: { toolUseId: 'tc-1' } }),
        ev('tool-use', { sessionId: 'root-1', data: { toolUseId: 'tc-2' } }),
      ];
      const children = [
        { record: rec({ childId: 'child-1', parentToolCallId: 'tc-1' }), events: [ev('assistant-text', { data: { text: 'from child 1' } })] },
        { record: rec({ childId: 'child-2', parentToolCallId: 'tc-2' }), events: [ev('assistant-text', { data: { text: 'from child 2' } })] },
      ];
      const merged = mergeChildEvents('root-1', parentEvents, children);
      expect(merged.map((e) => `${e.type}:${e.data.agentId ?? e.data.toolUseId}`)).toEqual([
        'tool-use:tc-1', 'assistant-text:child-1', 'tool-use:tc-2', 'assistant-text:child-2',
      ]);
    });
  });
});
