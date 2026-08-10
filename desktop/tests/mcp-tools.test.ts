import { describe, it, expect, vi } from 'vitest';
import { mcpToolsFor, estimateToolSchemaTokens } from '../src/main/harness/mcp/mcp-tools';

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

  // BLOCKER fix (2026-08-06): mcpToolsFor wraps every tool with defineTool, so
  // execute() below already runs through the SAME truncation pipeline every
  // native tool does — this test drives it end-to-end, not just checking the
  // static property. Before the fix, an MCP tool had no `moreHint` and never
  // set `bounds` (the server decides result size, not this file), so a big
  // response hit composeNotice's bare fallback with zero widening advice —
  // the fourth measured route into that branch. 60,000 chars against the
  // inherited 30,000-char default cap guarantees the pipeline cap fires.
  it('a result past the pipeline cap carries real widening advice, never the bare no-advice notice', async () => {
    const s = readyServer({ call: vi.fn().mockResolvedValue({ text: 'x'.repeat(60_000), isError: false }) });
    const tool = mcpToolsFor(s)[0];
    const r = await tool.execute({ q: 'x' }, { signal: new AbortController().signal } as any);
    expect(r.text).toContain('output truncated: showing');
    // The bare fallback string composeNotice renders when NEITHER a per-call
    // bound NOR a static moreHint is available — must never appear now that
    // mcpToolsFor supplies the static fallback.
    expect(r.text).not.toMatch(/\[output truncated: showing \d+ of \d+ chars\]$/m);
    expect(r.text).toContain(' — ');
    // Honest per the brief: general and non-committal, never a guessed
    // parameter name from the server's own (untranslated) schema.
    expect(r.text).not.toMatch(/\boffset\b|\blimit\b/);
  });
});

describe('estimateToolSchemaTokens', () => {
  it('returns 0 for an empty tool list', () => {
    // Fix: catch overly-optimistic schema budget that would silently drop MCP servers
    // from the model's context with no error shown to the user.
    expect(estimateToolSchemaTokens([])).toBe(0);
  });

  it('pins the exact arithmetic: (name + description + JSON(rawInputSchema)) / 4 ceiling', () => {
    // Fix: prevent silent context-budget regressions from wrong divisor, wrong fallback,
    // or schema omission that would drop tools from context or exceed the budget silently.
    const tools = mcpToolsFor(readyServer({
      id: 'test',
      label: 'Test',
      tools: [{ name: 'add', description: 'Add two numbers', inputSchema: { type: 'object' } }]
    }));
    // Expected: mcp__test__add (13) + Add two numbers (15) + {"type":"object"} (17) = 45 / 4 = 11.25 -> ceil = 12
    expect(estimateToolSchemaTokens(tools)).toBe(12);
  });

  it('still counts name and description when rawInputSchema is missing, falling back to {}', () => {
    // Fix: prevent regression if rawInputSchema fallback (?? {}) is dropped,
    // causing JSON.stringify(undefined) or thrown errors.
    const tools = mcpToolsFor(readyServer({
      id: 'test',
      label: 'Test',
      tools: [{ name: 'add', description: 'Add two numbers' }]  // no inputSchema
    }));
    // Expected: mcp__test__add (13) + Add two numbers (15) + {} (2) = 30 / 4 = 7.5 -> ceil = 8
    expect(estimateToolSchemaTokens(tools)).toBe(8);
  });
});
