import { describe, it, expect } from 'vitest';
import { projectToClaudeJson } from '../src/main/mcp-reconciler';

// OWNER DECISION (2026-07-30, overrides the task brief's per-entry marker):
// ownership lives in a TOP-LEVEL `_youcodedOwnedMcpServers: string[]` key, not
// a per-entry `_youcoded: true` flag. Claude Code demonstrably tolerates
// arbitrary top-level keys (Destin's real ~/.claude.json carries 59) but
// whether it tolerates an unknown key INSIDE an mcpServers entry is
// unverified — writing one there could silently break MCP loading in his live
// sessions if its per-entry schema turns out to be strict. Server entries stay
// schema-clean; every test below asserts against the top-level list instead.

describe('projection into ~/.claude.json', () => {
  it('writes an enabled registry server into mcpServers', () => {
    const out = projectToClaudeJson({}, [
      { id: 'gmail', label: 'Gmail', enabled: true, transport: { type: 'stdio', command: 'npx', args: ['gmail-mcp'] }, origin: { kind: 'user' }, missingSecrets: [] } as any,
    ]);
    expect(out.mcpServers!.gmail).toMatchObject({ type: 'stdio', command: 'npx' });
    expect(out._youcodedOwnedMcpServers).toEqual(['gmail']);
  });

  it('NEVER modifies an entry it does not own', () => {
    const existing = { mcpServers: { handwritten: { type: 'stdio', command: 'my-thing' } } };
    const out = projectToClaudeJson(existing, []);
    expect(out.mcpServers!.handwritten).toEqual({ type: 'stdio', command: 'my-thing' });
  });

  it('removes an owned entry that left the registry', () => {
    const existing = {
      mcpServers: { gone: { type: 'stdio', command: 'x' } },
      _youcodedOwnedMcpServers: ['gone'],
    };
    const out = projectToClaudeJson(existing, []);
    expect(out.mcpServers!.gone).toBeUndefined();
  });

  it('does not project a server with missing secrets', () => {
    const out = projectToClaudeJson({}, [
      { id: 'gmail', label: 'Gmail', enabled: true, transport: { type: 'stdio', command: 'npx' }, origin: { kind: 'user' }, missingSecrets: ['GMAIL_TOKEN'] } as any,
    ]);
    expect(out.mcpServers!.gmail).toBeUndefined();
    expect(out._youcodedOwnedMcpServers ?? []).not.toContain('gmail');
  });

  // Defensive contract test for a guard this task adds beyond the brief's
  // four cases: resolveAllEnabled() already filters disabled servers before
  // calling projectToClaudeJson, but the pure function's OWN contract must
  // not depend on that — a disabled entry must never be projected even if a
  // future caller passes an unfiltered list by mistake.
  it('does not project a disabled registry server', () => {
    const out = projectToClaudeJson({}, [
      { id: 'gmail', label: 'Gmail', enabled: false, transport: { type: 'stdio', command: 'npx' }, origin: { kind: 'user' }, missingSecrets: [] } as any,
    ]);
    expect(out.mcpServers!.gmail).toBeUndefined();
    expect(out._youcodedOwnedMcpServers ?? []).not.toContain('gmail');
  });

  // Fifth case (owner-added): the owned-id list is itself just a top-level
  // key, so a user hand-editing the file around it must not break projection
  // — unrelated keys survive, and a stale ownership record naming a server
  // the user already deleted by hand must not crash or resurrect it.
  it('survives a user hand-editing the file around the owned-id list', () => {
    const existing = {
      mcpServers: {}, // user deleted the 'gmail' entry by hand
      _youcodedOwnedMcpServers: ['gmail'], // stale record left behind
      someUserSetting: 'kept',
      numStartups: 42,
    };
    // 'gmail' isn't in this run's registry either (disabled, removed, or
    // simply never resolved) — nothing should try to recreate it.
    const out = projectToClaudeJson(existing, []);
    expect(out.mcpServers).toEqual({});
    expect(out.mcpServers!.gmail).toBeUndefined();
    expect(out.someUserSetting).toBe('kept');
    expect(out.numStartups).toBe(42);
  });
});
