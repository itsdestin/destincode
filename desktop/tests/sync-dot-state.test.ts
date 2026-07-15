// desktop/tests/sync-dot-state.test.ts
import { describe, it, expect } from 'vitest';
import { syncDotFor, findSpaceFor, lastSyncedLabel, type SyncStatusData } from '../src/renderer/components/sync-dot-state';

const status = (over: Partial<SyncStatusData> = {}): SyncStatusData => ({
  enabled: true,
  spaces: [
    { id: 'personal', root: 'C:\\Users\\x\\YouCoded\\Personal' },
    { id: 'project:budget-app', root: 'C:\\Users\\x\\YouCoded\\Projects\\budget-app' },
  ],
  recentEvents: [],
  ...over,
});

describe('findSpaceFor', () => {
  it('matches a folder to its space by normalized root (slashes + case)', () => {
    expect(findSpaceFor('c:/users/x/youcoded/projects/budget-app/', status())?.id).toBe('project:budget-app');
  });
  it('returns null for a folder with no space', () => {
    expect(findSpaceFor('C:\\Users\\x\\elsewhere', status())).toBeNull();
  });
});

describe('syncDotFor', () => {
  it('returns null when status is unavailable (no dot rendered)', () => {
    expect(syncDotFor('C:\\anything', null)).toBeNull();
  });
  it('gray "Only on this computer" for unmanaged folders', () => {
    expect(syncDotFor('C:\\Users\\x\\elsewhere', status())).toEqual({ color: 'gray', label: 'Only on this computer' });
  });
  it('gray with the sync-off wording for managed folders while Sync is off', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({ enabled: false }));
    expect(d?.color).toBe('gray');
    expect(d?.label).toMatch(/turn on Sync in Settings/);
  });
  it('red when the space\'s LATEST event is an error', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [
        { type: 'synced', spaceId: 'project:budget-app' },
        { type: 'error', spaceId: 'project:budget-app' },
      ],
    }));
    expect(d).toEqual({ color: 'red', label: "Sync isn't working — open Manage projects" });
  });
  it('green when a later synced event supersedes an earlier error', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [
        { type: 'error', spaceId: 'project:budget-app' },
        { type: 'synced', spaceId: 'project:budget-app' },
      ],
    }));
    expect(d).toEqual({ color: 'green', label: 'Syncs across your devices' });
  });
  it('gray "Sync stopped" for a stopped project, even while Sync is on', () => {
    const s = status();
    s.spaces = s.spaces.map((sp) =>
      sp.id === 'project:budget-app' ? { ...sp, state: 'stopped' as const } : sp);
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', s);
    expect(d).toEqual({ color: 'gray', label: 'Sync stopped' });
  });
  it('ignores other spaces\' events', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [{ type: 'error', spaceId: 'project:other' }],
    }));
    expect(d?.color).toBe('green');
  });
  it('stays green when a large-history "notice" fires right after a synced event (no false red dot)', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [
        { type: 'synced', spaceId: 'project:budget-app' },
        { type: 'notice', spaceId: 'project:budget-app', message: 'Sync history for project:budget-app is large (512 MB). Sync still works normally.' },
      ],
    }));
    expect(d).toEqual({ color: 'green', label: 'Syncs across your devices' });
  });
  it('a notice does not mask an underlying error (error still wins the dot)', () => {
    const d = syncDotFor('C:\\Users\\x\\YouCoded\\Projects\\budget-app', status({
      recentEvents: [
        { type: 'error', spaceId: 'project:budget-app' },
        { type: 'notice', spaceId: 'project:budget-app', message: 'large' },
      ],
    }));
    expect(d?.color).toBe('red');
  });
});

describe('lastSyncedLabel', () => {
  const NOW = 1_800_000_000_000;
  it('formats the latest synced event\'s timestamp relatively', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 2 * 60_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('2 minutes ago');
  });
  it('returns null when no synced event carries a timestamp', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app' }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBeNull();
  });
  it('says "just now" under a minute', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 5_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('just now');
  });
  it('uses the singular "1 minute ago" at exactly one minute', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 60_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('1 minute ago');
  });
  it('uses the singular "1 hour ago" at exactly one hour', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 60 * 60_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('1 hour ago');
  });
  it('pluralizes hours ("3 hours ago")', () => {
    const s = status({ recentEvents: [{ type: 'synced', spaceId: 'project:budget-app', at: NOW - 3 * 60 * 60_000 }] });
    expect(lastSyncedLabel('project:budget-app', s, NOW)).toBe('3 hours ago');
  });
});
