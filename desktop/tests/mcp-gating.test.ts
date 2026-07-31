import { describe, it, expect } from 'vitest';
import { makeSession } from './helpers/harness-fakes';
import { CLOUD_DEFAULT } from '../src/main/harness/capability-profile';

function servers(n: number, toolsEach = 5) {
  return Array.from({ length: n }, (_, i) => ({
    id: `srv${i}`, label: `Server ${i}`,
    tools: Array.from({ length: toolsEach }, (_, j) => ({
      name: `tool${j}`, description: 'x'.repeat(200), inputSchema: { type: 'object' },
    })),
    call: async () => ({ text: 'ok', isError: false }),
  }));
}

describe('MCP budget gating', () => {
  it('attaches every server when the window can afford them', async () => {
    const s = makeSession({ mcpServers: servers(2), contextLength: 200_000 });
    const names = Object.keys((s as any).buildAiTools());
    expect(names.filter(n => n.startsWith('mcp__srv0__'))).toHaveLength(5);
    expect(names.filter(n => n.startsWith('mcp__srv1__'))).toHaveLength(5);
    expect((s as any).droppedMcpServers).toEqual([]);
  });

  it('drops WHOLE servers, never a partial tool set', async () => {
    const s = makeSession({ mcpServers: servers(3), contextLength: 8_000 });
    const names = Object.keys((s as any).buildAiTools());
    for (const id of ['srv0', 'srv1', 'srv2']) {
      const n = names.filter(x => x.startsWith(`mcp__${id}__`)).length;
      expect([0, 5]).toContain(n); // all or nothing — never 1..4
    }
  });

  it('drops from the END of registry order, so the order is user-controllable', async () => {
    const s = makeSession({ mcpServers: servers(3), contextLength: 8_000 });
    const names = Object.keys((s as any).buildAiTools());
    const kept = ['srv0', 'srv1', 'srv2'].filter(id => names.some(n => n.startsWith(`mcp__${id}__`)));
    // Whatever fits, it must be a PREFIX of registry order.
    expect(kept).toEqual(['srv0', 'srv1', 'srv2'].slice(0, kept.length));
  });

  it('records which servers were dropped so the user can be told', async () => {
    const s = makeSession({ mcpServers: servers(3), contextLength: 8_000 });
    (s as any).buildAiTools();
    const dropped = (s as any).droppedMcpServers;
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((d: string) => d.startsWith('srv'))).toBe(true);
  });

  it('attaches no MCP tools at all to a tool-less model', async () => {
    const s = makeSession({ mcpServers: servers(1), supportsTools: false });
    expect(Object.keys((s as any).buildAiTools())).toEqual([]);
  });

  // Supplementary — NOT from the brief: `servers()` gives every server the
  // SAME per-tool cost, so with 3 uniform servers the one that overflows the
  // budget is always also the LAST one, and `break` vs a buggy `continue`
  // produce an IDENTICAL result (verified empirically while mutation-testing
  // the guard). That makes the brief's own fixture unable to distinguish the
  // two. This test uses a deliberately UNEVEN server (one tiny server after
  // a big one that doesn't fit) so a `continue` bug — which would let the
  // tiny server slip in AFTER skipping the big one — is actually observable:
  // it would keep srv0+srv2 and drop only srv1, which is NOT a prefix of
  // registry order.
  it('a later, cheaper server must not jump ahead of an earlier one that did not fit', async () => {
    const uneven = [
      ...servers(2),                         // srv0, srv1: 5 tools each (~295 tokens)
      { id: 'srv2', label: 'Server 2', tools: [{ name: 'tool0', description: 'x'.repeat(200), inputSchema: { type: 'object' } }], call: async () => ({ text: 'ok', isError: false }) }, // ~59 tokens
    ];
    // srv0 alone fits; srv0+srv1 does not; srv0+srv2 (skipping srv1) WOULD.
    const profile = { ...CLOUD_DEFAULT, mcpToolBudgetTokens: 400 };
    const s = makeSession({ mcpServers: uneven, profile });
    const names = Object.keys((s as any).buildAiTools());
    const kept = ['srv0', 'srv1', 'srv2'].filter(id => names.some(n => n.startsWith(`mcp__${id}__`)));
    expect(kept).toEqual(['srv0']);   // NOT ['srv0', 'srv2']
    expect((s as any).droppedMcpServers).toEqual(['srv1', 'srv2']);
  });

  // Supplementary — NOT from the brief: pins the "re-run per buildAiTools"
  // claim in syncMcpTools' own header comment (setBinding re-resolves the
  // profile, so a model swap must re-gate attached servers, exactly like
  // Skill). Nothing in the brief's own five tests calls setBinding, so a
  // regression that only re-syncs MCP tools ONCE (e.g. a stale memo/cache
  // guard) would ship unnoticed without this.
  it('re-gates on the NEXT buildAiTools after setBinding swaps to a smaller budget', async () => {
    const roomy = { ...CLOUD_DEFAULT, mcpToolBudgetTokens: 20_000 };
    const tight = { ...CLOUD_DEFAULT, mcpToolBudgetTokens: 750 };
    const s = makeSession({ mcpServers: servers(3), profile: roomy });
    const before = Object.keys((s as any).buildAiTools());
    expect(before.filter(n => n.startsWith('mcp__srv2__'))).toHaveLength(5); // fits under the roomy budget

    s.setBinding({ providerId: 'local', modelId: 'small' }, 8_000, tight);
    const after = Object.keys((s as any).buildAiTools());
    expect(after.filter(n => n.startsWith('mcp__srv2__'))).toHaveLength(0);  // dropped once the budget shrinks
    expect((s as any).droppedMcpServers.length).toBeGreaterThan(0);
  });
});
