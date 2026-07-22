import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  readWarnings,
  writeWarnings,
  addOrReplaceWarning,
  clearWarningsByBackend,
  clearWarningsByCode,
  dismissWarning,
  setClaudeDirForTests,
} from '../src/main/sync-state';
import type { SyncWarning } from '../src/main/sync-state';

// A throwaway home for this suite. The old header claimed HOME was redirected
// "before the module is imported" — it never was: nothing assigned HOME, and a
// static import is hoisted above any assignment anyway. So every assertion here
// ran against the developer's REAL ~/.claude/.sync-warnings.json, which
// writeWarnings([]) deletes.
//
// That is what made 'clearWarningsByCode removes only matching code' flaky
// (ROADMAP :130): SyncService.runHealthCheck() writes an OFFLINE warning to
// that exact file when a YouCoded instance launches, and this suite asserts no
// OFFLINE warning survives. It was never module-load ORDER — no other suite
// writes warnings — it was a second process sharing one real file.
const tmpHome = path.join(os.tmpdir(), `sync-warnings-test-${Date.now()}`);
const claudeDir = path.join(tmpHome, '.claude');
const warningsPath = path.join(claudeDir, '.sync-warnings.json');

setClaudeDirForTests(tmpHome);

beforeEach(() => {
  fs.mkdirSync(claudeDir, { recursive: true });
  try { fs.unlinkSync(warningsPath); } catch {}
});

afterEach(() => {
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

function mkWarning(overrides: Partial<SyncWarning> = {}): SyncWarning {
  return {
    code: 'UNKNOWN',
    level: 'danger',
    title: 'Backup failed',
    body: 'Backups are failing.',
    dismissible: false,
    createdEpoch: 1000,
    ...overrides,
  };
}

describe('sync warning store', () => {
  // These run against the throwaway home wired up at the top of the file, so
  // no other process can write the file underneath them.

  it('readWarnings returns [] when file missing', async () => {
    // Now assertable exactly: with a private home there is no leftover state
    // from a previous run or from a live app.
    expect(await readWarnings()).toEqual([]);
  });

  it('writeWarnings → readWarnings round-trip', async () => {
    const w = [mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1' })];
    await writeWarnings(w);
    const out = await readWarnings();
    expect(out).toEqual(w);
    await writeWarnings([]);
  });

  it('writeWarnings([]) removes the file', async () => {
    await writeWarnings([mkWarning()]);
    await writeWarnings([]);
    const out = await readWarnings();
    expect(out).toEqual([]);
  });

  it('addOrReplaceWarning de-dupes by (code, backendId)', async () => {
    await writeWarnings([]);
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1', createdEpoch: 1 }));
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1', createdEpoch: 2 }));
    const out = await readWarnings();
    expect(out).toHaveLength(1);
    expect(out[0].createdEpoch).toBe(2);
    await writeWarnings([]);
  });

  it('addOrReplaceWarning keeps different backendIds separate', async () => {
    await writeWarnings([]);
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1' }));
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-2' }));
    const out = await readWarnings();
    expect(out).toHaveLength(2);
    await writeWarnings([]);
  });

  it('clearWarningsByBackend removes only matching backendId', async () => {
    await writeWarnings([]);
    await addOrReplaceWarning(mkWarning({ code: 'CONFIG_MISSING', backendId: 'drive-1' }));
    await addOrReplaceWarning(mkWarning({ code: 'AUTH_EXPIRED', backendId: 'drive-2' }));
    await clearWarningsByBackend('drive-1');
    const out = await readWarnings();
    expect(out).toHaveLength(1);
    expect(out[0].backendId).toBe('drive-2');
    await writeWarnings([]);
  });

  it('clearWarningsByCode removes only matching code', async () => {
    await writeWarnings([]);
    await addOrReplaceWarning(mkWarning({ code: 'OFFLINE' }));
    await addOrReplaceWarning(mkWarning({ code: 'PERSONAL_STALE' }));
    await clearWarningsByCode('OFFLINE');
    const out = await readWarnings();
    expect(out.every((w) => w.code !== 'OFFLINE')).toBe(true);
    await writeWarnings([]);
  });
});

describe('dismissWarning', () => {
  it('removes a dismissible warning', async () => {
    await writeWarnings([mkWarning({ code: 'PERSONAL_STALE', dismissible: true })]);
    await dismissWarning('PERSONAL_STALE');
    const out = await readWarnings();
    expect(out.find((w) => w.code === 'PERSONAL_STALE')).toBeUndefined();
  });

  it('refuses to remove a non-dismissible warning', async () => {
    await writeWarnings([mkWarning({ code: 'CONFIG_MISSING', dismissible: false })]);
    await dismissWarning('CONFIG_MISSING');
    const out = await readWarnings();
    expect(out.find((w) => w.code === 'CONFIG_MISSING')).toBeDefined();
    await writeWarnings([]);
  });
});

describe('cleanupStaleBackendErrorFiles', () => {
  it('removes leftover .sync-error-* files', async () => {
    // Uses the same throwaway home as the rest of the file. This previously
    // wrote .sync-error-* files into the developer's REAL ~/.claude/
    // toolkit-state/ — harmless in effect, but it is a live app's directory.
    const toolkitStateDir = path.join(tmpHome, '.claude', 'toolkit-state');
    fs.mkdirSync(toolkitStateDir, { recursive: true });

    const staleA = path.join(toolkitStateDir, '.sync-error-drive-test-stale-a');
    const staleB = path.join(toolkitStateDir, '.sync-error-github-test-stale-b');
    fs.writeFileSync(staleA, 'old error');
    fs.writeFileSync(staleB, 'another old error');
    expect(fs.existsSync(staleA)).toBe(true);
    expect(fs.existsSync(staleB)).toBe(true);

    // Call the migration helper directly rather than invoking start(), which
    // would also kick off a network pull and timeout the test.
    const { SyncService } = await import('../src/main/sync-service');
    const svc = new SyncService(tmpHome);
    try {
      svc.cleanupStaleBackendErrorFiles();
      expect(fs.existsSync(staleA)).toBe(false);
      expect(fs.existsSync(staleB)).toBe(false);
    } finally {
      try { fs.unlinkSync(staleA); } catch {}
      try { fs.unlinkSync(staleB); } catch {}
    }
  });
});
