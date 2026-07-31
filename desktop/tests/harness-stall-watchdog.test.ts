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

  it('stall on BOTH the first attempt and the retry: second warning is non-retry, ends in session-error', async () => {
    const model = modelFromStreams([() => hangingStream(), () => hangingStream(), () => hangingStream()]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    const warns = stallWarnings(events);
    expect(warns).toHaveLength(2);
    expect(warns[0].data.stallWarning!.willRetry).toBe(true);   // first: retry promised
    expect(warns[1].data.stallWarning!.willRetry).toBe(false);  // retry also stalled: no more retries
    const errs = events.filter((e) => e.type === 'session-error');
    expect(errs).toHaveLength(1);
    // WORDING CHANGED 2026-07-26, deliberately. Every attempt here uses
    // hangingStream(), so the model never produced a single part — it did not
    // "stop responding", it never began. Claiming otherwise sends the user
    // hunting a provider fault that isn't there, and on a local model the real
    // cause is usually just a long prompt. The mid-stream phrasing is still
    // pinned by the test below.
    expect(errs[0].data.text).toMatch(/didn't begin responding/i);
    expect(errs[0].data.text).not.toMatch(/stopped responding/i);
    expect(types(events)).not.toContain('turn-complete');
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

  it('stall AFTER content already streamed: does NOT retry (would duplicate), errors immediately', async () => {
    // One text delta lands, THEN the stream goes silent. A retry would re-stream
    // and duplicate the bubble, so the watchdog must go straight to error.
    const model = modelFromStreams([() => hangingStream(...textChunks('a', 'partial answer'))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');

    // The partial text was surfaced...
    expect(events.find((e) => e.type === 'assistant-text')?.data.text).toBe('partial answer');
    // ...the warning did NOT promise a retry...
    const warns = stallWarnings(events);
    expect(warns).toHaveLength(1);
    expect(warns[0].data.stallWarning!.willRetry).toBe(false);
    // ...and exactly one attempt ran (no duplicate answer) before the error.
    expect(events.filter((e) => e.type === 'assistant-text')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'session-error')).toHaveLength(1);
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
});
