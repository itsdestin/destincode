// Two-stage compaction wired into the driver (spec §4.4). These pin the driver
// SEAM: PRUNE-first stays silent (no compact-summary), SUMMARIZE emits exactly
// one compact-summary and keeps working, and a summary model call that throws is
// a NON-fatal fall-through (fitToContext remains the hard floor) — never a
// session-error. The compaction MATH itself is pinned in compaction.test.ts.
import { describe, it, expect } from 'vitest';
import { makeSession, scriptModel, drainTurn, hangingFirstCallModel } from './helpers/harness-fakes';

describe('driver compaction', () => {
  it('prunes when last step reports high input tokens — no compact-summary', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 8192, onEvent: (e) => events.push(e),
      model: scriptModel([
        { toolCalls: [{ name: 'Read', input: { file_path: 'big.txt' } }], usage: { inputTokens: 7000 } },
        { text: 'done' },
      ]),
    });
    await drainTurn(session, 'read the big file');
    expect(events.some((e) => e.type === 'compact-summary')).toBe(false);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('emits compact-summary and keeps working when pruning is insufficient', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
      model: scriptModel([{ text: 'SUMMARY: user wants X; did Y.' }, { text: 'here is the answer' }]),
    });
    await drainTurn(session, 'continue');
    expect(events.filter((e) => e.type === 'compact-summary')).toHaveLength(1);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('FAIL-SAFE: a summary call that throws does not error the turn (falls through to truncation)', async () => {
    const events: any[] = [];
    const session = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
      model: scriptModel([{ throwError: 'summary model exploded' }, { text: 'answer anyway' }]),
    });
    await drainTurn(session, 'continue');
    expect(events.some((e) => e.type === 'session-error')).toBe(false);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('C1: a STALLED summary stream never wedges the turn — interrupt ends it and the session survives', async () => {
    // The summary runs on the same (here: stalled) model. A bare `for await`
    // would block forever; the abort-raced consumption must let interrupt() end
    // the turn, and the session must NOT stay bricked (abort cleared → a later
    // send does not throw the re-entrancy guard).
    const events: any[] = [];
    let hung = false;
    const session = makeSession({
      contextLength: 4096, seedBulkHistoryTokens: 6000, onEvent: (e) => events.push(e),
      model: hangingFirstCallModel(() => { hung = true; }),
    });
    const p = drainTurn(session, 'continue');
    while (!hung) await new Promise((r) => setTimeout(r, 2));   // wait until the summary stream stalls
    session.interrupt();
    await p;                                                    // MUST resolve, not hang
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
    expect(events.some((e) => e.type === 'compact-summary')).toBe(false);  // stalled → no summary emitted
    // Not bricked: a follow-up send completes cleanly on the same session.
    await drainTurn(session, 'again');
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('I3 thrash guard: a keep-dominated history summarizes AT MOST once per turn (not once per step)', async () => {
    // Recent turns alone exceed the trigger (usage 3500 > 4096*0.75), so
    // planCompaction says "summarize" every step — but the CONDENSABLE span (the
    // few small messages before the last-2-turn boundary) is trivial. Without the
    // guard that would fire a summary model-call + a dead compact-summary EVERY
    // step (~one per step); the guard caps it at one (here: zero) per turn.
    const events: any[] = [];
    const session = makeSession({
      contextLength: 4096, onEvent: (e) => events.push(e),
      model: scriptModel([
        { toolCalls: [{ name: 'Read', input: { file_path: 'a.txt' } }], usage: { inputTokens: 3500 } },
        { toolCalls: [{ name: 'Read', input: { file_path: 'b.txt' } }], usage: { inputTokens: 3500 } },
        { toolCalls: [{ name: 'Read', input: { file_path: 'c.txt' } }], usage: { inputTokens: 3500 } },
        { text: 'done' },
      ]),
    });
    // Tiny condensable span (<500 tokens) before the last-2-turn boundary.
    session.seedHistory([
      { role: 'assistant', content: 'aa' } as any,
      { role: 'user', content: 'u1' } as any,
      { role: 'assistant', content: 'bb' } as any,
      { role: 'user', content: 'u2' } as any,
    ]);
    await drainTurn(session, 'go');
    expect(events.filter((e) => e.type === 'compact-summary').length).toBeLessThanOrEqual(1);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });
});
