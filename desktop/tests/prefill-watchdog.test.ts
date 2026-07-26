// REGRESSION: a healthy local model declared dead while it was still reading the prompt.
//
// Found by Destin dogfooding 2026-07-26. Asking Qwen3.6-35B to summarize
// ROADMAP.md fed it a ~25k-token prompt; llama.cpp was still doing prefill when
// the streaming watchdog's 60s + 15s window expired, and the turn died with
// "The model stopped responding — no data received for 75 seconds."
//
// The model had never STARTED responding. Time-to-first-token and a mid-stream
// gap are different events with different normal durations, and the watchdog
// treated them identically. Prefill on a local model scales with prompt size and
// legitimately runs to minutes; a 60s gap AFTER tokens start really is a stall.
//
// Latent on master — Plan C doesn't touch the watchdog. Local models simply
// violate the timing assumptions it was tuned to (fast cloud providers).
import { describe, it, expect } from 'vitest';
import { prefillBudgetMs, StreamStallError } from '../src/main/harness/harness-session';

describe('prefillBudgetMs — time-to-first-token scales with the prompt', () => {
  it('gives a ROADMAP-sized prompt far more than the 75s that killed the turn', () => {
    // ~25k tokens is what a 100 KB tool result plus system prompt comes to.
    const budget = prefillBudgetMs(25_000);
    expect(budget).toBeGreaterThan(75_000);          // the failure being fixed
    expect(budget).toBeGreaterThan(8 * 60_000);      // minutes, not seconds
  });

  it('still allows a small prompt only a short wait — this stays a liveness check', () => {
    // A trivial prompt that produces nothing for 90s IS suspicious; the fix must
    // not turn the watchdog off.
    expect(prefillBudgetMs(0)).toBe(90_000);
    expect(prefillBudgetMs(500)).toBeLessThan(2 * 60_000);
  });

  it('is bounded, so a genuinely hung server still surfaces', () => {
    // Without a cap, a huge prompt would mean an effectively infinite hang.
    expect(prefillBudgetMs(10_000_000)).toBe(15 * 60_000);
  });

  it('grows monotonically with prompt size', () => {
    const sizes = [0, 1_000, 10_000, 50_000];
    const budgets = sizes.map(prefillBudgetMs);
    for (let i = 1; i < budgets.length; i++) {
      expect(budgets[i]).toBeGreaterThanOrEqual(budgets[i - 1]);
    }
  });

  it('treats a negative/garbage token count as zero rather than shrinking the budget', () => {
    expect(prefillBudgetMs(-5_000)).toBe(90_000);
  });
});

// ---------------------------------------------------------------------------
// Behavioral: the two silences must be judged by DIFFERENT budgets, and the
// error must name which one actually happened.
// ---------------------------------------------------------------------------
import { HarnessSession } from '../src/main/harness/harness-session';
import { ASSISTANT_PRESET } from '../src/shared/harness-manifest';
import { MockLanguageModelV4 } from 'ai/test';
import type { TranscriptEvent } from '../src/shared/types';

const OPTS = { sessionId: 's-1', cwd: '/tmp/x', harness: ASSISTANT_PRESET, binding: { providerId: 'local', modelId: 'Qwen3.6-35B-A3B' } };

/** A stream that waits `delayMs` before its first part, then optionally emits text. */
function slowFirstChunk(delayMs: number, thenEmit: boolean) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        async start(c) {
          // thenEmit=false models a REAL stall: the provider holds the socket
          // open and never sends anything. Closing instead would be a clean
          // end-of-stream, which is a different code path entirely.
          if (!thenEmit) return;
          await new Promise((r) => setTimeout(r, delayMs));
          if (thenEmit) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: 'p1' });
            c.enqueue({ type: 'text-delta', id: 'p1', delta: 'hi' });
            c.enqueue({ type: 'text-end', id: 'p1' });
            c.enqueue({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } } });
          }
          c.close();
        },
      }) as any,
    }),
  });
}

describe('prefill vs mid-stream silence', () => {
  // SCOPE NOTE: these two exercise the wiring end-to-end but do NOT discriminate
  // which budget was applied — the AI SDK's own inter-part gaps are hundreds of
  // milliseconds, so a budget small enough to tell them apart makes the test
  // flaky rather than sharper. The SIZING is pinned by the prefillBudgetMs unit
  // tests above and the phase wording by the StreamStallError tests below; these
  // guard that a slow first token still completes and still announces itself.
  it('a slow first token inside the prefill budget completes normally', async () => {
    // The whole point: this exact shape used to die at 75s.
    const s = new HarnessSession(
      { ...OPTS, prefillWarningMs: 2_000, stallWarningMs: 5_000, stallCountdownMs: 5_000, retryDelays: [] } as any,
      async () => slowFirstChunk(700, true) as any,
    );
    const events: TranscriptEvent[] = [];
    s.on('transcript-event', (e: TranscriptEvent) => events.push(e));

    await s.send('summarize roadmap');

    expect(events.some((e) => e.type === 'session-error')).toBe(false);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('announces prompt processing BEFORE the first token, so the UI can say so', async () => {
    // Needs a prompt over the notice threshold — the point of the notice is a wait
    // long enough to look like a hang, so a tiny prompt deliberately stays silent
    // (see the "small prompt" case below).
    const s = new HarnessSession(
      { ...OPTS, systemPrompt: 'S'.repeat(20_000), prefillWarningMs: 2_000, stallWarningMs: 5_000, stallCountdownMs: 5_000, retryDelays: [] } as any,
      async () => slowFirstChunk(700, true) as any,
    );
    const events: TranscriptEvent[] = [];
    s.on('transcript-event', (e: TranscriptEvent) => events.push(e));

    await s.send('summarize roadmap');

    const prefill = events.find((e) => (e.data as any)?.promptProcessing);
    expect(prefill).toBeTruthy();
    expect((prefill!.data as any).promptProcessing.promptTokens).toBeGreaterThan(0);
  });

  it('a SMALL prompt stays silent — the frozen emit sequence is unchanged', async () => {
    // harness-session-loop.test.ts pins the exact event order for ordinary turns;
    // announcing prefill on every step would break that contract for no benefit.
    const s = new HarnessSession(
      { ...OPTS, prefillWarningMs: 2_000, stallWarningMs: 5_000, stallCountdownMs: 5_000, retryDelays: [] } as any,
      async () => slowFirstChunk(50, true) as any,
    );
    const events: TranscriptEvent[] = [];
    s.on('transcript-event', (e: TranscriptEvent) => events.push(e));

    await s.send('hi');

    expect(events.find((e) => (e.data as any)?.promptProcessing)).toBeUndefined();
  });

  it('names the PREFILL phase honestly — a model that never started has not "stopped"', () => {
    // Deterministic wording guard. The full end-to-end variant was dropped: it
    // needed a provider that hangs forever, which makes the test itself hang
    // rather than proving anything extra. The phase plumbing is exercised by the
    // two cases above; this pins the copy the user actually reads.
    const prefill = new StreamStallError(600_000, 'prefill', 25_000);
    expect(prefill.message).not.toContain('stopped responding');
    expect(prefill.message).toContain("didn't begin responding");
    expect(prefill.message).toContain('25,000-token');
    // Actionable: says what to do, per docs/error-message-standards.md.
    expect(prefill.message).toMatch(/Grep|shorter prompt/);
  });

  it('still says "stopped responding" for a genuine MID-STREAM stall', () => {
    const streaming = new StreamStallError(75_000, 'streaming');
    expect(streaming.message).toContain('stopped responding');
    expect(streaming.message).toContain('75 seconds');
  });
});
