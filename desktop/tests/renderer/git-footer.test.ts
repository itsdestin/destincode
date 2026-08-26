import { describe, it, expect } from 'vitest';
import { gitFooterState } from '../../src/renderer/utils/git-footer';

const base = { ok: true, isRepo: true, branch: 'main', counts: null, hasHistory: false, staged: false, conflicted: false };

describe('gitFooterState', () => {
  it('hidden when status is unknown or not a repo', () => {
    expect(gitFooterState(null).show).toBe(false);
    expect(gitFooterState({ ...base, isRepo: false }).show).toBe(false);
  });
  it('hidden for a clean file with no history (footer reads exactly as today)', () => {
    expect(gitFooterState(base)).toEqual({ show: false, counts: null, conflicted: false });
  });
  it('shown with counts when the file has uncommitted changes', () => {
    const r = gitFooterState({ ...base, counts: { added: 41, removed: 12 } });
    expect(r).toEqual({ show: true, counts: { added: 41, removed: 12 }, conflicted: false });
  });
  it('shown without counts when clean but with history', () => {
    expect(gitFooterState({ ...base, hasHistory: true })).toEqual({ show: true, counts: null, conflicted: false });
  });
  it('zero-zero counts (binary/oversize) still count as changed', () => {
    expect(gitFooterState({ ...base, counts: { added: 0, removed: 0 } }).show).toBe(true);
  });
  // 2026-07-22 bug: unmerged entries vanished from the footer entirely — a
  // conflicted file must always show, and the flag must pass through so the
  // footer can render its Conflict label.
  it('a conflicted file always shows and carries the conflicted flag', () => {
    const r = gitFooterState({ ...base, conflicted: true });
    expect(r).toEqual({ show: true, counts: null, conflicted: true });
    expect(gitFooterState({ ...base, conflicted: true, counts: { added: 4, removed: 0 } }))
      .toEqual({ show: true, counts: { added: 4, removed: 0 }, conflicted: true });
  });
});
