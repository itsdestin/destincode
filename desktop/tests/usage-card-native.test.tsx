// @vitest-environment jsdom
// usage-card-native.test.tsx — the /usage card in a native (YouCoded-runtime)
// session.
//
// WHY this file exists: the status bar now HIDES the 5-hour and 7-day
// subscription chips in a native session, and the Customize menu explains that
// with "Claude Code sessions only". /usage is the escape hatch those chips
// point at, so this card has to keep showing the Claude subscription numbers in
// EVERY kind of session, correctly, and has to say out loud that those numbers
// are account-wide rather than about this one conversation (spec §10). If this
// card is empty or misleading here, hiding the chips is indefensible — the two
// ship together.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import UsageCard from '../src/renderer/components/UsageCard';
import type { UsageSnapshot } from '../src/renderer/state/chat-types';

afterEach(() => cleanup());

// Subscription utilization arrives as a PERCENT (0-100), not a 0-1 ratio.
// Verified against the real cache file the main process reads
// (~/.claude/.usage-cache.json → "utilization": 42) and against StatusBar.tsx,
// which prints `{usage.five_hour.utilization}%` with no conversion at all.
const nativeSnapshot: UsageSnapshot = {
  entryId: 'u1',
  timestamp: 1,
  costUsd: 1.5,
  costIsPartial: false,
  countsFromSessionTotals: true,
  specialistRuns: 0,
  inputTokens: 1000,
  outputTokens: 200,
  cacheReadTokens: 50,
  cacheCreationTokens: 10,
  contextTokens: null,
  contextPercent: 40,
  // A native session has no Claude Code statusline, so it never learns wall
  // time or API time. These stay null forever there.
  duration: null,
  apiDuration: null,
  linesAdded: 12,
  linesRemoved: 3,
  fiveHourUtilization: 42,
  fiveHourResetsAt: new Date(Date.now() + 3.6e6).toISOString(),
  sevenDayUtilization: 15,
  sevenDayResetsAt: new Date(Date.now() + 8.6e7).toISOString(),
};

describe('UsageCard in a native session', () => {
  it('still shows the Claude subscription numbers', () => {
    render(<UsageCard snapshot={nativeSnapshot} />);
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.getByText('15%')).toBeInTheDocument();
  });

  it('draws the subscription bars at the real level, not pinned to full', () => {
    // The figure and the bar must agree. A bar clamped at 100 next to the text
    // "42%" is the card contradicting itself.
    render(<UsageCard snapshot={nativeSnapshot} />);
    expect(screen.getByRole('progressbar', { name: '5-hour limit' })).toHaveAttribute('aria-valuenow', '42');
    expect(screen.getByRole('progressbar', { name: '7-day limit' })).toHaveAttribute('aria-valuenow', '15');
  });

  it('labels those bars as account-wide, not session-scoped', () => {
    render(<UsageCard snapshot={nativeSnapshot} />);
    expect(screen.getByText(/across your whole Claude account/i)).toBeInTheDocument();
  });

  it('says what the session numbers count, in the bar’s own words', () => {
    render(<UsageCard snapshot={nativeSnapshot} />);
    expect(screen.getByText(/Counts this session so far, including specialists\./i)).toBeInTheDocument();
  });

  it('shows the session numbers it has', () => {
    render(<UsageCard snapshot={nativeSnapshot} />);
    expect(screen.getByText('1,000')).toBeInTheDocument();
    expect(screen.getByText('+12')).toBeInTheDocument();
  });

  it('omits a row it cannot fill rather than rendering it empty', () => {
    render(<UsageCard snapshot={nativeSnapshot} />);
    expect(screen.queryByText('--')).toBeNull();
    expect(screen.queryByText(/elapsed/i)).toBeNull();
  });

  it('flags a partial total in the same words the status bar uses', () => {
    render(<UsageCard snapshot={{ ...nativeSnapshot, costUsd: 1.5, costIsPartial: true }} />);
    expect(screen.getByText('$1.50')).toBeInTheDocument();
    // Byte-for-byte, not a substring: this sentence exists in StatusBar.tsx
    // too, and the whole point is that the two surfaces say the SAME thing.
    expect(
      screen.getByText('Models with no published price are not included in this total.'),
    ).toBeInTheDocument();
  });

  it('says a cost could not be totalled rather than showing a false zero', () => {
    render(<UsageCard snapshot={{ ...nativeSnapshot, costUsd: null, costIsPartial: true }} />);
    expect(screen.queryByText('$0.00')).toBeNull();
    expect(screen.getByText('not listed')).toBeInTheDocument();
    // Byte-for-byte match with the cost chip's tooltip in StatusBar.tsx. A
    // looser match would let the card drift back to "no price is published",
    // which asserts a cause nobody checked (Task 22).
    expect(
      screen.getByText(
        "This provider bills for usage, but no price is available for this model here, so the session cost can't be totalled.",
      ),
    ).toBeInTheDocument();
  });

  it('drops the cost block entirely when nothing was priced and nothing is billed', () => {
    render(<UsageCard snapshot={{ ...nativeSnapshot, costUsd: null, costIsPartial: false }} />);
    expect(screen.queryByText(/session cost/i)).toBeNull();
    expect(screen.queryByText('not listed')).toBeNull();
  });
});

describe('UsageCard in a Claude Code session', () => {
  // These numbers come from Claude Code's own statusline, not from this app's
  // per-turn accounting, so this app's "including specialists" promise is a
  // claim it cannot back here.
  const ccSnapshot: UsageSnapshot = {
    ...nativeSnapshot,
    countsFromSessionTotals: false,
    specialistRuns: 0,
    duration: 300,
    apiDuration: 90,
  };

  it('does not claim this app counted the session', () => {
    render(<UsageCard snapshot={ccSnapshot} />);
    expect(screen.queryByText(/Counts this session so far/i)).toBeNull();
  });

  it('still shows the account-wide caption', () => {
    render(<UsageCard snapshot={ccSnapshot} />);
    expect(screen.getByText(/across your whole Claude account/i)).toBeInTheDocument();
  });
});
