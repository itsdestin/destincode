import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { isBackupDue, datedFolderName, foldersToPrune, DailyBackup } from '../src/main/sync-spaces/daily-backup';
import type { SyncSpace } from '../src/main/sync-spaces/types';

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

// End-to-end async iCloud path: real tmp dirs, no mocks. Pins that the copy
// scrubs DEFAULT_IGNORES, the marker gates same-day re-runs, and runIfDue
// never throws — the contract the hourly timer (Task 8) relies on.
describe('DailyBackup.runIfDue (icloud end-to-end)', () => {
  let tmp: string;
  afterEach(() => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); });

  it('copies scrubbed, writes marker, no-ops same UTC day', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'spaces-backup-'));
    const root = path.join(tmp, 'space');
    const base = path.join(tmp, 'icloud');
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'notes.md'), 'hello');
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'i.js'), 'x');
    const markerPath = path.join(tmp, 'marker');
    const logs: string[] = [];
    const space: SyncSpace = { id: 'project:demo', kind: 'project', root };
    const job = new DailyBackup({ markerPath });

    await job.runIfDue([space], [{ type: 'icloud', base }], m => logs.push(m));

    // Read the dated folder back from the marker so a run that straddles UTC
    // midnight can't flake the test.
    const marker = fs.readFileSync(markerPath, 'utf8');
    expect(marker).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const dest = path.join(base, 'Backup', 'spaces', marker, 'project-demo');
    expect(fs.readFileSync(path.join(dest, 'notes.md'), 'utf8')).toBe('hello');
    expect(fs.existsSync(path.join(dest, '.env'))).toBe(false);
    expect(fs.existsSync(path.join(dest, 'node_modules'))).toBe(false);
    expect(logs.some(m => m.includes('spaces-backup completed'))).toBe(true);

    // Same UTC day → second call must no-op (marker gate), so a file added
    // after the backup does not appear in the dated folder.
    fs.writeFileSync(path.join(root, 'later.md'), 'x');
    await job.runIfDue([space], [{ type: 'icloud', base }], m => logs.push(m));
    expect(fs.existsSync(path.join(dest, 'later.md'))).toBe(false);
  });
});
