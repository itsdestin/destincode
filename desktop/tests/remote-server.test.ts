import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

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
});
