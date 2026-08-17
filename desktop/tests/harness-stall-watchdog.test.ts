// HarnessSession streaming inactivity watchdog (native runtime). Pins the fix
// for the "stuck on Thinking, no error, no response" symptom: a provider that
// holds the socket open but stops emitting (OpenRouter keep-alive pings while an
// upstream stalls, a half-open connection after a suspend) sends no chunk, no
// finish, and no error — so without a watchdog the turn hangs forever with the
// spinner up. The watchdog warns after `stallWarningMs`, then after a further
// `stallCountdownMs` of silence auto-retries ONCE (when nothing had streamed) or
// surfaces a session-error. These use shortened watchdog timings (test hook) +
// REAL timers so there's no fake-timer/microtask juggling against live stream
// reads. "Shortened", NOT tiny — see STALL_MS for why that distinction cost a
// Windows CI run.
import { describe, it, expect, vi } from 'vitest';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { HarnessSession, type HarnessSessionOpts, StreamStallError } from '../src/main/harness/harness-session';
import type { HarnessManifest } from '../src/shared/harness-manifest';
import type { TranscriptEvent } from '../src/shared/types';
import { textChunks, finishChunk, stream } from './helpers/scripted-model';

// A raw V4 stream that emits the given chunks then DELIBERATELY never closes —
// the provider-went-silent case the watchdog exists for.
function hangingStream(...chunks: any[]) {
  return new ReadableStream({
    start(controller) {
      for (const c of [{ type: 'stream-start', warnings: [] }, ...chunks]) controller.enqueue(c);
      // no controller.close() — hang until the reader is cancelled.
    },
  });
}
// A normal completing stream from raw chunks.
function completingStream(...chunks: any[]) {
  return simulateReadableStream({ chunks: stream(...chunks) });
}
// A model that returns a DIFFERENT stream per doStream call (one per attempt).
function modelFromStreams(makers: Array<() => ReadableStream>) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const mk = makers[Math.min(call, makers.length - 1)];
      call++;
      return { stream: mk() };
    },
  });
}

// One named knob for the watchdog budget, deliberately generous.
//
// This was 15ms, which took Windows CI red on PR #185 with "expected length 1
// but got 2" and then passed on a plain re-run (ROADMAP :176). Nothing here
// asserts on wall-clock — only on the ORDER and COUNT of events — so the budget
// exists purely to be longer than the work, and a tight one buys nothing but
// flakes. Two things made 15ms untenable:
//
//   1. Windows' default timer resolution is ~15.6ms, so a setTimeout(15) fires
//      on the first tick AT OR PAST the budget. The warning timer and the
//      retry's first chunk landed in the same tick and the winner was scheduler
//      noise — hence Windows-only and re-run-green.
//   2. Measured headroom on an idle 32-core Linux box was thin anyway: sweeping
//      the budget, a spurious second warning first appears at 10ms and is the
//      majority outcome by 3ms. 15ms was ~4x the ideal path.
//
// 250ms is ~16x the Windows tick and ~60x the measured ideal path, and costs
// the file well under two seconds. Do NOT tighten these back toward the
// event-loop noise floor to save milliseconds.
const STALL_MS = 250;
// The "keeps emitting" case needs the opposite margin: its chunk SPACING must
// stay far below the window, or a scheduling hiccup between chunks fires the
// watchdog and fails a never-warns assertion. 4ms spacing vs a 400ms window.
const STREAMING_WINDOW_MS = 400;

// Raising the watchdog budgets moved the risk rather than removing it: the
// both-attempts-stall case now spends warn+countdown twice = ~1.0s of REAL time
// against vitest's default 5000ms testTimeout, i.e. ~5x headroom on a file that
// previously had ~300x. That is the same too-tight-budget bet this PR exists to
// kill, just one level up. Bound the test explicitly so only the watchdog
// constants above govern the outcome.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const HARNESS: HarnessManifest = {
  schema: 1, id: 'agent', name: 'Agent', systemPrompt: 'sys', tools: [],
  permissionPolicy: 'ask', limits: { maxTokens: 256 },
};
function makeOpts(over: Partial<HarnessSessionOpts>): HarnessSessionOpts {
  return {
    sessionId: 's-1', cwd: 'C:/x', harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'm' },
    retryDelays: [1, 1, 1],
    // Real timers (see the file header) with a budget that machine load cannot
    // close — see STALL_MS.
    stallWarningMs: STALL_MS, stallCountdownMs: STALL_MS,
    ...over,
  } as HarnessSessionOpts;
}
function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}
const types = (events: TranscriptEvent[]) => events.map((e) => e.type);
const stallWarnings = (events: TranscriptEvent[]) =>
  events.filter((e) => e.type === 'assistant-thinking' && e.data.stallWarning);
const stalledCards = (events: TranscriptEvent[]) =>
  events.filter((e) => e.type === 'assistant-thinking' && e.data.stalled === true);

// A parked turn's send() promise stays pending BY DESIGN — that is the whole
// feature. Poll the collected events instead of awaiting send(), then end the
// turn explicitly so the promise settles and the test can finish.
async function waitForEvent(
  events: TranscriptEvent[],
  pred: (e: TranscriptEvent) => boolean,
  timeoutMs = 30_000,
): Promise<TranscriptEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find(pred);
    if (hit) return hit;
    if (Date.now() > deadline) throw new Error('timed out waiting for event');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('HarnessSession — streaming inactivity watchdog', () => {
  it('silent stall with nothing streamed: warns (willRetry) then AUTO-RETRIES and completes', async () => {
    const model = modelFromStreams([
      () => hangingStream(),                                           // attempt 0: stalls silently
      () => completingStream(...textChunks('a', 'recovered'), finishChunk('stop')), // retry: succeeds
    ]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    // A stall warning was surfaced, promising a retry.
    const warns = stallWarnings(events);
    expect(warns).toHaveLength(1);
    expect(warns[0].data.stallWarning).toEqual({ retryInMs: STALL_MS, willRetry: true });
    // The retry produced the real answer and the turn completed normally.
    const text = events.find((e) => e.type === 'assistant-text');
    expect(text?.data.text).toBe('recovered');
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
  });

  it('stall on BOTH attempts: the auto-retry is spent, so the second stall PARKS', async () => {
    const model = modelFromStreams([() => hangingStream(), () => hangingStream(), () => hangingStream()]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');

    // Attempt 0 stalls with nothing streamed → silent auto-retry (unchanged).
    // Attempt 1 stalls with the retry spent → the card, not an error.
    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    const warns = stallWarnings(events);
    expect(warns).toHaveLength(2);
    expect(warns[0].data.stallWarning!.willRetry).toBe(true);
    expect(warns[1].data.stallWarning!.willRetry).toBe(false);
    expect(events.filter((e) => e.type === 'session-error')).toHaveLength(0);

    session.interrupt();
    await sent;
  });

  it('a stall AFTER output has started still says the model STOPPED responding', () => {
    // The complement of the case above: once parts have flowed, silence really
    // does mean something went wrong mid-stream, and the wording must say so.
    // Asserted on the error class directly — driving a real mid-stream stall
    // needs a provider that emits and then hangs forever, which makes the test
    // itself hang rather than prove anything extra.
    const err = new StreamStallError(75_000, 'streaming');
    expect(err.message).toMatch(/stopped responding/i);
    expect(err.message).not.toMatch(/didn't begin responding/i);
  });

  it('stall AFTER content already streamed: PARKS the turn instead of erroring', async () => {
    // One text delta lands, THEN the stream goes silent. This used to be a
    // session-error that ended the turn; now it raises the stalled card and the
    // turn stays alive with the reader still open.
    const model = modelFromStreams([() => hangingStream(...textChunks('a', 'partial answer'))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');

    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    // The partial text is still on screen, the warning did NOT promise a retry,
    // and NOTHING has ended the turn.
    expect(events.find((e) => e.type === 'assistant-text')?.data.text).toBe('partial answer');
    expect(stallWarnings(events)).toHaveLength(1);
    expect(stallWarnings(events)[0].data.stallWarning!.willRetry).toBe(false);
    expect(stalledCards(events)).toHaveLength(1);
    expect(types(events)).not.toContain('session-error');
    expect(types(events)).not.toContain('turn-complete');

    // Only the user ends it.
    session.interrupt();
    await sent;
    expect(types(events)).toContain('user-interrupt');
  });

  it('a stream that keeps emitting (slower than the warn window) NEVER trips the watchdog', async () => {
    // Chunks spaced 4ms apart, warn window 400ms → the watchdog is re-armed on
    // every chunk and never fires. No stall warning, clean completion.
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 4,
          chunks: stream(...textChunks('a', 'one'), ...textChunks('b', 'two'), finishChunk('stop')),
        }),
      }),
    });
    const session = new HarnessSession(makeOpts({ stallWarningMs: STREAMING_WINDOW_MS, stallCountdownMs: STREAMING_WINDOW_MS }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(stallWarnings(events)).toHaveLength(0);
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
  });

  it('a chunk arriving AFTER the card clears it and the turn completes normally', async () => {
    // A stream that emits, goes quiet past warn+countdown, then wakes up.
    let controller: ReadableStreamDefaultController<any>;
    const wakeable = new ReadableStream({
      start(c) {
        controller = c;
        for (const chunk of [{ type: 'stream-start', warnings: [] }, ...textChunks('a', 'half ')]) c.enqueue(chunk);
      },
    });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: wakeable }) });
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    const sent = session.send('go');

    await waitForEvent(events, (e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    // The provider wakes up on the SAME connection.
    for (const c of stream(...textChunks('a', 'a sentence'), finishChunk('stop'))) controller!.enqueue(c);
    controller!.close();

    await sent;
    expect(types(events)).toContain('turn-complete');
    expect(types(events)).not.toContain('session-error');
    // The clearing heartbeat (no stalled, no stallWarning) followed the card.
    const cardIdx = events.findIndex((e) => e.type === 'assistant-thinking' && e.data.stalled === true);
    const cleared = events.slice(cardIdx + 1).find(
      (e) => e.type === 'assistant-thinking' && !e.data.stalled && !e.data.stallWarning && !e.data.text,
    );
    expect(cleared).toBeDefined();
  });
});
