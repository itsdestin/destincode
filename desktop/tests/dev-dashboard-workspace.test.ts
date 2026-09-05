import { describe, it, expect } from 'vitest';
import { verdict } from '../dev-dashboard/workspace.mjs';

const ws = (over: Record<string, unknown> = {}) => ({
  workspace: {
    name: 'workspace', branch: 'master', ahead: 0, behind: 0, dirty: 0,
    blocking: [] as string[], fetchFailed: false, fetchAgeSeconds: 5, ...over,
  },
  repos: [],
});

describe('the workspace verdict', () => {
  it('says a behind workspace is stale, in terms of what it COSTS', () => {
    // "38 behind" means nothing on its own. The sentence that makes it worth
    // acting on is what it does to the next session.
    const v = verdict(ws({ behind: 38 }));
    expect(v.tone).toBe('stale');
    expect(v.headline).toMatch(/38 updates behind/);
    expect(v.detail).toMatch(/new sessions are loading guidance/i);
  });

  it('names the files blocking the sync, because that is the actionable part', () => {
    const v = verdict(ws({ behind: 38, blocking: ['docs/MAP.md'] }));
    expect(v.detail).toContain('docs/MAP.md');
  });

  it('says nothing is blocking when nothing is', () => {
    const v = verdict(ws({ behind: 2, blocking: [] }));
    expect(v.detail).toMatch(/nothing is blocking/i);
  });

  it('calls an up-to-date workspace ok even when files are uncommitted', () => {
    // Uncommitted files that do not collide with the incoming commits are normal
    // here — every session leaves some. They must not read as a sync problem.
    const v = verdict(ws({ behind: 0, dirty: 69 }));
    expect(v.tone).toBe('ok');
    expect(v.detail).toMatch(/none block an update/i);
  });

  it('never reports a stale count as current when the fetch failed', () => {
    // Offline is normal. Saying "up to date" on a failed check would be a lie
    // with the same shape as the bug this whole banner exists to catch.
    const v = verdict(ws({ fetchFailed: true, behind: 0 }));
    expect(v.tone).toBe('warn');
    expect(v.headline).toMatch(/could not check/i);
  });

  it('does not claim a verdict with no repo to measure', () => {
    const v = verdict({ workspace: null, repos: [] });
    expect(v.tone).not.toBe('ok');
  });
});
