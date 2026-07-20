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
