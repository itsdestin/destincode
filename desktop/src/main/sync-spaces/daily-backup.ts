// Spec §11: once per day, copy ALL synced spaces to each configured Drive /
// iCloud backend into a dated folder, then prune by age. Runs ALONGSIDE the
// legacy backup in 1a (legacy is untouched until conversations move in Phase 2).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { DEFAULT_IGNORES } from './guards';
import type { SyncSpace } from './types';

const execFileAsync = promisify(execFile);
const RCLONE_TIMEOUT = 10 * 60 * 1000;

// ---- pure helpers (unit-tested) ----
export function datedFolderName(now: Date): string { return now.toISOString().slice(0, 10); }

export function isBackupDue(markerContent: string | null, now: Date): boolean {
  return markerContent !== datedFolderName(now);
}

export function foldersToPrune(names: string[], now: Date, keepDays: number): string[] {
  const cutoff = now.getTime() - keepDays * 24 * 60 * 60 * 1000;
  return names.filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n) && new Date(`${n}T00:00:00Z`).getTime() < cutoff);
}

// ---- job ----
export interface BackupTarget {
  type: 'drive' | 'icloud';
  /** drive: rclone remote+root e.g. "gdrive:Claude"; icloud: absolute folder path */
  base: string;
}

export class DailyBackup {
  private markerPath: string;

  constructor(opts?: { markerPath?: string }) {
    this.markerPath = opts?.markerPath ?? path.join(os.homedir(), '.claude', '.spaces-backup-marker');
  }

  /** Call from an hourly timer; no-ops until a new UTC day. Never throws. */
  async runIfDue(spaces: SyncSpace[], targets: BackupTarget[], log: (msg: string) => void): Promise<void> {
    let marker: string | null = null;
    try { marker = fs.readFileSync(this.markerPath, 'utf8').trim(); } catch { /* first run */ }
    const now = new Date();
    if (!isBackupDue(marker, now) || targets.length === 0) return;
    const dated = datedFolderName(now);
    for (const target of targets) {
      for (const space of spaces) {
        try { await this.copySpace(space, target, dated); }
        catch (e: any) { log(`spaces-backup failed for ${space.id} → ${target.type}: ${String(e?.message ?? e)}`); }
      }
      try { await this.prune(target, now, log); } catch { /* prune is best-effort */ }
    }
    fs.writeFileSync(this.markerPath, dated);
    log(`spaces-backup completed for ${dated} (${spaces.length} spaces, ${targets.length} targets)`);
  }

  private async copySpace(space: SyncSpace, target: BackupTarget, dated: string): Promise<void> {
    if (target.type === 'drive') {
      const dest = `${target.base}/Backup/spaces/${dated}/${space.id.replace(':', '-')}`;
      const excludes = DEFAULT_IGNORES.flatMap(p => ['--exclude', p.endsWith('/') ? `${p}**` : p]);
      await execFileAsync('rclone', ['copy', space.root, dest, ...excludes], { timeout: RCLONE_TIMEOUT });
    } else {
      const dest = path.join(target.base, 'Backup', 'spaces', dated, space.id.replace(':', '-'));
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(space.root, dest, {
        recursive: true,
        filter: (src) => !/([\\/])(node_modules|\.youcoded|\.git)([\\/]|$)/.test(src) && !path.basename(src).startsWith('.env'),
      });
    }
  }

  private async prune(target: BackupTarget, now: Date, log: (m: string) => void): Promise<void> {
    if (target.type === 'drive') {
      const { stdout } = await execFileAsync('rclone', ['lsf', '--dirs-only', `${target.base}/Backup/spaces/`], { timeout: RCLONE_TIMEOUT });
      const names = stdout.split('\n').map(s => s.replace(/\/$/, '')).filter(Boolean);
      for (const name of foldersToPrune(names, now, 30)) {
        await execFileAsync('rclone', ['purge', `${target.base}/Backup/spaces/${name}`], { timeout: RCLONE_TIMEOUT });
        log(`spaces-backup pruned ${name}`);
      }
    } else {
      const dir = path.join(target.base, 'Backup', 'spaces');
      let names: string[] = [];
      try { names = fs.readdirSync(dir); } catch { return; }
      for (const name of foldersToPrune(names, now, 30)) {
        fs.rmSync(path.join(dir, name), { recursive: true, force: true });
        log(`spaces-backup pruned ${name}`);
      }
    }
  }
}
