// Shared scripted-mock helper for HarnessSession tests (extracted from
// harness-session-loop.test.ts so the loop test AND the history-rebuild test
// drive the exact same mock model). These builders emit the RAW LanguageModelV4
// stream-part shape (per the ai@7 contract test): text needs
// stream-start/text-start/delta/text-end framing; a tool-call's input is a JSON
// STRING; finish carries finishReason as { unified, raw } plus nested usage.
// streamText transforms all of these for the fullStream the driver consumes.
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

/** text-start/delta/end framing for one text bubble with the given part id.
 *  A single delta per block → ONE assistant-text event emitted per call, so the
 *  raw emitted stream already matches what SessionStore.readEvents coalesces
 *  (one event per partId). */
export function textChunks(id: string, text: string) {
  return [
    { type: 'text-start', id },
    { type: 'text-delta', id, delta: text },
    { type: 'text-end', id },
  ];
}

/** Multi-delta variant of textChunks: emits ONE text-delta part per string in
 *  `texts`, all sharing `id`. Used to script a child that streams a report
 *  across multiple chunks — regression coverage for the reducer's
 *  same-partId coalescing (chat-reducer.ts applySubagentEvent), which
 *  textChunks' single-delta framing can't exercise. */
export function multiDeltaTextChunks(id: string, ...texts: string[]) {
  return [
    { type: 'text-start', id },
    ...texts.map((delta) => ({ type: 'text-delta', id, delta })),
    { type: 'text-end', id },
  ];
}

/** reasoning-start/delta/end framing for one reasoning (thinking) block —
 *  mirrors textChunks. Raw LanguageModelV4 part shape verified against
 *  @ai-sdk/provider typings: { type: 'reasoning-delta', id, delta }.
 *  Added for the empty-step-recovery suite: a step that THINKS and then says
 *  nothing must classify as empty (spec 2026-08-21, §4 Part 1). */
export function reasoningChunks(id: string, text: string) {
  return [
    { type: 'reasoning-start', id },
    { type: 'reasoning-delta', id, delta: text },
    { type: 'reasoning-end', id },
  ];
}

/** One tool-call part. `input` is serialized to a JSON string (the raw shape);
 *  streamText parses it back to an object before the driver sees it. */
export function toolCallChunk(toolCallId: string, toolName: string, input: unknown) {
  return { type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) };
}

/** tool-input-start / delta(s) / end framing for ONE tool call's argument
 *  stream, using the RAW provider part shape (`id` + `delta`, NOT the
 *  UIMessageChunk `toolCallId` + `inputTextDelta`). streamText forwards these
 *  onto fullStream unchanged. Pair with toolCallChunk() for the completed call:
 *  a real provider emits both, and the driver needs the completed part to
 *  actually run the tool. */
export function toolInputChunks(toolCallId: string, toolName: string, ...deltas: string[]) {
  return [
    { type: 'tool-input-start', id: toolCallId, toolName },
    ...deltas.map((delta) => ({ type: 'tool-input-delta', id: toolCallId, delta })),
    { type: 'tool-input-end', id: toolCallId },
  ];
}

export function finishChunk(reason: string, inTok = 1, outTok = 1) {
  return { type: 'finish', finishReason: { unified: reason, raw: reason }, usage: { inputTokens: { total: inTok }, outputTokens: { total: outTok } } };
}

/** A full scripted stream (one streamText call). */
export function stream(...chunks: any[]) {
  return [{ type: 'stream-start', warnings: [] }, ...chunks];
}

/** A model whose doStream returns a DIFFERENT scripted stream per call, driven
 *  by a call counter — this is how one turn drives multiple steps. Also records
 *  the prompt each call saw (for history assertions). */
export function scriptedModel(scripts: any[][], seenPrompts?: any[]) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async (req: any) => {
      seenPrompts?.push(req.prompt);
      const chunks = scripts[Math.min(call, scripts.length - 1)];
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}
