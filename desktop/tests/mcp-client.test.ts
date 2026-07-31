import { describe, it, expect, vi } from 'vitest';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createConnection } from '../src/main/harness/mcp/mcp-client';

const server = {
  id: 'demo', label: 'Demo', enabled: true,
  transport: { type: 'stdio' as const, command: 'node', args: ['server.js'] },
  origin: { kind: 'user' as const }, missingSecrets: [] as string[],
};

function fakeClient(over: Partial<any> = {}) {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    listTools: vi.fn().mockResolvedValue({ tools: [
      { name: 'search', description: 'Search things', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
    ]}),
    callTool: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'hello' }] }),
    close: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe('McpConnection', () => {
  it('lists the server tools after connecting', async () => {
    const conn = createConnection(server, { clientFactory: () => fakeClient() as any });
    await conn.connect();
    expect(conn.state).toBe('ready');
    expect(conn.listTools().map(t => t.name)).toEqual(['search']);
  });

  it('flattens text content parts into one result string', async () => {
    const client = fakeClient({ callTool: vi.fn().mockResolvedValue({ content: [
      { type: 'text', text: 'line one' }, { type: 'text', text: 'line two' },
    ]}) });
    const conn = createConnection(server, { clientFactory: () => client as any });
    await conn.connect();
    const r = await conn.callTool('search', { q: 'x' }, new AbortController().signal);
    expect(r).toEqual({ text: 'line one\nline two', isError: false });
  });

  it('describes a non-text content part rather than dropping it silently', async () => {
    const client = fakeClient({ callTool: vi.fn().mockResolvedValue({ content: [
      { type: 'image', data: 'AAAA', mimeType: 'image/png' },
    ]}) });
    const conn = createConnection(server, { clientFactory: () => client as any });
    await conn.connect();
    const r = await conn.callTool('shot', {}, new AbortController().signal);
    expect(r.text).toContain('image/png');
    expect(r.isError).toBe(false);
  });

  it('surfaces the REAL connect failure, never a guessed cause', async () => {
    const client = fakeClient({ connect: vi.fn().mockRejectedValue(new Error('spawn npx ENOENT')) });
    const conn = createConnection(server, { clientFactory: () => client as any });
    await conn.connect();
    expect(conn.state).toBe('error');
    expect(conn.lastError).toContain('spawn npx ENOENT');
  });

  it('reports needs-setup when the server demands auth', async () => {
    const err = new Error('Unauthorized'); err.name = 'UnauthorizedError';
    const client = fakeClient({ connect: vi.fn().mockRejectedValue(err) });
    const conn = createConnection(
      { ...server, transport: { type: 'http', url: 'https://x.test/mcp' } },
      { clientFactory: () => client as any },
    );
    await conn.connect();
    expect(conn.state).toBe('needs-setup');
  });

  it('bounds a hung call so it cannot be mistaken for a stalled model', async () => {
    vi.useFakeTimers();
    const client = fakeClient({ callTool: vi.fn(() => new Promise(() => {})) }); // never settles
    const conn = createConnection(server, { clientFactory: () => client as any, callTimeoutMs: 1000 });
    await conn.connect();
    const p = conn.callTool('search', {}, new AbortController().signal);
    // This exercises the file's own BACKSTOP timer (the fake never rejects,
    // unlike a real SDK Client honoring `options.timeout`), so the advance
    // must clear callTimeoutMs (1000) PLUS the backstop's grace margin.
    await vi.advanceTimersByTimeAsync(2500);
    const r = await p;
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Demo');       // names the SERVER, so the user knows what hung
    expect(r.text).toContain('1000');       // and the bound it exceeded
    vi.useRealTimers();
  });

  it('abandons an in-flight call when the turn is interrupted', async () => {
    const client = fakeClient({ callTool: vi.fn(() => new Promise(() => {})) });
    const conn = createConnection(server, { clientFactory: () => client as any });
    await conn.connect();
    const ac = new AbortController();
    const p = conn.callTool('search', {}, ac.signal);
    ac.abort();
    const r = await p;
    expect(r.isError).toBe(true);
    // Pin CANCELLATION specifically — any rejection would satisfy isError
    // alone; the text must identify this as an abort, not a generic failure.
    expect(r.text).toContain('cancelled');
    expect(r.text).toContain('search');
  });

  it('forwards the abort signal and the call timeout to the SDK request options', async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    const client = fakeClient({ callTool });
    const conn = createConnection(server, { clientFactory: () => client as any, callTimeoutMs: 42_000 });
    await conn.connect();
    const ac = new AbortController();
    await conn.callTool('search', { q: 'x' }, ac.signal);
    // Assert the ACTUAL argument passed to the SDK call — not merely that
    // the mock was invoked. Position 2 (resultSchema) must stay `undefined`
    // so the SDK falls back to its default; position 3 must carry both the
    // live signal and our timeout bound, or a real Client would apply its
    // own 60s default instead and never send notifications/cancelled.
    expect(callTool).toHaveBeenCalledWith(
      { name: 'search', arguments: { q: 'x' } },
      undefined,
      { signal: ac.signal, timeout: 42_000 }
    );
  });

  it('translates the SDK\'s own request-timeout error into a message naming the server and bound', async () => {
    const timeoutError = new McpError(ErrorCode.RequestTimeout, 'MCP error -32001: Request timed out');
    const client = fakeClient({ callTool: vi.fn().mockRejectedValue(timeoutError) });
    const conn = createConnection(server, { clientFactory: () => client as any, callTimeoutMs: 5000 });
    await conn.connect();
    const r = await conn.callTool('search', {}, new AbortController().signal);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('Demo');   // names the server
    expect(r.text).toContain('5000');   // and the bound it exceeded
    expect(r.text).not.toContain('-32001'); // not the SDK's own opaque code/text
  });

  it('surfaces an ordinary tool-call error verbatim, without the timeout translation swallowing it', async () => {
    const client = fakeClient({ callTool: vi.fn().mockRejectedValue(new Error('ECONNRESET: socket hang up')) });
    const conn = createConnection(server, { clientFactory: () => client as any });
    await conn.connect();
    const r = await conn.callTool('search', {}, new AbortController().signal);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('ECONNRESET: socket hang up');
  });

  it('marks a tool error result as an error without throwing', async () => {
    const client = fakeClient({ callTool: vi.fn().mockResolvedValue({
      isError: true, content: [{ type: 'text', text: 'query rejected: bad syntax' }],
    }) });
    const conn = createConnection(server, { clientFactory: () => client as any });
    await conn.connect();
    const r = await conn.callTool('search', {}, new AbortController().signal);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('bad syntax');
  });
});
