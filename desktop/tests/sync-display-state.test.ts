import { describe, it, expect } from 'vitest';
import { deriveSettingsRowState, type DeriveSyncStateInput, type SpacesRowInput } from '../src/renderer/state/sync-display-state';

// Settings-row derivation across BOTH sync systems (2026-07-22 fix): the row
// used to key on the legacy rclone status alone, so a device running only the
// primary GitHub sync — enabled and green in the popup — read "Not configured".

const NO_LEGACY: DeriveSyncStateInput = {
  hasBackends: false,
  syncInProgress: false,
  lastSyncEpoch: null,
  warnings: [],
};

const warn = (level: 'warn' | 'danger') => ({ id: 'w', backendId: 'b', level, code: 'X', message: 'm' } as any);

const spaces = (box: SpacesRowInput['box'], lastSyncAt: number | null = Date.now() - 60_000): SpacesRowInput =>
  ({ enabled: true, box, lastSyncAt });

describe('deriveSettingsRowState', () => {
  it('THE SCREENSHOT PIN: sync-spaces enabled + green, zero legacy backends → synced, never "unconfigured"', () => {
    const out = deriveSettingsRowState(NO_LEGACY, spaces('synced'));
    expect(out.kind).toBe('synced');
  });

  it('sync-spaces disabled (or absent) → unchanged legacy derivation', () => {
    expect(deriveSettingsRowState(NO_LEGACY, null)).toEqual({ kind: 'unconfigured' });
    expect(deriveSettingsRowState(NO_LEGACY, { enabled: false, box: 'off', lastSyncAt: null })).toEqual({ kind: 'unconfigured' });
  });

  it('sync-spaces error → failing (red row), even with no legacy warnings', () => {
    const out = deriveSettingsRowState(NO_LEGACY, spaces('error'));
    expect(out).toEqual({ kind: 'failing', warningCount: 1 });
  });

  it('setup / hydrating / syncing boxes all read as the syncing row state', () => {
    for (const box of ['setup', 'hydrating', 'syncing'] as const) {
      expect(deriveSettingsRowState(NO_LEGACY, spaces(box)).kind).toBe('syncing');
    }
  });

  it('legacy DANGER warnings outrank a green sync-spaces state (never green over active warnings)', () => {
    const legacy = { ...NO_LEGACY, hasBackends: true, warnings: [warn('danger')] };
    expect(deriveSettingsRowState(legacy, spaces('synced'))).toEqual({ kind: 'failing', warningCount: 1 });
  });

  it('legacy warn-level warnings surface as attention over a green sync-spaces state', () => {
    const legacy = { ...NO_LEGACY, hasBackends: true, warnings: [warn('warn')] };
    const out = deriveSettingsRowState(legacy, spaces('synced'));
    expect(out.kind).toBe('attention');
  });

  it('recency comes from sync-spaces (ms → s) and goes stale past 24h', () => {
    const recent = deriveSettingsRowState(NO_LEGACY, spaces('synced', Date.now() - 5 * 60_000));
    expect(recent.kind).toBe('synced');
    const old = deriveSettingsRowState(NO_LEGACY, spaces('synced', Date.now() - 48 * 3600_000));
    expect(old.kind).toBe('stale');
  });
});
