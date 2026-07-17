// Two-stage compaction wired into the driver (spec §4.4). These pin the driver
// SEAM: PRUNE-first stays silent (no compact-summary), SUMMARIZE emits exactly
// one compact-summary and keeps working, and a summary model call that throws is
// a NON-fatal fall-through (fitToContext remains the hard floor) — never a
// session-error. The compaction MATH itself is pinned in compaction.test.ts.
import { describe, it, expect } from 'vitest';
import { makeSession, scriptModel, drainTurn } from './helpers/harness-fakes';

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
});
