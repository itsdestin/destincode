// Pins the arithmetic relationship between the three coupled handoff constants.
//
// A takeover has the holder do two slow things in sequence before it releases
// the lease: wait for the interrupted turn to stop growing the transcript
// (QUIESCE_MAX_MS), then genuinely await the personal-space git push
// (HANDOFF_SYNC_TIMEOUT_MS). Meanwhile the requester polls for the release and
// gives up after REQUESTER_MAX_MS, at which point it offers the user a FORCE.
//
// So the requester's budget must exceed the holder's worst-case cost, or a
// perfectly healthy handoff trips the force dialog — which is exactly the bug
// PR #176 fixed by raising the budget 10s -> 25s once the push became awaited.
//
// Until now this coupling lived only in prose comments at all three definition
// sites (2026-07-18 review: "documented in comments at all three sites, pinned
// by no test"). Prose does not fail CI. Lowering any one of these — or raising
// either holder cost — now breaks this test instead of silently re-introducing
// a force dialog on healthy holders.
import { describe, it, expect } from 'vitest';
import { QUIESCE_MAX_MS, HANDOFF_SYNC_TIMEOUT_MS } from '../src/main/conversations/service';
import { REQUESTER_MAX_MS } from '../src/main/conversations/takeover';

describe('handoff timing contract', () => {
  it('the requester budget exceeds the holder worst case (quiesce + awaited push)', () => {
    const holderWorstCase = QUIESCE_MAX_MS + HANDOFF_SYNC_TIMEOUT_MS;
    expect(REQUESTER_MAX_MS).toBeGreaterThan(holderWorstCase);
  });

  it('keeps a real slack margin, not a hairline pass', () => {
    // A budget that only just clears the sum leaves nothing for poll granularity
    // (1s), hub round-trips, or a slow disk — the force dialog would fire on
    // healthy-but-unlucky handoffs. 2s is the minimum margin the current values
    // were chosen to preserve (25_000 - 21_000 = 4_000).
    const slack = REQUESTER_MAX_MS - (QUIESCE_MAX_MS + HANDOFF_SYNC_TIMEOUT_MS);
    expect(slack).toBeGreaterThanOrEqual(2_000);
  });

  it('documents the values these fixes were sized against', () => {
    // Not a style assertion — a tripwire. If someone retunes a constant, this
    // failure points them at the comment blocks explaining WHY it was that value
    // (PR #176: the old 10s budget predated the push actually being awaited).
    expect(QUIESCE_MAX_MS).toBe(6_000);
    expect(HANDOFF_SYNC_TIMEOUT_MS).toBe(15_000);
    expect(REQUESTER_MAX_MS).toBe(25_000);
  });
});
