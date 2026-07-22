// desktop/tests/sync-space-error-summary.test.ts
import { describe, it, expect } from 'vitest';
import { summarizeSpaceSyncError } from '../src/renderer/components/sync-space-error-summary';

describe('summarizeSpaceSyncError', () => {
  it('classifies a stale-lock / interrupted-write error as self-healing (no cause invented)', () => {
    const raw =
      "Sync merge could not complete for personal: fatal: Unable to create " +
      "'C:\\Users\\x\\.youcoded\\sync.git/index.lock': File exists. Another git " +
      "process seems to be running in this repository";
    const s = summarizeSpaceSyncError(raw);
    expect(s.interrupted).toBe(true);
    // Friendly + accurate (we KNOW the cause) + tells the user it self-heals.
    expect(s.summary.toLowerCase()).toContain('interrupted');
    expect(s.summary.toLowerCase()).toMatch(/on its own|automatically|few minutes/);
    // It must NOT dump the raw git text as the summary.
    expect(s.summary).not.toContain('index.lock');
  });

  it('classifies a bare ref-lock collision as interrupted too', () => {
    const s = summarizeSpaceSyncError("fatal: Unable to create '.../refs/heads/main.lock': File exists");
    expect(s.interrupted).toBe(true);
  });

  it('an unknown error stays non-committal and points to the report path (no invented cause)', () => {
    const s = summarizeSpaceSyncError('fatal: some transport explosion we have never seen');
    expect(s.interrupted).toBe(false);
    // General but non-committal — no guessed cause, and it surfaces where to report.
    expect(s.summary.toLowerCase()).toContain('development');
    expect(s.summary).not.toContain('transport explosion');
  });

  it('empty / missing input is treated as a generic unknown error', () => {
    expect(summarizeSpaceSyncError('').interrupted).toBe(false);
    expect(summarizeSpaceSyncError(null).interrupted).toBe(false);
    expect(summarizeSpaceSyncError(undefined).summary.length).toBeGreaterThan(0);
  });
});

// Phase 2 (2026-07-22): coded errors are already plain-language by contract —
// the summarizer must pass them through, not flatten "reconnect your GitHub
// account" into the generic "unexpected problem" line. Gated on the code,
// never on matching prose.
describe('summarizeSpaceSyncError github-auth pass-through', () => {
  it("passes a 'github-auth'-coded message through verbatim", () => {
    const msg = 'GitHub sign-in expired — reconnect your GitHub account in the Sync settings';
    expect(summarizeSpaceSyncError(msg, 'github-auth')).toEqual({ interrupted: false, summary: msg });
  });

  it('other codes / no code keep the existing classification', () => {
    expect(summarizeSpaceSyncError('something exploded', 'some-other-code').summary)
      .toContain('unexpected problem');
    expect(summarizeSpaceSyncError("Unable to create '/x/index.lock': File exists").interrupted).toBe(true);
  });
});
