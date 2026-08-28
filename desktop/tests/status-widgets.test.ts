import { describe, it, expect } from 'vitest';
import { widgetApplies, widgetUnavailableReason } from '../src/renderer/state/status-widgets';

describe('widgetApplies', () => {
  it('hides the Claude subscription chips in a native session', () => {
    expect(widgetApplies('usage-5h', 'native')).toBe(false);
    expect(widgetApplies('usage-7d', 'native')).toBe(false);
  });

  it('shows them in a Claude Code session', () => {
    expect(widgetApplies('usage-5h', 'claude')).toBe(true);
    expect(widgetApplies('usage-7d', 'claude')).toBe(true);
  });

  it('leaves every other widget to the has-a-value rule', () => {
    for (const id of ['context', 'session-cost', 'code-changes', 'git-branch', 'theme'] as const) {
      expect(widgetApplies(id, 'native')).toBe(true);
    }
  });
});

describe('widgetUnavailableReason', () => {
  const native = { runtime: 'native' as const, hasPricedWork: true, anyUnpriced: false, runsLocally: false };
  // A native session on a model that costs nothing to run and has priced nothing.
  const local = { runtime: 'native' as const, hasPricedWork: false, anyUnpriced: false, runsLocally: true };
  // A native session on a METERED model whose rate is not published. Nothing
  // could be priced, but the bar still draws a `Cost: not listed` chip for this
  // shape, so the menu row has to stay a switch the user can operate.
  const unpriced = { runtime: 'native' as const, hasPricedWork: false, anyUnpriced: true, runsLocally: false };
  // A session that has simply not run anything yet. No sentence about price is
  // true here, so no sentence may be shown.
  const fresh = { runtime: 'native' as const, hasPricedWork: false, anyUnpriced: false, runsLocally: false };
  // The delegation shape spec §5 names: a free local parent whose specialist ran
  // on a metered model with no published rate.
  const freeParentMeteredChild = { runtime: 'native' as const, hasPricedWork: false, anyUnpriced: true, runsLocally: true };

  it('explains the subscription chips', () => {
    expect(widgetUnavailableReason('usage-5h', native)).toBe('Claude Code sessions only');
    expect(widgetUnavailableReason('usage-7d', native)).toBe('Claude Code sessions only');
  });

  it('explains the unavailable chips without promising them later', () => {
    expect(widgetUnavailableReason('session-time', native)).toBe('Not available in this kind of session');
    expect(widgetUnavailableReason('active-ratio', native)).toBe('Not available in this kind of session');
  });

  // Task 20, defect A. The bar draws `Cost: not listed` for this shape, so the
  // row must stay switchable — a chip the user can see but cannot turn off is
  // the exact bar/menu disagreement this module exists to prevent (spec §9).
  it('leaves the cost row switchable when the bar is drawing "not listed"', () => {
    expect(widgetUnavailableReason('session-cost', unpriced)).toBeNull();
  });

  it('says a local model costs nothing, rather than calling it unpriced', () => {
    expect(widgetUnavailableReason('session-cost', local))
      .toBe("Models on your own machine don't cost anything to run");
  });

  // Task 20, defect B. Metered work really ran here (an unpriced specialist
  // under a free local parent), so the "costs nothing to run" sentence would be
  // false — and spec §5 names this delegation shape as the one that must never
  // be hidden.
  it('never claims a session is free to run when metered work also ran', () => {
    expect(widgetUnavailableReason('session-cost', freeParentMeteredChild)).toBeNull();
  });

  // A fresh session on a perfectly ordinary metered model used to be told
  // "No published price for this model", which is false: nothing has been
  // priced because nothing has run. A reason must be true or absent (spec §4).
  it('explains nothing about cost before anything has run', () => {
    expect(widgetUnavailableReason('session-cost', fresh)).toBeNull();
  });

  it('says nothing about cost when priced work exists — local or metered', () => {
    expect(widgetUnavailableReason('session-cost', native)).toBeNull();
    expect(widgetUnavailableReason('session-cost', { runtime: 'native', hasPricedWork: true, anyUnpriced: false, runsLocally: true })).toBeNull();
  });

  it('never explains git-branch away — it is a missing feed, not a relevance rule', () => {
    expect(widgetUnavailableReason('git-branch', native)).toBeNull();
    expect(widgetUnavailableReason('git-branch', local)).toBeNull();
    expect(widgetUnavailableReason('git-branch', unpriced)).toBeNull();
    expect(widgetUnavailableReason('git-branch', fresh)).toBeNull();
  });

  it('says nothing in a Claude Code session', () => {
    const cc = { runtime: 'claude' as const, hasPricedWork: true, anyUnpriced: false, runsLocally: false };
    expect(widgetUnavailableReason('usage-5h', cc)).toBeNull();
    expect(widgetUnavailableReason('session-time', cc)).toBeNull();
  });

  it('says nothing about cost in a Claude Code session, whatever the totals say', () => {
    // The Claude Code runtime shows Claude Code's own figure and never consults
    // the native totals, so no pricing flag may reach the menu.
    const ccLocal = { runtime: 'claude' as const, hasPricedWork: false, anyUnpriced: true, runsLocally: true };
    expect(widgetUnavailableReason('session-cost', ccLocal)).toBeNull();
  });
});
