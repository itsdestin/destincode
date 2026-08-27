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
  const native = { runtime: 'native' as const, hasPricedWork: true, runsLocally: false };
  // A native session on a model that costs nothing to run and has priced nothing.
  const local = { runtime: 'native' as const, hasPricedWork: false, runsLocally: true };
  // A native session on a METERED model whose rate is not published — the
  // opposite situation to `local`, and it must not borrow local's sentence.
  const unpriced = { runtime: 'native' as const, hasPricedWork: false, runsLocally: false };

  it('explains the subscription chips', () => {
    expect(widgetUnavailableReason('usage-5h', native)).toBe('Claude Code sessions only');
    expect(widgetUnavailableReason('usage-7d', native)).toBe('Claude Code sessions only');
  });

  it('explains the unavailable chips without promising them later', () => {
    expect(widgetUnavailableReason('session-time', native)).toBe('Not available in this kind of session');
    expect(widgetUnavailableReason('active-ratio', native)).toBe('Not available in this kind of session');
  });

  it('explains a metered cost chip with nothing priced', () => {
    expect(widgetUnavailableReason('session-cost', unpriced)).toBe('No published price for this model');
  });

  it('says a local model costs nothing, rather than calling it unpriced', () => {
    expect(widgetUnavailableReason('session-cost', local))
      .toBe("Models on your own machine don't cost anything to run");
  });

  it('says nothing about cost when priced work exists — local or metered', () => {
    expect(widgetUnavailableReason('session-cost', native)).toBeNull();
    expect(widgetUnavailableReason('session-cost', { runtime: 'native', hasPricedWork: true, runsLocally: true })).toBeNull();
  });

  it('never explains git-branch away — it is a missing feed, not a relevance rule', () => {
    expect(widgetUnavailableReason('git-branch', native)).toBeNull();
    expect(widgetUnavailableReason('git-branch', local)).toBeNull();
    expect(widgetUnavailableReason('git-branch', unpriced)).toBeNull();
  });

  it('says nothing in a Claude Code session', () => {
    const cc = { runtime: 'claude' as const, hasPricedWork: true, runsLocally: false };
    expect(widgetUnavailableReason('usage-5h', cc)).toBeNull();
    expect(widgetUnavailableReason('session-time', cc)).toBeNull();
  });
});
