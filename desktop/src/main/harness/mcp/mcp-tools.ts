// MCP tool adapter (spec: native MCP phase 1, Task 5). Turns the tools a
// ReadyServer (Task 4) hands back into ordinary NativeTools — the driver
// (Task 9), permission UI, and ToolCard renderer never know a tool came from
// an MCP server rather than being built into the app. Task 6 attaches the
// result to a session within estimateToolSchemaTokens' budget.
import { z } from 'zod';
import { defineTool } from '../tools/registry';
import type { NativeTool } from '../tools/types';
import type { ReadyServer } from './mcp-manager';

export function mcpToolsFor(server: ReadyServer): NativeTool[] {
  return server.tools.map((t) => defineTool({
    name: `mcp__${server.id}__${t.name}`,
    description: t.description ?? `${server.label}: ${t.name}`,
    // Permissive on purpose: the SERVER validates its own arguments and returns a
    // real error. A lossy local re-validation could reject a valid call.
    inputSchema: z.object({}).passthrough(),
    rawInputSchema: t.inputSchema,
    // undefined subject → a remembered "always allow" grants exactly this one
    // namespaced tool (subject-glob.ts:6). Deliberate: a server update can add a
    // destructive tool, and there is no revocation UI until M5 item 3. The
    // server's own annotations (readOnlyHint, destructiveHint) are IGNORED here
    // on purpose — a server is not a trusted authority about its own danger.
    permissionSubject: () => undefined,
    execute: async (args, ctx) => {
      const r = await server.call(t.name, args, ctx.signal);
      return { text: r.text, isError: r.isError };
    },
  }));
}

/** What a tool set costs in the request schema on EVERY turn. chars/4, the same
 *  deliberate estimate fitToContext uses (harness-session.ts, APPROX_CHARS_PER_TOKEN)
 *  — consistency with the budget it competes against matters more than accuracy here. */
export function estimateToolSchemaTokens(tools: NativeTool[]): number {
  const chars = tools.reduce((sum, t) =>
    sum + t.name.length + t.description.length + JSON.stringify(t.rawInputSchema ?? {}).length, 0);
  return Math.ceil(chars / 4);
}
