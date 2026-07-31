import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SyncService } from '../src/main/sync-service';
import { SpaceManager } from '../src/main/sync-spaces/space-manager';
import { readWarnings, writeWarnings, setClaudeDirForTests } from '../src/main/sync-state';

/**
 * The startup health check must describe the sync system the user actually has.
 *
 * Regression (fixed 2026-07-24): runHealthCheck() only ever looked at the LEGACY
 * additional-backup backends (`storage_backends` in toolkit-state/config.json —
 * Drive/iCloud). GitHub sync spaces, the app's PRIMARY sync since Phase 1, keeps
 * its own state file, so a machine syncing happily to GitHub with no Drive/iCloud
 * backend was told "No sync configured — your backups aren't set up" at
 * danger level, non-dismissible, which the StatusBar paints as a red
 * "Sync Failing" chip. Reported on a fresh macOS install of 1.3.0-beta.9. Older
 * installs masked it through autoDetectBackend(), whose `rclone lsd gdrive:…`
 * probe succeeds on a machine that used the legacy backups years ago (and skips
 * the warning without enabling anything). New installs have no rclone, so they
 * take the warning — which is the whole release population.
 *
 * These tests drive a REAL SpaceManager at its default path, which is the point:
 * SyncService reads that file by path rather than importing the sync-spaces
 * service (which would drag the engine, chokidar and electron into a health
 * check). If either side ever moves the file, case 1 fails.
 */

const tmpHome = path.join(os.tmpdir(), `sync-health-primary-${process.pid}-${Date.now()}`);
const claudeDir = path.join(tmpHome, '.claude');
const toolkitState = path.join(claudeDir, 'toolkit-state');

setClaudeDirForTests(tmpHome);

function makeService() {
  const svc = new SyncService(tmpHome);
  // The primary-sync gate is what's under test, not backend auto-detection —
  // stub it so a developer machine with a real rclone/gdrive remote (or a real
  // ~/Library iCloud folder) can't decide the outcome.
  vi.spyOn(svc as any, 'autoDetectBackend').mockResolvedValue(null);
  return svc;
}

/** Codes this suite asserts on; OFFLINE depends on the runner's network. */
async function codes(): Promise<string[]> {
  return (await readWarnings()).map((w) => w.code);
}

beforeEach(async () => {
  fs.mkdirSync(toolkitState, { recursive: true });
  await writeWarnings([]);
});

afterEach(() => {
  vi.restoreAllMocks();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

describe('runHealthCheck — primary (GitHub sync spaces) vs additional backups', () => {
  it('stays quiet when GitHub sync is on and no legacy backend exists', async () => {
    // Written through the real SpaceManager, at its real default path.
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    new SpaceManager().setEnabled(true);
    homedir.mockRestore();
    expect(fs.existsSync(path.join(toolkitState, 'sync-spaces.json'))).toBe(true);

    await makeService().runHealthCheck();

    expect(await codes()).not.toContain('PERSONAL_NOT_CONFIGURED');
  });

  it('still warns when GitHub sync is off and nothing else is configured', async () => {
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    new SpaceManager().setEnabled(false);
    homedir.mockRestore();

    await makeService().runHealthCheck();

    expect(await codes()).toContain('PERSONAL_NOT_CONFIGURED');
  });

  it('warns on a fresh install with no sync state file at all', async () => {
    expect(fs.existsSync(path.join(toolkitState, 'sync-spaces.json'))).toBe(false);

    await makeService().runHealthCheck();

    const warning = (await readWarnings()).find((w) => w.code === 'PERSONAL_NOT_CONFIGURED');
    expect(warning).toBeDefined();
    // Copy check: the old body told users to "connect a cloud provider", which
    // is the additional-backups flow, not the GitHub sync the app leads with.
    expect(warning!.body).toMatch(/Nothing is backing up your data yet/);
  });

  it('a stale legacy backend is reported as EXTRA backups, not as sync failing', async () => {
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(tmpHome);
    new SpaceManager().setEnabled(true);
    homedir.mockRestore();
    fs.writeFileSync(path.join(toolkitState, 'config.json'), JSON.stringify({
      storage_backends: [
        { id: 'drive-1', type: 'drive', label: 'Personal Drive', syncEnabled: true, config: {} },
      ],
    }));
    // Two days ago — past the 24h staleness threshold.
    const twoDaysAgo = Math.floor(Date.now() / 1000) - 2 * 86400;
    fs.writeFileSync(path.join(toolkitState, '.sync-marker'), String(twoDaysAgo));

    await makeService().runHealthCheck();

    const stale = (await readWarnings()).find((w) => w.code === 'PERSONAL_STALE');
    expect(stale).toBeDefined();
    expect(stale!.level).toBe('warn');
    expect(stale!.title).toBe('Extra backups are stale');
    // GitHub sync doesn't stamp this marker, so the copy must not blame it.
    expect(stale!.body).toMatch(/Drive or iCloud/);
  });
});
