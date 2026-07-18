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
