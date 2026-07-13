// HarnessSession v0 — the native runtime's turn loop (Phase 1 Plan A, Task 8).
// A plain Vercel AI SDK streamText call (NO tools) that emits the EXACT
// transcript-event protocol the chat reducer already consumes. These tests pin
// the emit surface — it's the contract Phase 2's tool agent must not move.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import { CHAT_PRESET } from '../src/shared/harness-manifest';
import type { TranscriptEvent } from '../src/shared/types';
// MockLanguageModelV4 + simulateReadableStream confirmed present in ai@7.0.22
// (node_modules/ai/dist/test/index.d.ts).
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';

function mockModel(parts: any[]) {
  return new MockLanguageModelV4({
    doStream: async () => ({ stream: simulateReadableStream({ chunks: parts }) }),
  });
}

// RAW provider (LanguageModelV4StreamPart) chunk shape — verified against
// @ai-sdk/provider in ai@7.0.22: deltas carry the chunk in `delta` (NOT `text`,
// which is the *transformed* fullStream field my implementation reads), and
// `finish.usage` is the nested V4 shape ({ inputTokens: { total }, outputTokens:
// { total } }). streamText transforms both into the flat forms the code consumes.
const TEXT_FINISH = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: 'p1' },
  { type: 'text-delta', id: 'p1', delta: 'Hel' },
  { type: 'text-delta', id: 'p1', delta: 'lo!' },
  { type: 'text-end', id: 'p1' },
  // V4 finish reason is an object ({ unified, raw }); a plain 'stop' string
  // normalizes to 'other'. streamText re-flattens .finishReason back to 'stop'.
  { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 12 }, outputTokens: { total: 4 } } },
];

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}

describe('HarnessSession', () => {
  const opts = { sessionId: 's-1', cwd: 'C:/x', harness: CHAT_PRESET, binding: { providerId: 'openrouter', modelId: 'm' } };

  it('send() emits user-message, merged-partId assistant-text deltas, and turn-complete with usage', async () => {
    const session = new HarnessSession(opts, async () => mockModel(TEXT_FINISH) as any);
    const events = collect(session);
    await session.send('hi');
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('user-message');
    expect(events[0].data.text).toBe('hi');
    const textEvents = events.filter((e) => e.type === 'assistant-text');
    expect(textEvents.length).toBeGreaterThanOrEqual(2);            // streamed as deltas, not one block
    expect(textEvents.every((e) => e.data.partId)).toBe(true);      // every delta carries the partId
    expect(textEvents.map((e) => e.data.text).join('')).toBe('Hello!');
    const done = events.find((e) => e.type === 'turn-complete')!;
    expect(done.data.usage).toMatchObject({ inputTokens: 12, outputTokens: 4 });
    expect(done.data.model).toBe('m');
    expect(typeof done.data.usage!.tokensPerSecond).toBe('number');
    expect(done.data.stopReason).toBe('end_turn');                  // 'stop' maps to CC's normal-completion name
  });

  it('a factory/stream failure emits session-error (never a hang) and ends the turn', async () => {
    const session = new HarnessSession(opts, async () => { throw new Error('OpenRouter needs an API key — add one in Settings → Providers.'); });
    const events = collect(session);
    await session.send('hi');
    const err = events.find((e) => e.type === 'session-error')!;
    expect(err.data.text).toMatch(/API key/);
    expect(events.find((e) => e.type === 'turn-complete')).toBeUndefined();
  });

  it('interrupt() aborts and emits user-interrupt instead of session-error', async () => {
    const never = new ReadableStream({ start() { /* never enqueues, never closes */ } });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const session = new HarnessSession(opts, async () => model as any);
    const events = collect(session);
    const sendP = session.send('hi');
    await new Promise((r) => setTimeout(r, 30));
    session.interrupt();
    await sendP;
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
    expect(events.some((e) => e.type === 'session-error')).toBe(false);
  });

  it('conversation history accumulates across turns (second call sees first exchange)', async () => {
    const seen: any[] = [];
    const factory = async () => new MockLanguageModelV4({
      doStream: async (req: any) => { seen.push(req.prompt); return { stream: simulateReadableStream({ chunks: TEXT_FINISH }) }; },
    }) as any;
    const session = new HarnessSession(opts, factory);
    collect(session);
    await session.send('first');
    await session.send('second');
    const secondPrompt = JSON.stringify(seen[1]);
    expect(secondPrompt).toContain('first');
    expect(secondPrompt).toContain('Hello!');
    expect(secondPrompt).toContain('second');
  });

  it('reasoning-delta emits assistant-thinking WITH text (the reducer reasoning path)', async () => {
    const REASON_THEN_TEXT = [
      { type: 'stream-start', warnings: [] },
      { type: 'reasoning-start', id: 'r1' },
      { type: 'reasoning-delta', id: 'r1', delta: 'thinking...' },
      { type: 'reasoning-end', id: 'r1' },
      { type: 'text-start', id: 'p1' },
      { type: 'text-delta', id: 'p1', delta: 'Answer' },
      { type: 'text-end', id: 'p1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ];
    const session = new HarnessSession(opts, async () => mockModel(REASON_THEN_TEXT) as any);
    const events = collect(session);
    await session.send('hi');
    const think = events.find((e) => e.type === 'assistant-thinking')!;
    expect(think.data.text).toBe('thinking...');
    expect(think.data.partId).toBeTruthy();
  });

  it('an error PART mid-stream emits session-error and ends the turn (distinct from a factory throw)', async () => {
    const ERROR_MIDSTREAM = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'p1' },
      { type: 'text-delta', id: 'p1', delta: 'partial ' },
      { type: 'error', error: new Error('upstream 502 from the provider') },
    ];
    const session = new HarnessSession(opts, async () => mockModel(ERROR_MIDSTREAM) as any);
    const events = collect(session);
    await session.send('hi');
    const err = events.find((e) => e.type === 'session-error')!;
    expect(err.data.text).toMatch(/502/);
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(false);   // an error is not an interrupt
    expect(events.find((e) => e.type === 'turn-complete')).toBeUndefined();
  });

  it('distinct text partIds are preserved per delta (deltas are not all merged under one id)', async () => {
    const TWO_PARTS = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: 'p1' },
      { type: 'text-delta', id: 'p1', delta: 'one' },
      { type: 'text-end', id: 'p1' },
      { type: 'text-start', id: 'p2' },
      { type: 'text-delta', id: 'p2', delta: 'two' },
      { type: 'text-end', id: 'p2' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } },
    ];
    const session = new HarnessSession(opts, async () => mockModel(TWO_PARTS) as any);
    const events = collect(session);
    await session.send('hi');
    const textEvents = events.filter((e) => e.type === 'assistant-text');
    expect(textEvents.map((e) => ({ id: e.data.partId, t: e.data.text }))).toEqual([
      { id: 'p1', t: 'one' },
      { id: 'p2', t: 'two' },
    ]);
  });

  it('send() while a turn is in flight rejects (callers must serialize)', async () => {
    const never = new ReadableStream({ start() { /* never closes — first turn stays in flight */ } });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const session = new HarnessSession(opts, async () => model as any);
    collect(session);
    const first = session.send('first');   // deliberately NOT awaited — stays in flight
    await expect(session.send('second')).rejects.toThrow(/serialize/i);
    // Clean up the dangling first turn so it doesn't leak into other tests.
    session.interrupt();
    await first;
  });
});
