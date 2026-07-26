// User-initiated /compact for a native session (M3 item 2).
//
// The point of this path is that it REPLACES a silent no-op: before it existed,
// choosing /compact in a native session went to guardedPtySend, returned false,
// and vanished. So the load-bearing assertions here are as much about honest
// refusals as about the happy path.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import { ASSISTANT_PRESET } from '../src/shared/harness-manifest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { TranscriptEvent } from '../src/shared/types';

const OPTS = { sessionId: 's-1', cwd: '/tmp/x', harness: ASSISTANT_PRESET, binding: { providerId: 'openrouter', modelId: 'm' } };

function textModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 'p1' },
          { type: 'text-delta', id: 'p1', delta: text },
          { type: 'text-end', id: 'p1' },
          { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 5 }, outputTokens: { total: 3 } } },
        ],
      }),
    }),
  });
}

/** A session with `turns` user-delimited exchanges already in history. */
function seeded(turns: number, model: any) {
  const s = new HarnessSession(OPTS as any, async () => model);
  const history: any[] = [];
  for (let i = 0; i < turns; i++) {
    history.push({ role: 'user', content: `question ${i} ${'x'.repeat(400)}` });
    history.push({ role: 'assistant', content: `answer ${i} ${'y'.repeat(400)}` });
  }
  (s as any).history = history;
  return s;
}

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}

describe('HarnessSession.compactNow — user-initiated /compact', () => {
  it('summarizes, emits compact-summary, and replaces history with summary + recent turns', async () => {
    const session = seeded(4, textModel('Earlier: user asked about X; we did Y.'));
    const events = collect(session);

    const result = await session.compactNow();

    expect(result).toEqual({ ok: true });
    const marker = events.find((e) => e.type === 'compact-summary');
    expect(marker).toBeTruthy();
    expect((marker as any).data.summary).toContain('Earlier: user asked about X');

    const history = (session as any).history as any[];
    // First message is the summary; the last 2 user-delimited turns survive verbatim.
    expect(history[0].role).toBe('user');
    expect(history[0].content).toContain('[Earlier conversation summary]');
    expect(history.length).toBeLessThan(8);
  });

  it('does NOT tag the marker as autoCompaction — the manual path must use the ordinary pending route', async () => {
    // `autoCompaction` exists solely so a SPONTANEOUS compaction can bypass the
    // renderer's compactionPending guard. /compact already sets that flag, so
    // tagging it auto here would make the manual marker skip its own pending state.
    const session = seeded(4, textModel('a summary'));
    const events = collect(session);

    await session.compactNow();

    const marker = events.find((e) => e.type === 'compact-summary') as any;
    expect(marker.data.autoCompaction).toBeUndefined();
  });

  it('refuses with turn-in-flight rather than corrupting history mid-turn', async () => {
    const never = new ReadableStream({ start() { /* never closes */ } });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const session = seeded(4, model);

    const inFlight = session.send('hello');       // deliberately not awaited
    const result = await session.compactNow();
    expect(result).toEqual({ ok: false, reason: 'turn-in-flight' });

    session.interrupt();
    await inFlight;
  });

  it('refuses with nothing-to-compact when there are fewer than two turns', async () => {
    const session = seeded(1, textModel('unused'));
    expect(await session.compactNow()).toEqual({ ok: false, reason: 'nothing-to-compact' });
  });

  it('FAIL-SAFE: an empty summary leaves the conversation intact and reports summary-failed', async () => {
    // A small local model returning nothing must never cost the user their history.
    const session = seeded(4, textModel(''));
    const before = [...((session as any).history as any[])];
    const events = collect(session);

    const result = await session.compactNow();

    expect(result).toEqual({ ok: false, reason: 'summary-failed' });
    expect(events.find((e) => e.type === 'compact-summary')).toBeUndefined();
    const after = (session as any).history as any[];
    expect(after.length).toBe(before.length);     // no messages dropped
  });

  it('FAIL-SAFE: a throwing model reports summary-failed instead of propagating', async () => {
    const throwing = new MockLanguageModelV4({ doStream: async () => { throw new Error('model exploded'); } });
    const session = seeded(4, throwing);
    await expect(session.compactNow()).resolves.toEqual({ ok: false, reason: 'summary-failed' });
  });

  it('releases the abort controller so the session still works after a compaction', async () => {
    // compactNow takes this.abort for the duration; a leaked controller would
    // brick every later send() via the re-entrancy guard.
    const session = seeded(4, textModel('a summary'));
    await session.compactNow();
    expect((session as any).abort).toBeNull();
    await expect(session.send('still working?')).resolves.toBeUndefined();
  });

  it('releases the abort controller even when the summary fails', async () => {
    const throwing = new MockLanguageModelV4({ doStream: async () => { throw new Error('boom'); } });
    const session = seeded(4, throwing);
    await session.compactNow();
    expect((session as any).abort).toBeNull();
  });
});
