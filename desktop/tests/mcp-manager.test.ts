import { describe, it, expect, vi } from 'vitest';
import { McpManager } from '../src/main/harness/mcp/mcp-manager';

function deps(connectSpy = vi.fn(), closeSpy = vi.fn()) {
  const registry = {
    resolveAllEnabled: async () => ([
      { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
        origin: { kind: 'user' }, missingSecrets: [] },
    ] as any),
  };
  const connectionFactory = () => ({
    state: 'ready' as const, lastError: null,
    connect: async () => { connectSpy(); },
    listTools: () => [{ name: 'search', description: 'd', inputSchema: { type: 'object' } }],
    callTool: async () => ({ text: 'ok', isError: false }),
    close: async () => { closeSpy(); },
  });
  return { registry: registry as any, connectionFactory: connectionFactory as any };
}

describe('McpManager', () => {
  it('connects a server once for two sessions', async () => {
    const connect = vi.fn();
    const mgr = new McpManager(deps(connect));
    await mgr.acquire('s1');
    await mgr.acquire('s2');
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('keeps the connection while another session still holds it', async () => {
    const close = vi.fn();
    const mgr = new McpManager(deps(vi.fn(), close));
    await mgr.acquire('s1'); await mgr.acquire('s2');
    await mgr.release('s1');
    expect(close).not.toHaveBeenCalled();
    await mgr.release('s2');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('releasing an unknown session is a no-op, not a throw', async () => {
    const mgr = new McpManager(deps());
    await expect(mgr.release('never-acquired')).resolves.toBeUndefined();
  });

  it('destroyAll closes everything regardless of refcount', async () => {
    const close = vi.fn();
    const mgr = new McpManager(deps(vi.fn(), close));
    await mgr.acquire('s1'); await mgr.acquire('s2');
    await mgr.destroyAll();
    expect(close).toHaveBeenCalledTimes(1);
  });

  // The brief's other tests are all sequential awaits, which would not catch
  // a manager that calls connect() twice when two sessions start at nearly
  // the same moment. Real sessions DO start concurrently (Task 6 calls
  // acquire() per session), so this race is genuinely reachable, not
  // speculative — hence a real test, not just analysis in a report.
  it('connects once when two acquire()s race before connect() resolves', async () => {
    const connect = vi.fn();
    let resolveConnect: () => void = () => {};
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
          origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = () => ({
      state: 'ready' as const, lastError: null,
      connect: () => { connect(); return new Promise<void>((r) => { resolveConnect = r; }); },
      listTools: () => [],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => {},
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });
    const p1 = mgr.acquire('s1');
    const p2 = mgr.acquire('s2');
    // Let both calls run past their `await resolveAllEnabled()` and into the
    // connect() call before we resolve it — setImmediate yields a full
    // macrotask, well past any number of microtask hops either call needs.
    await new Promise<void>((r) => setImmediate(r));
    resolveConnect();
    await Promise.all([p1, p2]);
    expect(connect).toHaveBeenCalledTimes(1);
  });

  // Regression test for the "fast release() racing a slow acquire()" leak:
  // holder registration used to happen AFTER connect() resolved, so a
  // release() landing before that point found no holder to remove and
  // no-op'd — then the resuming acquire() added the holder anyway, leaking
  // it forever (nobody calls release() twice for one session). Fixed by
  // registering the holder synchronously, before ensureConnected's caller
  // ever awaits. This test fails on the pre-fix code (close() never called).
  it('a release() that lands while acquire() is still connecting does not leak the holder', async () => {
    const close = vi.fn();
    let resolveConnect: () => void = () => {};
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
          origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = () => ({
      state: 'ready' as const, lastError: null,
      connect: () => new Promise<void>((r) => { resolveConnect = r; }),
      listTools: () => [],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => { close(); },
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });
    const acquiring = mgr.acquire('s1');
    // Let acquire('s1') run past resolveAllEnabled() and register itself as
    // a holder, landing on the `await entry.connecting` suspension point —
    // connect() has NOT resolved yet.
    await new Promise<void>((r) => setImmediate(r));
    // release() arrives before connect() settles: the session was torn down
    // almost immediately after being created.
    await mgr.release('s1');
    resolveConnect();
    await acquiring;
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('a failing server does not prevent healthy ones from being returned', async () => {
    const registry = { resolveAllEnabled: async () => ([
      { id: 'bad', label: 'Bad', enabled: true, transport: { type: 'stdio', command: 'x' }, origin: { kind: 'user' }, missingSecrets: [] },
      { id: 'good', label: 'Good', enabled: true, transport: { type: 'stdio', command: 'y' }, origin: { kind: 'user' }, missingSecrets: [] },
    ] as any) };
    const connectionFactory = (s: any) => s.id === 'bad'
      ? { state: 'error', lastError: 'spawn x ENOENT', connect: async () => {}, listTools: () => [], callTool: async () => ({ text: '', isError: true }), close: async () => {} }
      : { state: 'ready', lastError: null, connect: async () => {}, listTools: () => [{ name: 't', inputSchema: { type: 'object' } }], callTool: async () => ({ text: 'ok', isError: false }), close: async () => {} };
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });
    const ready = await mgr.acquire('s1');
    expect(ready.map(r => r.id)).toEqual(['good']);
    expect(mgr.status().find(s => s.id === 'bad')?.error).toContain('ENOENT');
  });
});
