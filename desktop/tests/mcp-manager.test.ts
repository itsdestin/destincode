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

  // Window A regression test: this leak shape reopens EARLIER than the
  // window fix pass 1 closed — before resolveAllEnabled() has even
  // resolved, so before any server (let alone a holder) exists yet. A
  // release() landing in that gap used to find an empty pool, no-op, and
  // then the resuming acquire() would register the holder anyway with
  // nobody left to ever release it. Fails on fix-pass-1 code (close() never
  // called); passes once release() waits for an in-flight acquire's
  // registration pass before touching holders.
  it('a release() that lands before resolveAllEnabled() resolves does not leak the holder', async () => {
    const close = vi.fn();
    let resolveRegistry: (servers: any[]) => void = () => {};
    const registry = {
      resolveAllEnabled: () => new Promise<any[]>((r) => { resolveRegistry = r; }),
    };
    const connectionFactory = () => ({
      state: 'ready' as const, lastError: null,
      connect: async () => {},
      listTools: () => [],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => { close(); },
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });
    const acquiring = mgr.acquire('s1');
    // release() arrives while acquire() is still stuck at its very FIRST
    // await — resolveAllEnabled() hasn't resolved, so the pool is empty and
    // no holder for 's1' exists anywhere yet. Deliberately NOT awaited here:
    // awaiting it before resolving the registry would deadlock (release()
    // would be waiting on a registration pass that can't run until the
    // registry resolves, which this line hasn't done yet).
    const releasing = mgr.release('s1');
    resolveRegistry([
      { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
        origin: { kind: 'user' }, missingSecrets: [] },
    ]);
    await releasing;
    await acquiring;
    expect(close).toHaveBeenCalledTimes(1);
  });

  // Window B regression test: the second earlier leak shape — in a
  // multi-server acquire(), awaiting one server's `connecting` used to
  // suspend BETWEEN servers, so a release() landing there would see the
  // holder for the server already reached but not the one still to come.
  // Fails on fix-pass-1 code (server "two" never gets released, close2
  // never called); passes once acquire() registers holders for every server
  // in one synchronous sweep before waiting on any connect().
  it('a release() that lands while the first of several servers is still connecting does not leak either holder', async () => {
    const close1 = vi.fn();
    const close2 = vi.fn();
    let resolveConnect1: () => void = () => {};
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'one', label: 'One', enabled: true, transport: { type: 'stdio', command: 'a' },
          origin: { kind: 'user' }, missingSecrets: [] },
        { id: 'two', label: 'Two', enabled: true, transport: { type: 'stdio', command: 'b' },
          origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = (s: any) => s.id === 'one'
      ? {
          state: 'ready' as const, lastError: null,
          connect: () => new Promise<void>((r) => { resolveConnect1 = r; }),
          listTools: () => [], callTool: async () => ({ text: '', isError: false }),
          close: async () => { close1(); },
        }
      : {
          state: 'ready' as const, lastError: null,
          connect: async () => {},
          listTools: () => [], callTool: async () => ({ text: '', isError: false }),
          close: async () => { close2(); },
        };
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });
    const acquiring = mgr.acquire('s1');
    // Let acquire() run past resolveAllEnabled() and reach the point of
    // waiting on server "one"'s connect() — server "two" has not settled
    // (in the old interleaved loop, it would not even have been touched
    // yet).
    await new Promise<void>((r) => setImmediate(r));
    await mgr.release('s1');
    resolveConnect1();
    await acquiring;
    expect(close1).toHaveBeenCalledTimes(1);
    expect(close2).toHaveBeenCalledTimes(1);
  });

  // Regression test for the "release() closes a connection a live acquire()
  // is about to hand back" premature-close: release() used to snapshot
  // inflightAcquires once and await it, then run its holder-clearing loop
  // unconditionally. A resumed session reuses its old session id, so a
  // release() for the outgoing instance and an acquire() for the incoming
  // one can genuinely race on the SAME sessionId. This test fails on a
  // single snapshot-and-await (close() gets called) and passes once
  // release() re-reads inflightAcquires in a loop until it is truly empty
  // before touching holders.
  it('a release() suspended waiting on a live acquire() does not close the connection that acquire hands back', async () => {
    const close = vi.fn();
    let resolveConnect: () => void = () => {};
    let resolveRegistry: (servers: any[]) => void = () => {};
    const servers = [
      { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
        origin: { kind: 'user' }, missingSecrets: [] },
    ];
    const registry = {
      resolveAllEnabled: () => new Promise<any[]>((r) => { resolveRegistry = r; }),
    };
    const connectionFactory = () => ({
      state: 'ready' as const, lastError: null,
      connect: () => new Promise<void>((r) => { resolveConnect = r; }),
      listTools: () => [],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => { close(); },
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });

    // 1. First acquire('s1') settles fully: 's1' holds a ready connection.
    const p1 = mgr.acquire('s1');
    await new Promise<void>((r) => setImmediate(r));
    resolveRegistry(servers);
    await new Promise<void>((r) => setImmediate(r));
    resolveConnect();
    const ready1 = await p1;
    expect(ready1).toHaveLength(1);

    // 2. A second acquire('s1') starts (the resumed session) and registers
    // itself in inflightAcquires, but is held at resolveAllEnabled() so it
    // hasn't registered its holder yet.
    const p2 = mgr.acquire('s1');
    await new Promise<void>((r) => setImmediate(r));

    // 3. release('s1') (the outgoing instance tearing down) is called NOW,
    // while acquire #2 is in flight — its snapshot of inflightAcquires is
    // non-empty, so it suspends on the await instead of running its
    // holder-clearing loop immediately.
    const releasing = mgr.release('s1');

    // 4. Let acquire #2 finish registering (and, since the pooled connection
    // is already ready with no pending connect, hand the connection straight
    // back) before release() gets to act.
    resolveRegistry(servers);

    const [ready2] = await Promise.all([p2, releasing]);
    expect(ready2).toHaveLength(1);
    // The connection acquire #2 just returned must still be usable — release()
    // must not have closed it out from under the caller that's holding it.
    expect(close).not.toHaveBeenCalled();
  });

  // Regression test for Finding 6: mcp-reconciler.ts's projectToClaudeJson
  // already skips a server with missingSecrets (a synced entry whose secret
  // ciphertext isn't on THIS device) so Claude Code never sees it — but
  // McpManager.acquire() connected it anyway with a partial env/headers
  // object, handing a real subprocess a missing token and surfacing whatever
  // opaque auth error IT emits instead of a message naming the actual
  // missing secret. Fails on the pre-fix code (connect IS called); passes
  // once ensureConnected treats missingSecrets as needs-setup without ever
  // touching connectionFactory.
  it('a server with missingSecrets is never connected and reports needs-setup naming the key', async () => {
    const connect = vi.fn();
    const registry = {
      resolveAllEnabled: async () => ([
        {
          id: 'gmail', label: 'Gmail', enabled: true,
          transport: { type: 'stdio', command: 'npx', args: ['gmail-mcp'] },
          origin: { kind: 'user' }, missingSecrets: ['GMAIL_TOKEN'],
        },
      ] as any),
    };
    // A connectionFactory that WOULD prove the bug if ever invoked — asserted
    // never-called below rather than merely unused, so a regression that
    // calls it is caught even if its behavior happens to look harmless.
    const connectionFactory = () => ({
      state: 'ready' as const, lastError: null,
      connect: async () => { connect(); },
      listTools: () => [{ name: 'search', inputSchema: { type: 'object' } }],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => {},
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });

    const ready = await mgr.acquire('s1');

    expect(connect).not.toHaveBeenCalled();
    expect(ready).toEqual([]); // excluded from the ready list, same as any other not-ready server
    const status = mgr.status().find((s) => s.id === 'gmail');
    expect(status?.state).toBe('needs-setup');
    expect(status?.error).toContain('GMAIL_TOKEN');
  });

  // Regression test for Minor 7 (Finding 7 in the fix-pass review): every
  // OTHER test in this file hardcodes `state: 'ready' as const` on its fake
  // connection — which is exactly why this exact bug was invisible to the
  // suite before this fix: with a hardcoded state, pass 2's
  // `entry.conn.state === 'ready'` check can never observe the effect of a
  // premature close(). This fake's `state` actually TRANSITIONS
  // (idle -> ready -> idle) the same way the real McpConnection does.
  //
  // Scenario: acquire('s1') registers (pass 1) and is then stuck in pass 2
  // awaiting connect(). A release('s1') lands in exactly that window — e.g.
  // the OUTGOING instance of a resumed session being torn down under the
  // same reused id, while the INCOMING instance's acquire() is still
  // connecting. `inflightAcquires` is already empty by this point (cleared
  // right after pass 1), so pre-fix, release() sees no reason to wait and
  // closes the connection immediately — the real close() resets state, so
  // pass 2's ready-check then reads 'idle', not 'ready', and the server is
  // silently dropped from what THIS acquire() hands back. Fails on the
  // pre-fix code (ready comes back empty); passes once release() defers to
  // the still-active acquire() instead of closing immediately.
  it('a release() racing an acquire() still in pass 2 does not close the connection out from under it', async () => {
    let state: 'idle' | 'ready' = 'idle';
    let closed = false;
    let resolveConnect: () => void = () => {};
    const closeCalls: number[] = [];
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'demo', label: 'Demo', enabled: true, transport: { type: 'stdio', command: 'node' },
          origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = () => ({
      get state() { return state; },
      lastError: null as string | null,
      // A close() that lands WHILE connect() is still in flight tears down
      // the underlying transport — a real subprocess/HTTP connection killed
      // mid-handshake does not go on to report success. Modeled here as
      // "closed wins": if close() ran first, the pending connect() no longer
      // flips state to 'ready'. (The real McpConnection.connect() has no
      // such guard today — a separate, narrower gap this fix does not
      // touch — so this fake's whole point is to make premature-close
      // observable at the McpManager level regardless of that gap.)
      connect: () => new Promise<void>((r) => { resolveConnect = () => { if (!closed) state = 'ready'; r(); }; }),
      listTools: () => [{ name: 'search', inputSchema: { type: 'object' } }],
      callTool: async () => ({ text: 'ok', isError: false }),
      close: async () => { closed = true; state = 'idle'; closeCalls.push(closeCalls.length + 1); },
    });
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });

    // acquire('s1') runs past resolveAllEnabled() and pass 1's registration
    // (which is synchronous), landing on `await entry.connecting` in pass 2 —
    // connect() has NOT resolved yet.
    const acquiring = mgr.acquire('s1');
    await new Promise<void>((r) => setImmediate(r));

    // release('s1') races it, exactly in the window inflightAcquires cannot
    // see (pass 1 already finished registering and cleared itself).
    const releasing = mgr.release('s1');

    resolveConnect();
    const [ready] = await Promise.all([acquiring, releasing]);
    // Let the deferred re-release (chained onto acquire's own settle
    // promise) finish running before asserting on it.
    await new Promise<void>((r) => setImmediate(r));

    // THE regression: pass 2 must have observed state === 'ready' — i.e.
    // close() must NOT have run yet — at the moment it decided whether to
    // include this server.
    expect(ready.map((r) => r.id)).toEqual(['demo']);
    // Not a leak either: the deferred release() still closes it once the
    // owning acquire() is done using it.
    expect(closeCalls.length).toBe(1);
  });

  // Regression test for Minor 9: `await entry.conn.close()` in release()'s
  // holder-clearing loop was unguarded — a close() that rejects (the real
  // McpConnection's never does, but the injected McpConnectionLike type
  // permits it) would throw OUT of the loop, stranding every remaining
  // holder release() had not yet reached in the SAME call. Fails on the
  // pre-fix code (release() rejects, and the second server's close() is
  // never even attempted); passes once the close() call is wrapped in its
  // own try/catch.
  it('a close() that rejects for one server does not strand the others in the same release() call', async () => {
    const closeGood = vi.fn();
    const registry = {
      resolveAllEnabled: async () => ([
        { id: 'bad', label: 'Bad', enabled: true, transport: { type: 'stdio', command: 'x' }, origin: { kind: 'user' }, missingSecrets: [] },
        { id: 'good', label: 'Good', enabled: true, transport: { type: 'stdio', command: 'y' }, origin: { kind: 'user' }, missingSecrets: [] },
      ] as any),
    };
    const connectionFactory = (s: any) => s.id === 'bad'
      ? { state: 'ready' as const, lastError: null, connect: async () => {}, listTools: () => [], callTool: async () => ({ text: '', isError: false }), close: async () => { throw new Error('close failed'); } }
      : { state: 'ready' as const, lastError: null, connect: async () => {}, listTools: () => [], callTool: async () => ({ text: '', isError: false }), close: async () => { closeGood(); } };
    const mgr = new McpManager({ registry: registry as any, connectionFactory: connectionFactory as any });

    await mgr.acquire('s1');
    await expect(mgr.release('s1')).resolves.toBeUndefined();
    expect(closeGood).toHaveBeenCalledTimes(1);
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
