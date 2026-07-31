import { describe, it, expect, vi } from 'vitest';
import { mcpToolsFor } from '../src/main/harness/mcp/mcp-tools';

function readyServer(over: Partial<any> = {}) {
  return {
    id: 'gmail', label: 'Gmail',
    tools: [{ name: 'search_threads', description: 'Search mail', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }],
    call: vi.fn().mockResolvedValue({ text: 'result', isError: false }),
    ...over,
  } as any;
}

describe('mcpToolsFor', () => {
  it('names tools mcp__{server}__{tool}', () => {
    expect(mcpToolsFor(readyServer())[0].name).toBe('mcp__gmail__search_threads');
  });

  it('passes the server schema through untranslated', () => {
    const t = mcpToolsFor(readyServer())[0];
    expect(t.rawInputSchema).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
  });

  it('has no permission subject, so a grant covers exactly this one tool', () => {
    expect(mcpToolsFor(readyServer())[0].permissionSubject({})).toBeUndefined();
  });

  it('calls through to the server with the tool short name', async () => {
    const s = readyServer();
    await mcpToolsFor(s)[0].execute({ q: 'x' }, { signal: new AbortController().signal } as any);
    expect(s.call).toHaveBeenCalledWith('search_threads', { q: 'x' }, expect.anything());
  });

  it('returns a server error as an error RESULT, never a throw', async () => {
    const s = readyServer({ call: vi.fn().mockRejectedValue(new Error('server died')) });
    const r = await mcpToolsFor(s)[0].execute({}, { signal: new AbortController().signal } as any);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('server died');
  });

  it('does not trust the server destructiveHint annotation as a permission signal', () => {
    const s = readyServer({ tools: [{ name: 'wipe', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] });
    // readOnlyHint comes from the SERVER. It must not become an allow rule.
    expect(mcpToolsFor(s)[0].permissionSubject({})).toBeUndefined();
  });
});
