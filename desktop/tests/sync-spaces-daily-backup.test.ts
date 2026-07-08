import { describe, it, expect } from 'vitest';
import { isBackupDue, datedFolderName, foldersToPrune } from '../src/main/sync-spaces/daily-backup';

describe('isBackupDue', () => {
  it('due when no marker', () => expect(isBackupDue(null, new Date('2026-07-03T10:00:00Z'))).toBe(true));
  it('not due same UTC day', () => expect(isBackupDue('2026-07-03', new Date('2026-07-03T23:00:00Z'))).toBe(false));
  it('due on a new UTC day', () => expect(isBackupDue('2026-07-02', new Date('2026-07-03T00:10:00Z'))).toBe(true));
});

describe('datedFolderName', () => {
  it('is the UTC date', () => expect(datedFolderName(new Date('2026-07-03T14:00:00Z'))).toBe('2026-07-03'));
});

describe('foldersToPrune', () => {
  it('keeps 30 days, prunes older, ignores non-date names', () => {
    const now = new Date('2026-07-03T00:00:00Z');
    expect(foldersToPrune(['2026-07-01', '2026-05-01', 'junk', '2026-06-04'], now, 30))
      .toEqual(['2026-05-01']);
  });
});
