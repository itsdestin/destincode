// desktop/tests/device-activity-label.test.ts
// Pins the exact wording bands of the pure device-row recency helper
// (2026-07-17 sync-menu-recency spec/plan Task 4). Wording is a UI contract —
// these strings render verbatim in the "Your devices" list.
import { describe, it, expect } from 'vitest';
import { deviceActivityLabel, relativeMs } from '../src/renderer/components/device-activity-label';

const NOW = 1_700_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;

// Convenience: build the helper input with sane defaults, override per case.
const input = (over: Partial<Parameters<typeof deviceActivityLabel>[0]> = {}) => ({
  isSelf: false,
  syncInProgress: false,
  lastSyncAt: null as number | null,
  gitLastSeen: NOW - 3 * HOUR,
  ...over,
});

describe('deviceActivityLabel — self row', () => {
  it('shows the live "Syncing…" while a sync is in flight', () => {
    expect(deviceActivityLabel(input({ isSelf: true, syncInProgress: true, lastSyncAt: NOW - 2 * MIN }), NOW)).toBe('Syncing…');
  });
  it('self + not syncing + synced 2m ago → "Synced just now"', () => {
    expect(deviceActivityLabel(input({ isSelf: true, syncInProgress: false, lastSyncAt: NOW - 2 * MIN }), NOW)).toBe('Synced just now');
  });
});

describe('deviceActivityLabel — peer recency bands', () => {
  it('synced 30s ago → "Synced just now"', () => {
    expect(deviceActivityLabel(input({ lastSyncAt: NOW - 30_000 }), NOW)).toBe('Synced just now');
  });

  // BOUNDARY: the rule is < 5 min ⇒ "Synced just now"; ≥ 5 min ⇒ "Last synced {relative} ago".
  it('exactly 5m ago → relative ("Last synced 5 minutes ago")', () => {
    expect(deviceActivityLabel(input({ lastSyncAt: NOW - 5 * MIN }), NOW)).toBe('Last synced 5 minutes ago');
  });
  it('4m59s ago → still "Synced just now"', () => {
    expect(deviceActivityLabel(input({ lastSyncAt: NOW - (5 * MIN - 1000) }), NOW)).toBe('Synced just now');
  });

  it('synced 12m ago → "Last synced 12 minutes ago"', () => {
    expect(deviceActivityLabel(input({ lastSyncAt: NOW - 12 * MIN }), NOW)).toBe('Last synced 12 minutes ago');
  });
});

describe('deviceActivityLabel — no sync record (fallback to launch time)', () => {
  it('no lastSyncAt → falls back to today\'s launch-time wording via relativeMs', () => {
    expect(deviceActivityLabel(input({ lastSyncAt: null, gitLastSeen: NOW - 3 * HOUR }), NOW)).toBe('last seen 3 hours ago');
  });
});

describe('deviceActivityLabel — clock skew', () => {
  it('a lastSyncAt in the FUTURE clamps to "Synced just now" (never negative/future)', () => {
    expect(deviceActivityLabel(input({ lastSyncAt: NOW + 10 * MIN }), NOW)).toBe('Synced just now');
  });
});

describe('relativeMs (co-located phrasing helper)', () => {
  it('is injectable with now and reads in full words', () => {
    expect(relativeMs(NOW - 5 * MIN, NOW)).toBe('5 minutes ago');
    expect(relativeMs(NOW - 3 * HOUR, NOW)).toBe('3 hours ago');
    expect(relativeMs(NOW - 30_000, NOW)).toBe('just now');
  });
});
