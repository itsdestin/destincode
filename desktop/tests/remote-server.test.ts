import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Mock ws module — use require() inside vi.mock to avoid hoisting issues
vi.mock('ws', async () => {
  const { EventEmitter: EE } = await import('events');
  class MockWebSocketServer extends EE {
    clients = new Set();
    close = vi.fn((cb?: () => void) => cb?.());
    constructor(_opts?: any) { super(); }
  }
  const MockWebSocket: any = vi.fn();
  MockWebSocket.OPEN = 1;
  return { WebSocketServer: MockWebSocketServer, WebSocket: MockWebSocket };
});

// listenBehavior lets a test turn the next listen() into a bind failure
// (EADDRINUSE) instead of a success, so the start-failure path is exercised
// rather than assumed.
const listenBehavior: { mode: 'ok' | 'error'; calls: number } = { mode: 'ok', calls: 0 };

vi.mock('http', async () => {
  const { EventEmitter: EE } = await import('events');
  function createServer(_handler?: any) {
    const emitter: any = new EE();
    return Object.assign(emitter, {
      listen: vi.fn((_port: number, cb?: () => void) => {
        listenBehavior.calls++;
        if (listenBehavior.mode === 'error') {
          const err: any = new Error('listen EADDRINUSE: address already in use :::9900');
          err.code = 'EADDRINUSE';
          // Real net.Server emits asynchronously; do the same so the promise
          // is already awaiting when the error lands.
          setImmediate(() => emitter.emit('error', err));
          return emitter;
        }
        cb?.();
        return emitter;
      }),
      close: vi.fn((cb?: () => void) => cb?.()),
    });
  }
  return { default: { createServer }, createServer };
});

// Task 5 M2 coverage — session:get-meta / set-tag / set-note route through
// conversations/service (the Conversation Store) and session:browse routes
// through session-browser's listPastSessions. Both are mocked so these tests
// exercise remote-server.ts's OWN resolve/canWrite/provider-derivation wiring
// (sessionMetaWiring, sessionProviderFor) rather than the real on-disk store
// or Claude project directories. Declared at module scope (not inside a
// describe) — vi.mock is hoisted above imports, and remote-server.ts loads
// these modules via dynamic `await import(...)` at case-handler time, well
// after this file's top-level `const` initializers have run — same pattern
// the 'http' mock above already relies on for `listenBehavior`.
const mockConversationsService = {
  getConversationStore: vi.fn<any>(),
  noteFlagChanged: vi.fn(async () => ({ ok: true })),
  noteSessionNote: vi.fn(async () => ({ ok: true })),
  emitConversationMetaChanged: vi.fn(),
};
vi.mock('../src/main/conversations/service', () => mockConversationsService);

const mockSessionBrowser = {
  listPastSessions: vi.fn(async () => [] as any[]),
  loadHistory: vi.fn(async () => ({ events: [] })),
};
vi.mock('../src/main/session-browser', () => mockSessionBrowser);

describe('RemoteServer', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    listenBehavior.mode = 'ok';
    listenBehavior.calls = 0;
    mockSessionManager = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(() => []),
      createSession: vi.fn(() => ({ id: '1', name: 'test', cwd: '/tmp', status: 'active' })),
      destroySession: vi.fn(() => true),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
    });
    mockHookRelay = Object.assign(new EventEmitter(), {
      respond: vi.fn(() => true),
    });
    mockConfig = {
      enabled: true,
      port: 9900,
      passwordHash: '$2b$10$fakehash',
      trustTailscale: false,
      verifyPassword: vi.fn(async (pw: string) => pw === 'correct'),
      isTailscaleIp: vi.fn(() => false),
    };
  });

  it('can be instantiated', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    expect(server).toBeDefined();
  });

  it('starts and stops without error', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    server.stop();
  });

  it('does not start when config.enabled is false', async () => {
    mockConfig.enabled = false;
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    // Should not throw, just no-op
    server.stop();
  });
});

describe('RemoteServer auth flow', () => {
  it('can be created with null password (rejects connections at auth time)', async () => {
    const mockSessionManager = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(() => []),
      createSession: vi.fn(),
      destroySession: vi.fn(),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
    });
    const mockHookRelay = Object.assign(new EventEmitter(), {
      respond: vi.fn(() => true),
    });
    const config = {
      enabled: true,
      port: 9900,
      passwordHash: null,
      trustTailscale: false,
      verifyPassword: vi.fn(async () => false),
      isTailscaleIp: vi.fn(() => false),
    };
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, config);
    expect(server).toBeDefined();
    // Can start even with no password — connections will be rejected at auth handshake
    await server.start();
    server.stop();
  });
});

// Runtime start/stop. Before this, start() ran exactly once at boot, so
// re-entrancy, bind failures and restart-after-stop were all unreachable
// states. The Settings toggle now drives start()/stop() at runtime and reaches
// every one of them.
describe('RemoteServer runtime start/stop', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    listenBehavior.mode = 'ok';
    listenBehavior.calls = 0;
    mockSessionManager = Object.assign(new EventEmitter(), {
      listSessions: vi.fn(() => []),
      createSession: vi.fn(),
      destroySession: vi.fn(),
      sendInput: vi.fn(),
      resizeSession: vi.fn(),
    });
    mockHookRelay = Object.assign(new EventEmitter(), { respond: vi.fn(() => true) });
    mockConfig = {
      enabled: true,
      port: 9900,
      passwordHash: '$2b$10$fakehash',
      trustTailscale: false,
      verifyPassword: vi.fn(async () => false),
      isTailscaleIp: vi.fn(() => false),
    };
  });

  it('reports isRunning across the start/stop cycle', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    expect(server.isRunning()).toBe(false);
    await server.start();
    expect(server.isRunning()).toBe(true);
    server.stop();
    expect(server.isRunning()).toBe(false);
  });

  it('is idempotent — a second start() does not listen or re-subscribe', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    const listensAfterFirst = listenBehavior.calls;
    const ptyListeners = mockSessionManager.listenerCount('pty-output');

    await server.start();

    expect(listenBehavior.calls).toBe(listensAfterFirst);
    // Double-subscribing would duplicate every broadcast to remote clients.
    expect(mockSessionManager.listenerCount('pty-output')).toBe(ptyListeners);
    server.stop();
  });

  it('can be restarted after stop()', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    server.stop();
    await server.start();
    expect(server.isRunning()).toBe(true);
    expect(listenBehavior.calls).toBe(2);
    server.stop();
  });

  it('rejects with the real OS error when the port is taken', async () => {
    // The old code passed no error handler at all: the promise never settled
    // and the 'error' event went unhandled. A toggle awaiting that would hang
    // forever with no feedback.
    listenBehavior.mode = 'error';
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

    await expect(server.start()).rejects.toThrow(/EADDRINUSE/);
    expect(server.isRunning()).toBe(false);
  });

  it('leaves no subscriptions behind after a failed start', async () => {
    listenBehavior.mode = 'error';
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

    await expect(server.start()).rejects.toThrow();

    // A failed start that left listeners attached would double-subscribe on the
    // user's next attempt to toggle remote access back on.
    expect(mockSessionManager.listenerCount('pty-output')).toBe(0);
    expect(mockSessionManager.listenerCount('session-exit')).toBe(0);
    expect(mockHookRelay.listenerCount('hook-event')).toBe(0);
  });

  it('does not start when config.enabled is false', async () => {
    mockConfig.enabled = false;
    const { RemoteServer } = await import('../src/main/remote-server');
    const server = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    await server.start();
    expect(server.isRunning()).toBe(false);
    expect(listenBehavior.calls).toBe(0);
  });
});

// The message switch had no default case, so any channel the server doesn't
// implement was silently dropped. The shim (remote-shim.ts invoke()) registers
// a pending promise with a 30s timer, so an unimplemented channel presented as
// a 30-second hang and then a rejection naming nothing — which is why remote
// Project View and the game lobby looked "broken" rather than unimplemented.
describe('RemoteServer unhandled channels', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, trustTailscale: false, toSafeObject: () => ({}) };
  });

  /** Drive handleMessage directly with a fake authenticated client and collect
   *  everything the server writes back. */
  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  it('answers an unknown channel instead of dropping it', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'definitely:not-a-real-channel', id: 'req-1', payload: {} });
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe('definitely:not-a-real-channel:response');
    expect(sent[0].id).toBe('req-1');
    expect(sent[0].payload.ok).toBe(false);
    expect(sent[0].payload.unsupported).toBe(true);
  });

  it('names the channel in the error so the gap is diagnosable', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'social:list-friends', id: 'req-2', payload: {} });
    expect(sent[0].payload.error).toContain('social:list-friends');
  });

  it('stays silent for fire-and-forget messages that carry no id', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'some:notification', payload: {} });
    expect(sent).toHaveLength(0);
  });

  // Regression: useAttentionClassifier polls the unbridged
  // `terminal:get-screen-text` once a second, so an unconditional warn logged a
  // line per second for the life of the connection. That drowned the log and,
  // because a write to a closed stdout throws EPIPE, helped crash the main
  // process outright on 2026-07-20.
  it('warns once per unhandled channel, not once per request', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      for (let i = 0; i < 5; i++) {
        await sendAndCollect(server, { type: 'terminal:get-screen-text', id: `poll-${i}`, payload: {} });
      }
      expect(warn).toHaveBeenCalledTimes(1);

      // A DIFFERENT channel still warns — dedup must not silence new gaps.
      await sendAndCollect(server, { type: 'social:list-friends', id: 'other', payload: {} });
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });

  // Dedup must not change the protocol: every poll still gets its own answer,
  // or the shim's pending promise leaks and we are back to 30-second hangs.
  it('still responds to every request even when it stops warning', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      for (let i = 0; i < 3; i++) {
        const sent = await sendAndCollect(server, { type: 'terminal:get-screen-text', id: `poll-${i}`, payload: {} });
        expect(sent).toHaveLength(1);
        expect(sent[0].id).toBe(`poll-${i}`);
        expect(sent[0].payload.unsupported).toBe(true);
      }
    } finally {
      warn.mockRestore();
    }
  });
});

// Task 5 review finding: session:get-meta / set-tag / set-note / browse had
// ZERO test coverage even though M2 extended all four — get-meta now resolves
// the id through sessionMetaWiring and derives provider via
// nativeHost.isNativeSessionId; set-tag/set-note gate the write via
// sessionMetaWiring.canWrite and only answer once the service write settles;
// browse feeds nativeHost.list() into listPastSessions. None of that had a
// single pinning test before this suite.
describe('RemoteServer session meta + browse (Task 5 M2 wiring)', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConversationsService.getConversationStore.mockReset().mockReturnValue(null);
    mockConversationsService.noteFlagChanged.mockReset().mockResolvedValue({ ok: true });
    mockConversationsService.noteSessionNote.mockReset().mockResolvedValue({ ok: true });
    mockConversationsService.emitConversationMetaChanged.mockReset();
    mockSessionBrowser.listPastSessions.mockReset().mockResolvedValue([]);
    mockSessionBrowser.loadHistory.mockReset().mockResolvedValue({ events: [] });

    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, trustTailscale: false, toSafeObject: () => ({}) };
  });

  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  /** Minimal native runtime stub — only isNativeSessionId/list matter for these
   *  cases; the rest of the setNativeRuntime shape is asserted by other tests
   *  (native:* / provider:* suites), not this one. */
  function fakeNativeRuntime(nativeIds: Set<string>, listEntries: any[] = []) {
    return {
      nativeHost: {
        isNativeSessionId: (id: string) => nativeIds.has(id),
        list: () => listEntries,
      },
    } as any;
  }

  describe('session:get-meta', () => {
    it('resolves a native id through sessionMetaWiring and reads the store with provider "native"', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set(['native-1'])));
      server.setSessionMetaWiring({
        resolve: (id: string) => (id === 'desktop-1' ? 'native-1' : id),
        canWrite: () => true,
      });
      const storeGet = vi.fn(async (_provider: string, _id: string) => ({
        flags: { 'tag:tag_a': { value: true, updatedAt: 'x' } },
        note: 'hi',
      }));
      mockConversationsService.getConversationStore.mockReturnValue({ get: storeGet });

      const sent = await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r1', payload: { sessionId: 'desktop-1' },
      });

      // The wiring's resolve() output — not the raw payload id — is what must
      // reach the store, on the 'native' bucket derived from isNativeSessionId.
      expect(storeGet).toHaveBeenCalledWith('native', 'native-1');
      expect(sent[0].payload).toEqual({ tags: ['tag_a'], note: 'hi', supported: true });
    });

    it('resolves a non-native id and reads the store with provider "claude"', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set())); // nothing is native
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      const storeGet = vi.fn(async () => null);
      mockConversationsService.getConversationStore.mockReturnValue({ get: storeGet });

      await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r2', payload: { sessionId: 'cc-session-abc' },
      });

      expect(storeGet).toHaveBeenCalledWith('claude', 'cc-session-abc');
    });

    // C1: a store-only native id — NOT live/on-disk (isNativeSessionId false),
    // but a native record exists in the store (synced from a peer, transcript
    // not materialized here). sessionProviderFor must probe the native bucket
    // and resolve 'native' rather than defaulting to 'claude' (which would read
    // — and, on the write path, seed — the wrong bucket). Mirrors ipc-handlers.
    it('resolves a store-only native id (not live/on-disk) to the "native" bucket by probing the store', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set())); // nothing is live/on-disk native
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      // A native record exists in the store for this id; the claude bucket is empty.
      const storeGet = vi.fn(async (provider: string) =>
        provider === 'native'
          ? { flags: { 'tag:tag_n': { value: true, updatedAt: 'x' } }, note: 'from peer' }
          : null,
      );
      mockConversationsService.getConversationStore.mockReturnValue({ get: storeGet });

      const sent = await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r-native', payload: { sessionId: 'store-only-native' },
      });

      // The probe hit the native bucket, and the meta read used 'native' too.
      expect(storeGet).toHaveBeenCalledWith('native', 'store-only-native');
      expect(storeGet).not.toHaveBeenCalledWith('claude', 'store-only-native');
      expect(sent[0].payload).toEqual({ tags: ['tag_n'], note: 'from peer', supported: true });
    });

    it('falls back to an empty-but-supported result when no Conversation Store is up', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      mockConversationsService.getConversationStore.mockReturnValue(null);

      const sent = await sendAndCollect(server, {
        type: 'session:get-meta', id: 'r3', payload: { sessionId: 'x' },
      });

      expect(sent[0].payload).toEqual({ tags: [], note: '', supported: true });
    });
  });

  describe('session:set-tag', () => {
    const msg = (overrides: any = {}) => ({
      type: 'session:set-tag', id: 'st', payload: { sessionId: 'desktop-1', tagId: 'tag_abc', value: true, ...overrides },
    });

    it('rejects a malformed tag id without ever calling the store write', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

      const sent = await sendAndCollect(server, msg({ tagId: 'not-a-tag' }));

      expect(sent[0].payload).toEqual({ ok: false, error: 'invalid tag id' });
      expect(mockConversationsService.noteFlagChanged).not.toHaveBeenCalled();
    });

    // This is the phantom-record gate (ipc-handlers.ts canWriteStoreRecord),
    // mirrored here via sessionMetaWiring.canWrite. A refusal means "don't
    // seed a mis-provider'd record for a live session whose id mapping hasn't
    // landed yet" — the write is skipped, NOT an error: the same gate's
    // ipcMain twin (SESSION_SET_TAG) unconditionally returns `{ok:true}` after
    // the gated block regardless of whether canWrite passed, and the code
    // comment there says the flag simply re-applies once the mapping lands.
    // So this pins "skip the write" — not "answer ok:false" — as the correct,
    // parity-preserving shape.
    it('skips the write but still answers ok:true when canWrite refuses (mirrors ipc-handlers SESSION_SET_TAG parity)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => false });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteFlagChanged).not.toHaveBeenCalled();
      expect(sent[0].payload).toEqual({ ok: true });
    });

    it('answers ok:true once the service write resolves ok', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: true });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteFlagChanged).toHaveBeenCalledTimes(1);
      expect(sent[0].payload).toEqual({ ok: true });
    });

    // Task 5 gap (final review): this remote mirror of ipc-handlers.ts's
    // SESSION_SET_TAG never called emitConversationMetaChanged, so a tag
    // applied from a phone/browser stayed invisible to the chatsearch index
    // until an unrelated refresh happened to pick it up.
    it('signals chatsearch that a tag changed once the write succeeds', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: true });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).toHaveBeenCalledTimes(1);
    });

    // The emit must never fire on a failed write — an early-return failure
    // path must not tell chatsearch anything changed.
    it('does not signal chatsearch when the write fails', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: false });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).not.toHaveBeenCalled();
    });

    // Honesty invariant (Item 6): a write that actually reports failure must
    // not be smoothed over into ok:true the way the old fire-and-forget did.
    it('honesty invariant: a service write resolving ok:false produces an ok:false response', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockResolvedValue({ ok: false });

      const sent = await sendAndCollect(server, msg());

      expect(sent[0].payload.ok).toBe(false);
    });

    // C1: the write passes the SYNCHRONOUS isNativeSessionId(resolved) result
    // (a boolean) — not a resolved provider string — to noteFlagChanged, which
    // defers the store's native-bucket probe to flush time (boot-window
    // correctness). A live/on-disk native id → true.
    it('derives the write provider via nativeHost.isNativeSessionId on the RESOLVED id', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set(['native-1'])));
      server.setSessionMetaWiring({ resolve: () => 'native-1', canWrite: () => true });

      await sendAndCollect(server, msg({ sessionId: 'desktop-1' }));

      expect(mockConversationsService.noteFlagChanged).toHaveBeenCalledWith('native-1', 'tag:tag_abc', true, true);
    });

    // conversations/service's real noteFlagChanged (metaWrite) always catches
    // internally and resolves {ok:false} rather than rejecting — so this can't
    // happen through the real contract. It documents what happens to THIS
    // case block if that contract were ever violated: there's no local
    // try/catch around the await here (unlike ipcMain's SESSION_SET_TAG,
    // which wraps the whole handler), so a rejection propagates out of
    // handleMessage uncaught rather than answering the request. Not treated
    // as a bug to fix — flagged in the fix report for visibility instead,
    // since changing it would be a behavior change outside this task's scope.
    it('propagates a rejected write instead of answering the request (documents current behavior — see comment)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteFlagChanged.mockRejectedValue(new Error('store exploded'));

      await expect(sendAndCollect(server, msg())).rejects.toThrow('store exploded');
    });
  });

  describe('session:set-note', () => {
    const msg = (overrides: any = {}) => ({
      type: 'session:set-note', id: 'sn', payload: { sessionId: 'desktop-1', note: 'hello', ...overrides },
    });

    it('rejects a note over 8000 characters without ever calling the store write', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

      const sent = await sendAndCollect(server, msg({ note: 'x'.repeat(8001) }));

      expect(sent[0].payload).toEqual({ ok: false, error: 'note too long' });
      expect(mockConversationsService.noteSessionNote).not.toHaveBeenCalled();
    });

    it('skips the write but still answers ok:true when canWrite refuses (same gate shape as set-tag)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => false });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteSessionNote).not.toHaveBeenCalled();
      expect(sent[0].payload).toEqual({ ok: true });
    });

    it('answers ok:true once the service write resolves ok', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: true });

      const sent = await sendAndCollect(server, msg());

      expect(mockConversationsService.noteSessionNote).toHaveBeenCalledTimes(1);
      expect(sent[0].payload).toEqual({ ok: true });
    });

    // Task 5 gap (final review): this remote mirror of ipc-handlers.ts's
    // SESSION_SET_NOTE never called emitConversationMetaChanged, so a note
    // written from a phone/browser stayed invisible to the chatsearch index
    // until an unrelated refresh happened to pick it up.
    it('signals chatsearch that a note changed once the write succeeds', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: true });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).toHaveBeenCalledTimes(1);
    });

    it('honesty invariant: a service write resolving ok:false produces an ok:false response', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: false });

      const sent = await sendAndCollect(server, msg());

      expect(sent[0].payload.ok).toBe(false);
    });

    // The emit must never fire on a failed write.
    it('does not signal chatsearch when the note write fails', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setSessionMetaWiring({ resolve: (id: string) => id, canWrite: () => true });
      mockConversationsService.noteSessionNote.mockResolvedValue({ ok: false });

      await sendAndCollect(server, msg());

      expect(mockConversationsService.emitConversationMetaChanged).not.toHaveBeenCalled();
    });

    it('derives the write provider via nativeHost.isNativeSessionId on the RESOLVED id', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      server.setNativeRuntime(fakeNativeRuntime(new Set(['native-1'])));
      server.setSessionMetaWiring({ resolve: () => 'native-1', canWrite: () => true });

      await sendAndCollect(server, msg({ sessionId: 'desktop-1', note: 'note text' }));

      // C1: passes the boolean isNativeSessionId result, not a provider string.
      expect(mockConversationsService.noteSessionNote).toHaveBeenCalledWith('native-1', 'note text', true);
    });
  });

  describe('session:browse', () => {
    it('passes nativeHost.list() entries into listPastSessions alongside the live session ids', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      mockSessionManager.listSessions = vi.fn(() => [{ id: 'live-1' }]);
      const nativeEntries = [{ id: 'native-9', provider: 'native' as const, slug: 'foo' }];
      server.setNativeRuntime(fakeNativeRuntime(new Set(), nativeEntries));
      const pastRows = [{ id: 'past-1' }];
      mockSessionBrowser.listPastSessions.mockResolvedValue(pastRows);

      const sent = await sendAndCollect(server, { type: 'session:browse', id: 'b1', payload: {} });

      expect(mockSessionBrowser.listPastSessions).toHaveBeenCalledTimes(1);
      const [activeIdsArg, nativeEntriesArg] = mockSessionBrowser.listPastSessions.mock.calls[0];
      expect(activeIdsArg).toBeInstanceOf(Set);
      expect(activeIdsArg.has('live-1')).toBe(true);
      expect(nativeEntriesArg).toBe(nativeEntries); // same reference — the list() result flows straight through
      expect(sent[0].payload).toEqual(pastRows); // round-tripped through JSON via ws.send — deep, not reference, equality
    });

    it('passes undefined native entries when no native runtime is wired (pre-M2 / not-yet-wired parity)', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);

      await sendAndCollect(server, { type: 'session:browse', id: 'b2', payload: {} });

      const [, nativeEntriesArg] = mockSessionBrowser.listPastSessions.mock.calls[0];
      expect(nativeEntriesArg).toBeUndefined();
    });
  });
});

// The game lobby renders its sign-in screen off account:signed-in. With no
// handler the call hung, so signedIn stayed at its useState(false) default and
// a remote browser showed "signed out" while the host app was signed in.
describe('RemoteServer account bridge', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;

  beforeEach(() => {
    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, trustTailscale: false, toSafeObject: () => ({}) };
  });

  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  it('reports the host signed-in state', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    server.setAccountStore({ getToken: () => 'tok', getUser: () => ({ login: 'destin' }) });
    const sent = await sendAndCollect(server, { type: 'account:signed-in', id: 'a1', payload: {} });
    expect(sent[0].payload).toBe(true);
  });

  it('returns the cached profile', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    server.setAccountStore({ getToken: () => 'tok', getUser: () => ({ login: 'destin' }) });
    const sent = await sendAndCollect(server, { type: 'account:user', id: 'a2', payload: {} });
    expect(sent[0].payload.login).toBe('destin');
  });

  // Must not hang or throw when main.ts hasn't injected the store yet.
  it('reports signed-out when no store is injected', async () => {
    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'account:signed-in', id: 'a3', payload: {} });
    expect(sent[0].payload).toBe(false);
  });

  // Status data is polled every 10s in ipc-handlers, so without this replay a client
  // that connects between ticks renders a blank status bar for up to 10 seconds.
  // RemoteServer previously stored only `contextMap` here and never read it back.
  describe('status:data replay on connect', () => {
    function fakeWs() {
      const frames: any[] = [];
      return { frames, ws: { readyState: 1, send: (raw: string) => frames.push(JSON.parse(raw)) } as any };
    }

    it('replays the whole last status payload to a connecting client', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      const { frames, ws } = fakeWs();

      server.broadcastStatusData({ contextMap: { s1: 42 }, gitBranchMap: { s1: 'main' }, usage: { x: 1 } });
      await server.replayBuffers(ws);

      const status = frames.filter((m) => m.type === 'status:data');
      expect(status).toHaveLength(1);
      // Not just the context slice — every field the poll carries.
      expect(status[0].payload.contextMap).toEqual({ s1: 42 });
      expect(status[0].payload.gitBranchMap).toEqual({ s1: 'main' });
      expect(status[0].payload.usage).toEqual({ x: 1 });
    });

    it('sends no status frame when no poll has happened yet', async () => {
      const { RemoteServer } = await import('../src/main/remote-server');
      const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
      const { frames, ws } = fakeWs();

      await server.replayBuffers(ws);

      expect(frames.some((m) => m.type === 'status:data')).toBe(false);
    });
  });
});

// Security regression: the transcript:read-meta WS handler validated the
// caller-supplied path with startsWith(claudeProjects) and NO trailing path
// separator, so a SIBLING directory like ~/.claude/projects-evil/x.jsonl
// passed the containment check and its contents leaked to remote clients.
// The model:read-last case a few lines below already used the correct
// `claudeProjects + path.sep` prefix — these tests pin transcript:read-meta
// to the same rule.
describe('RemoteServer transcript:read-meta path containment', () => {
  let mockSessionManager: any;
  let mockHookRelay: any;
  let mockConfig: any;
  let tmpHome: string;
  let homedirSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSessionManager = new EventEmitter();
    Object.assign(mockSessionManager, { listSessions: vi.fn(() => []) });
    mockHookRelay = new EventEmitter();
    mockConfig = { enabled: true, port: 9900, passwordHash: null, trustTailscale: false, toSafeObject: () => ({}) };
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-rs-transcript-'));
    // Point os.homedir() at the tmp dir so the handler's ~/.claude/projects
    // containment root lives inside the fixture, not the real home.
    homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
  });

  afterEach(() => {
    homedirSpy.mockRestore();
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  });

  /** Drive handleMessage directly with a fake authenticated client and collect
   *  everything the server writes back. */
  function sendAndCollect(server: any, msg: any) {
    const sent: any[] = [];
    const ws: any = { readyState: 1, send: (raw: string) => sent.push(JSON.parse(raw)) };
    return server.handleMessage({ ws }, JSON.stringify(msg)).then(() => sent);
  }

  it('rejects a transcript in a sibling dir like ~/.claude/projects-evil', async () => {
    const evilDir = path.join(tmpHome, '.claude', 'projects-evil');
    fs.mkdirSync(evilDir, { recursive: true });
    const evilFile = path.join(evilDir, 'x.jsonl');
    fs.writeFileSync(evilFile, JSON.stringify({ model: 'leaked-model' }) + '\n');

    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'transcript:read-meta', id: 'req-evil', payload: { path: evilFile } });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toBeNull();
  });

  it('still reads a transcript inside ~/.claude/projects', async () => {
    const okDir = path.join(tmpHome, '.claude', 'projects', 'some-project');
    fs.mkdirSync(okDir, { recursive: true });
    const okFile = path.join(okDir, 'x.jsonl');
    fs.writeFileSync(okFile, JSON.stringify({ model: 'test-model' }) + '\n');

    const { RemoteServer } = await import('../src/main/remote-server');
    const server: any = new RemoteServer(mockSessionManager, mockHookRelay, mockConfig);
    const sent = await sendAndCollect(server, { type: 'transcript:read-meta', id: 'req-ok', payload: { path: okFile } });

    expect(sent).toHaveLength(1);
    expect(sent[0].payload?.model).toBe('test-model');
  });
});
