import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { makeSession } from './helpers/harness-fakes';
import { defineTool } from '../src/main/harness/tools/registry';

// A tool carrying a raw JSON Schema must hand the model THAT schema verbatim,
// not a zod translation of it — the server owns its argument contract.
describe('buildAiTools raw schema passthrough', () => {
  it('sends rawInputSchema to the model when present', async () => {
    const raw = { type: 'object' as const, properties: { q: { type: 'string' } }, required: ['q'] };
    const tool = defineTool({
      name: 'mcp__demo__search',
      description: 'Search the demo server',
      inputSchema: z.object({}).passthrough(),
      rawInputSchema: raw,
      permissionSubject: () => undefined,
      execute: async () => ({ text: 'ok' }),
    });

    const session = makeSession({ extraTools: [tool] });
    const built = (session as any).buildAiTools();

    // The AI SDK wraps the schema; assert the server's own properties survived.
    expect(JSON.stringify(built['mcp__demo__search'].inputSchema)).toContain('"q"');
  });

  it('still uses the zod schema when no rawInputSchema is set', async () => {
    const session = makeSession({});
    const built = (session as any).buildAiTools();
    expect(built['Read']).toBeDefined();
    // Fix: verify that zodSchema() (not jsonSchema) was used by inspecting the
    // schema's JSON structure. jsonSchema() on a zod object produces Zod-internals
    // garbage with a "def" key; zodSchema() produces a proper JSON Schema with
    // "properties" and "required". This catches the wrong-converter regression that
    // substring matching would miss.
    const schema = built['Read'].inputSchema.jsonSchema;
    expect(schema.required).toContain('file_path');
    expect(schema.properties.file_path.type).toBe('string');
  });
});
