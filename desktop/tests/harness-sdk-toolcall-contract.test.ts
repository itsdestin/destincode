// Pins the ai@7 behaviors the Phase 2 turn driver depends on:
//  1. tools WITHOUT execute => fullStream emits a 'tool-call' part and the
//     step finishes with finishReason 'tool-calls' (the SDK does NOT loop).
//  2. the 'tool-call' part carries { toolCallId, toolName, input } where input
//     is the PARSED object (streamText parses the raw JSON-string args for us).
//  3. an assistant message with tool-call parts + a tool message with
//     tool-result parts round-trip through streamText messages.
// If an SDK bump breaks THIS test, fix the driver before anything else.
//
// Verified against ai@7.0.22 (see docs/provider-dependencies.md coupling row).
// Field-name notes discovered empirically for this spike:
//  - RAW provider chunk (LanguageModelV4ToolCall) carries `input` as a
//    STRINGIFIED JSON string; streamText transforms it into a parsed object on
//    the fullStream `tool-call` part (StaticToolCall.input = InferToolInput).
//  - RAW `finish` chunk's finishReason is the V4 OBJECT shape { unified, raw }
//    (a plain 'tool-calls' string does NOT type-check against the mock); the
//    streamText result flattens it back to the 'tool-calls' string.
//  - RAW `finish` usage is the nested V4 shape ({ inputTokens: { total }, ... }).
//  - The tool-result HISTORY message field is `output` (ToolResultPart.output:
//    ToolResultOutput), carrying { type: 'text', value } — NOT `result`.
import { describe, it, expect } from 'vitest';
import { streamText, tool, zodSchema } from 'ai';
// MockLanguageModelV4 + simulateReadableStream confirmed present in ai@7.0.22
// (node_modules/ai/dist/test/index.d.ts), same pattern as harness-session.test.ts.
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { z } from 'zod';

// RAW LanguageModelV4ToolCall chunk: `input` is a stringified JSON string.
const toolCallChunk = {
  type: 'tool-call' as const,
  toolCallId: 'call-1',
  toolName: 'Read',
  input: JSON.stringify({ file_path: '/tmp/x.ts' }),
};

describe('ai@7 tool-call stream contract (provider-dependencies row)', () => {
  it('emits tool-call part and finishReason tool-calls when tool has no execute', async () => {
    const result = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't1' },
              { type: 'text-delta', id: 't1', delta: 'Let me read that.' },
              { type: 'text-end', id: 't1' },
              toolCallChunk,
              // V4 finish reason is the { unified, raw } object; usage is nested.
              { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_calls' }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 5 } } },
            ],
          }),
        }),
      }),
      tools: { Read: tool({ description: 'read', inputSchema: zodSchema(z.object({ file_path: z.string() })) }) },
      prompt: 'read /tmp/x.ts',
    });
    const parts: any[] = [];
    for await (const p of result.fullStream) parts.push(p);
    const call = parts.find((p) => p.type === 'tool-call');
    expect(call).toBeTruthy();
    expect(call.toolName).toBe('Read');
    expect(call.toolCallId).toBe('call-1');
    // streamText parses the raw JSON-string args into an object here.
    expect(call.input).toEqual({ file_path: '/tmp/x.ts' });
    // Result flattens the V4 { unified, raw } object back to the 'tool-calls' string.
    expect(await result.finishReason).toBe('tool-calls');
  });

  it('accepts assistant tool-call + tool-result messages in history', async () => {
    const messages = [
      { role: 'user' as const, content: 'read it' },
      { role: 'assistant' as const, content: [
        { type: 'text' as const, text: 'Reading.' },
        // ToolCallPart.input is `unknown` (object form) in history messages.
        { type: 'tool-call' as const, toolCallId: 'call-1', toolName: 'Read', input: { file_path: '/tmp/x.ts' } },
      ] },
      { role: 'tool' as const, content: [
        // v7 ToolResultPart uses `output: ToolResultOutput` ({ type:'text', value }), NOT `result`.
        { type: 'tool-result' as const, toolCallId: 'call-1', toolName: 'Read', output: { type: 'text' as const, value: '1: hello' } },
      ] },
    ];
    const result = streamText({
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: simulateReadableStream({ chunks: [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'done' },
            { type: 'text-end', id: 't1' },
            { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
          ] }),
        }),
      }),
      tools: { Read: tool({ description: 'read', inputSchema: zodSchema(z.object({ file_path: z.string() })) }) },
      messages,
    });
    expect(await result.text).toBe('done');
  });
});
