/**
 * sync-service.ts — Native sync engine for DestinCode.
 *
 * Ports the DestinClaude toolkit's sync orchestration from bash (sync.sh,
 * session-start.sh, session-end-sync.sh, backup-common.sh) into a Node.js
 * service running in the Electron main process.
 *
 * The service owns the full sync lifecycle:
 *   - Pull on app launch (replaces session-start.sh personal data pull)
 *   - Background push every 15 minutes (replaces PostToolUse sync.sh debounce)
 *   - Session-end push (replaces session-end-sync.sh)
 *   - Conversation index management, cross-device slug rewriting, aggregation
 *
 * Actual rclone/git/rsync commands still shell out via child_process.execFile.
 * The bash hooks detect .app-sync-active and skip when the app is running.
 *
 * Design ref: sync-engine-integration plan (Phase 2)
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile, execFileSync } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

// --- Types ---

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface PushResult {
  success: boolean;
  errors: number;
  backends: string[];
}

interface SyncConfig {
  PERSONAL_SYNC_BACKEND: string;
  DRIVE_ROOT: string;
  PERSONAL_SYNC_REPO: string;
  ICLOUD_PATH: string;
  toolkit_root: string;
}

interface ConversationIndexEntry {
  topic: string;
  lastActive: string; // ISO-8601
  slug: string;
  device: string;
}

interface ConversationIndex {
  version: number;
  sessions: Record<string, ConversationIndexEntry>;
}

// --- Constants ---

const PUSH_INTERVAL_MS = 15 * 60 * 1000;   // 15 minutes
const PUSH_DEBOUNCE_MIN = 15;
const PULL_DEBOUNCE_MIN = 10;
const INDEX_PRUNE_DAYS = 30;
const RCLONE_TIMEOUT = 60_000;
const GIT_TIMEOUT = 60_000;
const SESSION_PUSH_TIMEOUT = 15_000;

// --- SyncService ---

export class SyncService extends EventEmitter {
  private claudeDir: string;
  private configPath: string;
  private localConfigPath: string;
  private syncMarkerPath: string;
  private pullMarkerPath: string;
  private lockDir: string;
  private backupLogPath: string;
  private appSyncMarkerPath: string;
  private conversationIndexPath: string;
  private indexStagingDir: string;

  private pushTimer: NodeJS.Timeout | null = null;
  private pulling = false;
  private pushing = false;

  constructor() {
    super();
    this.claudeDir = path.join(os.homedir(), '.claude');
    this.configPath = path.join(this.claudeDir, 'toolkit-state', 'config.json');
    this.localConfigPath = path.join(this.claudeDir, 'toolkit-state', 'config.local.json');
    this.syncMarkerPath = path.join(this.claudeDir, 'toolkit-state', '.sync-marker');
    this.pullMarkerPath = path.join(this.claudeDir, 'toolkit-state', '.session-sync-marker');
    this.lockDir = path.join(this.claudeDir, 'toolkit-state', '.sync-lock');
    this.backupLogPath = path.join(this.claudeDir, 'backup.log');
    this.appSyncMarkerPath = path.join(this.claudeDir, 'toolkit-state', '.app-sync-active');
    this.conversationIndexPath = path.join(this.claudeDir, 'conversation-index.json');
    this.indexStagingDir = path.join(this.claudeDir, 'toolkit-state', '.index-staging');
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  /** Start the sync service: write marker, initial pull, start push timer. */
  async start(): Promise<void> {
    // Write .app-sync-active marker so bash hooks skip sync
    try {
      fs.mkdirSync(path.dirname(this.appSyncMarkerPath), { recursive: true });
      fs.writeFileSync(this.appSyncMarkerPath, String(process.pid));
    } catch {}

    this.logBackup('INFO', 'SyncService started', 'sync.lifecycle');

    // Initial pull — don't crash if it fails
    try {
      await this.pull();
    } catch (e) {
      this.logBackup('ERROR', `Initial pull failed: ${e}`, 'sync.pull');
    }

    // Start background push timer
    this.pushTimer = setInterval(() => {
      this.push().catch(e => {
        this.logBackup('ERROR', `Background push failed: ${e}`, 'sync.push');
      });
    }, PUSH_INTERVAL_MS);
  }

  /** Stop the sync service: clear timer, release locks, remove marker. */
  stop(): void {
    if (this.pushTimer) {
      clearInterval(this.pushTimer);
      this.pushTimer = null;
    }

    // Release lock if held
    this.releaseLock();

    // Remove .app-sync-active marker so hooks resume normal operation
    try { fs.unlinkSync(this.appSyncMarkerPath); } catch {}

    this.logBackup('INFO', 'SyncService stopped', 'sync.lifecycle');
  }

  // =========================================================================
  // Config Reading
  // =========================================================================

  /** Read a config key, checking local config first (machine-specific), then portable. */
  private configGet(key: string, defaultValue = ''): string {
    // Local config takes precedence (machine-specific, never synced)
    for (const cfgPath of [this.localConfigPath, this.configPath]) {
      try {
        const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        if (config[key] !== undefined && config[key] !== null) {
          return String(config[key]);
        }
      } catch {}
    }
    return defaultValue;
  }

  /** Read full sync config. */
  private getSyncConfig(): SyncConfig {
    const config = this.readJson(this.configPath) || {};
    return {
      PERSONAL_SYNC_BACKEND: config.PERSONAL_SYNC_BACKEND || 'none',
      DRIVE_ROOT: config.DRIVE_ROOT || 'Claude',
      PERSONAL_SYNC_REPO: config.PERSONAL_SYNC_REPO || '',
      ICLOUD_PATH: config.ICLOUD_PATH || '',
      toolkit_root: config.toolkit_root || '',
    };
  }

  /** Get active backends as an array. */
  private getBackends(): string[] {
    const raw = this.configGet('PERSONAL_SYNC_BACKEND', 'none');
    return raw.split(',').map(b => b.trim().toLowerCase()).filter(b => b && b !== 'none');
  }

  /** Get preferred backend for pull (first in list). */
  private getPreferredBackend(): string | null {
    const backends = this.getBackends();
    return backends.length > 0 ? backends[0] : null;
  }

  // =========================================================================
  // Slug Generation (CRITICAL — must match Claude Code's algorithm)
  // =========================================================================

  /**
   * Generate the current device's project slug.
   * On Windows, os.homedir() returns native path (C:\Users\desti).
   * On Unix, uses fs.realpathSync to resolve symlinks.
   * Replace /, \, : with - to match Claude Code's slug algorithm.
   */
  getCurrentSlug(): string {
    let homePath: string;
    if (process.platform === 'win32') {
      // os.homedir() already returns native Windows path (C:\Users\desti)
      // No cygpath needed — bash uses cygpath because $HOME is /c/Users/desti
      homePath = os.homedir();
    } else {
      try {
        homePath = fs.realpathSync(os.homedir());
      } catch {
        homePath = os.homedir();
      }
    }
    // Replace path separators and drive letter colon with dashes
    return homePath.replace(/[/\\:]/g, '-');
  }

  // =========================================================================
  // Toolkit Ownership Detection
  // =========================================================================

  /** Check if a file is owned by the toolkit (symlinked into TOOLKIT_ROOT). */
  private isToolkitOwned(filePath: string): boolean {
    const toolkitRoot = this.configGet('toolkit_root', '');
    if (!toolkitRoot) return false;

    let resolved: string;
    try {
      resolved = fs.realpathSync(toolkitRoot);
    } catch {
      return false;
    }

    // Walk up directory tree checking for symlinks
    let current = path.resolve(filePath);
    for (let i = 0; i < 10; i++) {
      try {
        const stat = fs.lstatSync(current);
        if (stat.isSymbolicLink()) {
          const target = fs.realpathSync(current);
          if (target.startsWith(resolved + path.sep) || target === resolved) {
            return true;
          }
        }
      } catch {
        break;
      }
      const parent = path.dirname(current);
      if (parent === current) break; // Reached root
      current = parent;
    }
    return false;
  }

  // =========================================================================
  // Mutex (mkdir-based, portable)
  // =========================================================================

  /** Acquire sync lock. Returns true if acquired, false if another sync is running. */
  private acquireLock(): boolean {
    try {
      fs.mkdirSync(this.lockDir, { recursive: false });
    } catch (e: any) {
      if (e.code !== 'EEXIST') return false;

      // Lock exists — check if holder PID is alive
      const pidFile = path.join(this.lockDir, 'pid');
      let pid = 0;
      try { pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); } catch {}

      if (pid > 0 && this.isPidAlive(pid)) {
        return false; // Another sync is genuinely running
      }

      // Stale lock — clean up and retry
      try {
        fs.rmSync(this.lockDir, { recursive: true, force: true });
        fs.mkdirSync(this.lockDir, { recursive: false });
      } catch {
        return false;
      }
    }

    // Write our PID
    try {
      fs.writeFileSync(path.join(this.lockDir, 'pid'), String(process.pid));
    } catch {}
    return true;
  }

  /** Release sync lock. */
  private releaseLock(): void {
    try {
      fs.rmSync(this.lockDir, { recursive: true, force: true });
    } catch {}
  }

  /** Check if a PID is alive (cross-platform). */
  private isPidAlive(pid: number): boolean {
    try {
      if (process.platform === 'win32') {
        // tasklist with PID filter — output contains process info if alive
        const result = execFileSync('tasklist', ['/FI', `PID eq ${pid}`], { encoding: 'utf8', timeout: 5000 });
        return !result.includes('No tasks');
      } else {
        process.kill(pid, 0); // Signal 0 = test if process exists
        return true;
      }
    } catch {
      return false;
    }
  }

  // =========================================================================
  // Debounce
  // =========================================================================

  /** Check if enough time has elapsed since last marker write. */
  private debounceCheck(markerFile: string, intervalMinutes: number): boolean {
    try {
      const raw = fs.readFileSync(markerFile, 'utf8').trim();
      const lastEpoch = parseInt(raw, 10);
      if (isNaN(lastEpoch)) return true;
      const nowEpoch = Math.floor(Date.now() / 1000);
      return (nowEpoch - lastEpoch) >= intervalMinutes * 60;
    } catch {
      return true; // No marker = first run, proceed
    }
  }

  /** Write current epoch to debounce marker. */
  private debounceTouch(markerFile: string): void {
    const epoch = String(Math.floor(Date.now() / 1000));
    this.atomicWrite(markerFile, epoch);
  }

  // =========================================================================
  // Shell-out Wrappers
  // =========================================================================

  /** Execute rclone with args. */
  private async rclone(args: string[]): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync('rclone', args, { timeout: RCLONE_TIMEOUT });
      return { code: 0, stdout, stderr };
    } catch (e: any) {
      return { code: e.code || 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
  }

  /** Execute git with args in a working directory. */
  private async gitExec(args: string[], cwd: string): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await execFileAsync('git', args, { cwd, timeout: GIT_TIMEOUT });
      return { code: 0, stdout, stderr };
    } catch (e: any) {
      return { code: e.code || 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
  }

  /** Copy with rsync (preferred) or fs.cpSync (fallback). */
  private async rsyncOrCp(src: string, dst: string, updateOnly = true): Promise<void> {
    // Try rsync first (not available on Windows typically)
    if (process.platform !== 'win32') {
      try {
        const args = ['-a'];
        if (updateOnly) args.push('--update');
        args.push(src.endsWith('/') ? src : src + '/', dst.endsWith('/') ? dst : dst + '/');
        await execFileAsync('rsync', args, { timeout: RCLONE_TIMEOUT });
        return;
      } catch {}
    }
    // Fallback to fs.cpSync
    fs.mkdirSync(dst, { recursive: true });
    fs.cpSync(src, dst, { recursive: true, force: !updateOnly });
  }

  // =========================================================================
  // Logging
  // =========================================================================

  /** Append a structured log entry to backup.log. */
  private logBackup(level: string, msg: string, op?: string, extra?: Record<string, any>): void {
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    const sessionId = (process.env.CLAUDE_SESSION_ID || '').slice(0, 8);

    if (op) {
      const entry: Record<string, any> = { ts, level, op, sid: sessionId, msg };
      if (extra) Object.assign(entry, extra);
      try {
        fs.appendFileSync(this.backupLogPath, JSON.stringify(entry) + '\n');
      } catch {}
    } else {
      try {
        fs.appendFileSync(this.backupLogPath, `[${ts}] [${level}] ${msg}\n`);
      } catch {}
    }
  }

  // =========================================================================
  // File Helpers
  // =========================================================================

  private readJson(filePath: string): any {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  private readText(filePath: string): string {
    try {
      return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
      return '';
    }
  }

  /** Atomic write via same-directory temp file + rename. */
  private atomicWrite(target: string, content: string): void {
    const tmp = `${target}.tmp.${process.pid}`;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, target);
  }

  private dirExists(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
  }

  private fileExists(p: string): boolean {
    try { fs.accessSync(p); return true; } catch { return false; }
  }

  // =========================================================================
  // Skill Route Check
  // =========================================================================

  /** Check if a skill should be synced (not routed to 'none'). */
  private shouldSyncSkill(skillName: string): boolean {
    const routesFile = path.join(this.claudeDir, 'toolkit-state', 'skill-routes.json');
    const routes = this.readJson(routesFile);
    if (!routes || !routes[skillName]) return true;
    return routes[skillName].route !== 'none';
  }

  // =========================================================================
  // Push: Drive Backend
  // =========================================================================

  private async pushDrive(): Promise<number> {
    const driveRoot = this.configGet('DRIVE_ROOT', 'Claude');
    const remoteBase = `gdrive:${driveRoot}/Backup/personal`;
    const sysRemote = `${remoteBase}/system-backup`;
    let errors = 0;

    // Memory files — per project key
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (this.dirExists(projectsDir)) {
      for (const projectKey of fs.readdirSync(projectsDir)) {
        const memoryDir = path.join(projectsDir, projectKey, 'memory');
        if (!this.dirExists(memoryDir)) continue;
        const r = await this.rclone(['copy', memoryDir + '/', `${remoteBase}/memory/${projectKey}/`, '--update', '--skip-links']);
        if (r.code !== 0) { this.logBackup('WARN', `Drive push memory/${projectKey} failed`, 'sync.push.drive'); errors++; }
      }
    }

    // CLAUDE.md
    const claudeMd = path.join(this.claudeDir, 'CLAUDE.md');
    if (this.fileExists(claudeMd)) {
      const r = await this.rclone(['copyto', claudeMd, `${remoteBase}/CLAUDE.md`, '--update']);
      if (r.code !== 0) { this.logBackup('WARN', 'Drive push CLAUDE.md failed', 'sync.push.drive'); errors++; }
    }

    // Encyclopedia
    const encDir = path.join(this.claudeDir, 'encyclopedia');
    if (this.dirExists(encDir)) {
      await this.rclone(['copy', encDir + '/', `${remoteBase}/encyclopedia/`, '--update', '--max-depth', '1', '--include', '*.md']);
      // Also push to legacy encyclopedia path from config
      const encRemotePath = this.configGet('encyclopedia_remote_path', 'Encyclopedia/System');
      await this.rclone(['copy', encDir + '/', `gdrive:${driveRoot}/${encRemotePath}/`, '--update', '--max-depth', '1', '--include', '*.md']);
    }

    // User-created skills
    const skillsDir = path.join(this.claudeDir, 'skills');
    if (this.dirExists(skillsDir)) {
      for (const skillName of fs.readdirSync(skillsDir)) {
        const skillDir = path.join(skillsDir, skillName);
        if (!this.dirExists(skillDir)) continue;
        // Skip toolkit-owned skills (symlinked from toolkit)
        if (this.isToolkitOwned(skillDir)) continue;
        if (!this.shouldSyncSkill(skillName)) continue;
        await this.rclone(['copy', skillDir + '/', `${remoteBase}/skills/${skillName}/`, '--update', '--exclude', '.DS_Store']);
      }
    }

    // Conversations — snapshot to temp dir first to avoid races with subagents
    if (this.dirExists(projectsDir)) {
      const snapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-conv-'));
      try {
        for (const slugName of fs.readdirSync(projectsDir)) {
          const slugDir = path.join(projectsDir, slugName);
          if (!this.dirExists(slugDir)) continue;
          // Skip symlinked slug dirs (foreign device slugs)
          try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }

          // Find real .jsonl files (not symlinks)
          const jsonlFiles = fs.readdirSync(slugDir).filter(f => f.endsWith('.jsonl') && !fs.lstatSync(path.join(slugDir, f)).isSymbolicLink());
          if (jsonlFiles.length === 0) continue;

          const snapSlugDir = path.join(snapDir, slugName);
          fs.mkdirSync(snapSlugDir, { recursive: true });
          for (const f of jsonlFiles) {
            fs.copyFileSync(path.join(slugDir, f), path.join(snapSlugDir, f));
          }

          const r = await this.rclone(['copy', snapSlugDir + '/', `${remoteBase}/conversations/${slugName}/`, '--checksum', '--include', '*.jsonl']);
          if (r.code !== 0) { this.logBackup('WARN', `Drive push conversations/${slugName} failed`, 'sync.push.drive'); errors++; }
        }
      } finally {
        fs.rmSync(snapDir, { recursive: true, force: true });
      }
    }

    // System config
    const sysFiles: [string, string][] = [
      [this.configPath, `${sysRemote}/config.json`],
      [path.join(this.claudeDir, 'settings.json'), `${sysRemote}/settings.json`],
      [path.join(this.claudeDir, 'keybindings.json'), `${sysRemote}/keybindings.json`],
      [path.join(this.claudeDir, 'mcp.json'), `${sysRemote}/mcp.json`],
      [path.join(this.claudeDir, 'history.jsonl'), `${sysRemote}/history.jsonl`],
    ];
    for (const [local, remote] of sysFiles) {
      if (this.fileExists(local)) {
        const r = await this.rclone(['copyto', local, remote, '--update']);
        if (r.code !== 0) { this.logBackup('WARN', `Drive push ${path.basename(local)} failed`, 'sync.push.drive'); errors++; }
      }
    }
    // Plans and specs directories
    for (const dir of ['plans', 'specs']) {
      const localDir = path.join(this.claudeDir, dir);
      if (this.dirExists(localDir)) {
        await this.rclone(['copy', localDir + '/', `${sysRemote}/${dir}/`, '--update']);
      }
    }

    // Conversation index
    if (this.fileExists(this.conversationIndexPath)) {
      await this.rclone(['copyto', this.conversationIndexPath, `${sysRemote}/conversation-index.json`, '--checksum']);
    }

    this.logBackup(errors > 0 ? 'WARN' : 'INFO', `Drive sync completed (${errors} error(s))`, 'sync.push.drive');
    return errors;
  }

  // =========================================================================
  // Push: GitHub Backend
  // =========================================================================

  private async pushGithub(): Promise<number> {
    const syncRepo = this.configGet('PERSONAL_SYNC_REPO', '');
    const repoDir = path.join(this.claudeDir, 'toolkit-state', 'personal-sync-repo');
    let errors = 0;

    // Init repo if missing
    if (!this.dirExists(path.join(repoDir, '.git'))) {
      if (!syncRepo) {
        this.logBackup('ERROR', 'PERSONAL_SYNC_REPO not configured', 'sync.push.github');
        return 1;
      }
      fs.mkdirSync(repoDir, { recursive: true });
      const cloneResult = await this.gitExec(['clone', syncRepo, repoDir], this.claudeDir);
      if (cloneResult.code !== 0) {
        // Init fresh repo
        await this.gitExec(['init'], repoDir);
        await this.gitExec(['remote', 'add', 'personal-sync', syncRepo], repoDir);
        fs.writeFileSync(path.join(repoDir, 'README.md'), '# Personal Claude Data Backup\n');
        fs.writeFileSync(path.join(repoDir, '.gitignore'), '.DS_Store\nThumbs.db\n*.tmp\n');
        await this.gitExec(['add', '-A'], repoDir);
        await this.gitExec(['commit', '-m', 'Initial commit', '--no-gpg-sign'], repoDir);
        await this.gitExec(['branch', '-M', 'main'], repoDir);
        await this.gitExec(['push', '-u', 'personal-sync', 'main'], repoDir);
      }
    }

    // Ensure remote URL is current
    await this.gitExec(['remote', 'set-url', 'personal-sync', syncRepo], repoDir);

    // Copy all data categories into repo structure
    const projectsDir = path.join(this.claudeDir, 'projects');

    // Memory files
    if (this.dirExists(projectsDir)) {
      for (const projectKey of fs.readdirSync(projectsDir)) {
        const memoryDir = path.join(projectsDir, projectKey, 'memory');
        if (!this.dirExists(memoryDir)) continue;
        const dest = path.join(repoDir, 'memory', projectKey);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(memoryDir, dest, { recursive: true, force: true });
      }
    }

    // CLAUDE.md
    const claudeMd = path.join(this.claudeDir, 'CLAUDE.md');
    if (this.fileExists(claudeMd)) fs.copyFileSync(claudeMd, path.join(repoDir, 'CLAUDE.md'));

    // Encyclopedia
    const encDir = path.join(this.claudeDir, 'encyclopedia');
    if (this.dirExists(encDir)) {
      const dest = path.join(repoDir, 'encyclopedia');
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(encDir, dest, { recursive: true, force: true });
    }

    // User-created skills
    const skillsDir = path.join(this.claudeDir, 'skills');
    if (this.dirExists(skillsDir)) {
      for (const skillName of fs.readdirSync(skillsDir)) {
        const skillDir = path.join(skillsDir, skillName);
        if (!this.dirExists(skillDir) || this.isToolkitOwned(skillDir)) continue;
        if (!this.shouldSyncSkill(skillName)) continue;
        const dest = path.join(repoDir, 'skills', skillName);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(skillDir, dest, { recursive: true, force: true });
      }
    }

    // Conversations (real .jsonl files only, skip symlinks)
    if (this.dirExists(projectsDir)) {
      for (const slugName of fs.readdirSync(projectsDir)) {
        const slugDir = path.join(projectsDir, slugName);
        if (!this.dirExists(slugDir)) continue;
        try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }
        const jsonlFiles = fs.readdirSync(slugDir).filter(f => {
          if (!f.endsWith('.jsonl')) return false;
          try { return !fs.lstatSync(path.join(slugDir, f)).isSymbolicLink(); } catch { return false; }
        });
        if (jsonlFiles.length === 0) continue;
        const dest = path.join(repoDir, 'conversations', slugName);
        fs.mkdirSync(dest, { recursive: true });
        for (const f of jsonlFiles) {
          fs.copyFileSync(path.join(slugDir, f), path.join(dest, f));
        }
      }
    }

    // System config
    const sysDir = path.join(repoDir, 'system-backup');
    fs.mkdirSync(sysDir, { recursive: true });
    for (const [src, name] of [
      [this.configPath, 'config.json'],
      [path.join(this.claudeDir, 'settings.json'), 'settings.json'],
      [path.join(this.claudeDir, 'keybindings.json'), 'keybindings.json'],
      [path.join(this.claudeDir, 'mcp.json'), 'mcp.json'],
      [path.join(this.claudeDir, 'history.jsonl'), 'history.jsonl'],
    ] as const) {
      if (this.fileExists(src)) fs.copyFileSync(src, path.join(sysDir, name));
    }
    for (const dir of ['plans', 'specs']) {
      const srcDir = path.join(this.claudeDir, dir);
      if (this.dirExists(srcDir)) {
        const dest = path.join(sysDir, dir);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(srcDir, dest, { recursive: true, force: true });
      }
    }
    // Conversation index
    if (this.fileExists(this.conversationIndexPath)) {
      fs.copyFileSync(this.conversationIndexPath, path.join(sysDir, 'conversation-index.json'));
    }

    // Git add, commit, push
    await this.gitExec(['add', '-A'], repoDir);
    const diffResult = await this.gitExec(['diff', '--cached', '--quiet'], repoDir);
    if (diffResult.code !== 0) {
      // There are staged changes
      await this.gitExec(['commit', '-m', 'auto: sync', '--no-gpg-sign'], repoDir);
      const pushResult = await this.gitExec(['push', 'personal-sync', 'main'], repoDir);
      if (pushResult.code !== 0) {
        this.logBackup('WARN', 'Push to personal-sync repo failed', 'sync.push.github');
        errors++;
      }
    }

    this.logBackup(errors > 0 ? 'WARN' : 'INFO', 'GitHub sync completed', 'sync.push.github');
    return errors;
  }

  // =========================================================================
  // Push: iCloud Backend
  // =========================================================================

  private async pushiCloud(): Promise<number> {
    const icloudPath = this.resolveICloudPath();
    if (!icloudPath) {
      this.logBackup('ERROR', 'iCloud Drive folder not found', 'sync.push.icloud');
      return 1;
    }

    fs.mkdirSync(icloudPath, { recursive: true });
    let errors = 0;

    // Memory files
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (this.dirExists(projectsDir)) {
      for (const projectKey of fs.readdirSync(projectsDir)) {
        const memoryDir = path.join(projectsDir, projectKey, 'memory');
        if (!this.dirExists(memoryDir)) continue;
        const dest = path.join(icloudPath, 'memory', projectKey);
        fs.mkdirSync(dest, { recursive: true });
        try { await this.rsyncOrCp(memoryDir, dest); } catch { errors++; }
      }
    }

    // CLAUDE.md
    const claudeMd = path.join(this.claudeDir, 'CLAUDE.md');
    if (this.fileExists(claudeMd)) {
      try { fs.copyFileSync(claudeMd, path.join(icloudPath, 'CLAUDE.md')); } catch {}
    }

    // Encyclopedia
    const encDir = path.join(this.claudeDir, 'encyclopedia');
    if (this.dirExists(encDir)) {
      const dest = path.join(icloudPath, 'encyclopedia');
      fs.mkdirSync(dest, { recursive: true });
      try { await this.rsyncOrCp(encDir, dest); } catch {}
    }

    // Skills
    const skillsDir = path.join(this.claudeDir, 'skills');
    if (this.dirExists(skillsDir)) {
      for (const skillName of fs.readdirSync(skillsDir)) {
        const skillDir = path.join(skillsDir, skillName);
        if (!this.dirExists(skillDir) || this.isToolkitOwned(skillDir)) continue;
        if (!this.shouldSyncSkill(skillName)) continue;
        const dest = path.join(icloudPath, 'skills', skillName);
        fs.mkdirSync(dest, { recursive: true });
        try { await this.rsyncOrCp(skillDir, dest); } catch {}
      }
    }

    // Conversations
    if (this.dirExists(projectsDir)) {
      for (const slugName of fs.readdirSync(projectsDir)) {
        const slugDir = path.join(projectsDir, slugName);
        if (!this.dirExists(slugDir)) continue;
        try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }
        const jsonlFiles = fs.readdirSync(slugDir).filter(f => {
          if (!f.endsWith('.jsonl')) return false;
          try { return !fs.lstatSync(path.join(slugDir, f)).isSymbolicLink(); } catch { return false; }
        });
        for (const f of jsonlFiles) {
          const dest = path.join(icloudPath, 'conversations', slugName);
          fs.mkdirSync(dest, { recursive: true });
          try { fs.copyFileSync(path.join(slugDir, f), path.join(dest, f)); } catch {}
        }
      }
    }

    // System config
    const sysPath = path.join(icloudPath, 'system-backup');
    fs.mkdirSync(sysPath, { recursive: true });
    for (const [src, name] of [
      [this.configPath, 'config.json'],
      [path.join(this.claudeDir, 'settings.json'), 'settings.json'],
      [path.join(this.claudeDir, 'keybindings.json'), 'keybindings.json'],
      [path.join(this.claudeDir, 'mcp.json'), 'mcp.json'],
      [path.join(this.claudeDir, 'history.jsonl'), 'history.jsonl'],
    ] as const) {
      if (this.fileExists(src)) { try { fs.copyFileSync(src, path.join(sysPath, name)); } catch {} }
    }
    for (const dir of ['plans', 'specs']) {
      const srcDir = path.join(this.claudeDir, dir);
      if (this.dirExists(srcDir)) {
        const dest = path.join(sysPath, dir);
        fs.mkdirSync(dest, { recursive: true });
        try { await this.rsyncOrCp(srcDir, dest); } catch {}
      }
    }
    if (this.fileExists(this.conversationIndexPath)) {
      try { fs.copyFileSync(this.conversationIndexPath, path.join(sysPath, 'conversation-index.json')); } catch {}
    }

    this.logBackup('INFO', 'iCloud sync complete', 'sync.push.icloud');
    return errors;
  }

  /** Resolve iCloud Drive path (auto-detect or from config). */
  private resolveICloudPath(): string | null {
    const configured = this.configGet('ICLOUD_PATH', '');
    if (configured && this.dirExists(configured)) return configured;

    // Auto-detect by platform
    const candidates = [
      path.join(os.homedir(), 'Library/Mobile Documents/com~apple~CloudDocs/DestinClaude'),
      path.join(os.homedir(), 'iCloudDrive/DestinClaude'),
      path.join(os.homedir(), 'Apple/CloudDocs/DestinClaude'),
    ];
    for (const c of candidates) {
      // Check parent dir exists (DestinClaude subdir may not yet)
      if (this.dirExists(path.dirname(c))) return c;
    }
    return null;
  }

  // =========================================================================
  // Push: Orchestrator
  // =========================================================================

  /** Push all personal data to all configured backends. */
  async push(opts?: { force?: boolean }): Promise<PushResult> {
    if (this.pushing) return { success: false, errors: 0, backends: [] };
    this.pushing = true;

    try {
      // Update conversation index before push
      this.updateConversationIndex();

      // Acquire lock
      if (!this.acquireLock()) {
        this.logBackup('INFO', 'Push skipped — another sync is running', 'sync.push');
        return { success: false, errors: 0, backends: [] };
      }

      try {
        // Debounce check (skip if force)
        if (!opts?.force && !this.debounceCheck(this.syncMarkerPath, PUSH_DEBOUNCE_MIN)) {
          this.logBackup('INFO', 'Push skipped — debounce', 'sync.push');
          return { success: true, errors: 0, backends: [] };
        }

        const backends = this.getBackends();
        if (backends.length === 0) return { success: true, errors: 0, backends: [] };

        let totalErrors = 0;

        for (const backend of backends) {
          try {
            let backendErrors = 0;
            switch (backend) {
              case 'drive': backendErrors = await this.pushDrive(); break;
              case 'github': backendErrors = await this.pushGithub(); break;
              case 'icloud': backendErrors = await this.pushiCloud(); break;
              default: this.logBackup('WARN', `Unknown backend: ${backend}`, 'sync.push'); break;
            }
            totalErrors += backendErrors;
          } catch (e) {
            this.logBackup('ERROR', `${backend} push failed: ${e}`, 'sync.push');
            totalErrors++;
          }
        }

        // Write backup-meta.json on success
        if (totalErrors === 0) this.writeBackupMeta();

        // Update debounce marker AFTER sync (critical ordering)
        this.debounceTouch(this.syncMarkerPath);

        this.emit('push-complete', { errors: totalErrors });
        return { success: totalErrors === 0, errors: totalErrors, backends };
      } finally {
        this.releaseLock();
      }
    } finally {
      this.pushing = false;
    }
  }

  // =========================================================================
  // Pull: Drive Backend
  // =========================================================================

  private async pullDrive(): Promise<void> {
    const driveRoot = this.configGet('DRIVE_ROOT', 'Claude');
    const remoteBase = `gdrive:${driveRoot}/Backup/personal`;
    const sysRemote = `gdrive:${driveRoot}/Backup/system-backup`;

    // Memory files — list remote keys, then pull each
    const memResult = await this.rclone(['lsf', `${remoteBase}/memory/`, '--dirs-only']);
    if (memResult.code === 0) {
      const memKeys = memResult.stdout.split('\n').map(k => k.replace(/\/$/, '').trim()).filter(Boolean);
      for (const key of memKeys) {
        const dest = path.join(this.claudeDir, 'projects', key, 'memory');
        fs.mkdirSync(dest, { recursive: true });
        await this.rclone(['copy', `${remoteBase}/memory/${key}/`, dest + '/', '--update', '--skip-links', '--exclude', '.DS_Store']);
      }
    }

    // Parallel pulls for non-dependent resources
    await Promise.all([
      // CLAUDE.md
      this.rclone(['copyto', `${remoteBase}/CLAUDE.md`, path.join(this.claudeDir, 'CLAUDE.md'), '--update']),
      // System config
      this.rclone(['copyto', `${sysRemote}/config.json`, this.configPath, '--update']),
      // Encyclopedia
      (async () => {
        const encDir = path.join(this.claudeDir, 'encyclopedia');
        fs.mkdirSync(encDir, { recursive: true });
        await this.rclone(['copy', `${remoteBase}/encyclopedia/`, encDir + '/', '--update', '--max-depth', '1', '--include', '*.md']);
      })(),
      // Conversations — checksum + ignore-existing (don't overwrite local)
      (async () => {
        await this.rclone(['copy', `${remoteBase}/conversations/`, path.join(this.claudeDir, 'projects') + '/', '--checksum', '--include', '*.jsonl', '--ignore-existing']);
      })(),
      // Conversation index to staging dir for post-pull merge
      (async () => {
        fs.mkdirSync(this.indexStagingDir, { recursive: true });
        await this.rclone(['copy', `${sysRemote}/conversation-index.json`, this.indexStagingDir + '/', '--checksum']);
      })(),
    ]);
  }

  // =========================================================================
  // Pull: GitHub Backend
  // =========================================================================

  private async pullGithub(): Promise<void> {
    const syncRepo = this.configGet('PERSONAL_SYNC_REPO', '');
    const repoDir = path.join(this.claudeDir, 'toolkit-state', 'personal-sync-repo');

    if (!syncRepo || !this.dirExists(path.join(repoDir, '.git'))) return;

    const pullResult = await this.gitExec(['pull', 'personal-sync', 'main'], repoDir);
    if (pullResult.code !== 0) {
      this.logBackup('WARN', 'GitHub personal-sync pull failed', 'sync.pull.github');
      return;
    }

    // Copy restored files to live locations (don't overwrite existing)
    const repoMemory = path.join(repoDir, 'memory');
    if (this.dirExists(repoMemory)) {
      for (const key of fs.readdirSync(repoMemory)) {
        const dest = path.join(this.claudeDir, 'projects', key, 'memory');
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(path.join(repoMemory, key), dest, { recursive: true, force: false });
      }
    }

    const repoClaudeMd = path.join(repoDir, 'CLAUDE.md');
    if (this.fileExists(repoClaudeMd) && !this.fileExists(path.join(this.claudeDir, 'CLAUDE.md'))) {
      fs.copyFileSync(repoClaudeMd, path.join(this.claudeDir, 'CLAUDE.md'));
    }

    const repoEnc = path.join(repoDir, 'encyclopedia');
    if (this.dirExists(repoEnc)) {
      const dest = path.join(this.claudeDir, 'encyclopedia');
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(repoEnc, dest, { recursive: true, force: false });
    }

    // Conversations
    const repoConv = path.join(repoDir, 'conversations');
    if (this.dirExists(repoConv)) {
      for (const slugName of fs.readdirSync(repoConv)) {
        const src = path.join(repoConv, slugName);
        const dest = path.join(this.claudeDir, 'projects', slugName);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(src, dest, { recursive: true, force: false });
      }
    }

    // System config
    const repoSys = path.join(repoDir, 'system-backup');
    if (this.fileExists(path.join(repoSys, 'config.json'))) {
      fs.copyFileSync(path.join(repoSys, 'config.json'), this.configPath);
    }

    // Conversation index to staging
    const repoIndex = path.join(repoSys, 'conversation-index.json');
    if (this.fileExists(repoIndex)) {
      fs.mkdirSync(this.indexStagingDir, { recursive: true });
      fs.copyFileSync(repoIndex, path.join(this.indexStagingDir, 'conversation-index.json'));
    }
  }

  // =========================================================================
  // Pull: iCloud Backend
  // =========================================================================

  private async pulliCloud(): Promise<void> {
    const icloudPath = this.resolveICloudPath();
    if (!icloudPath || !this.dirExists(icloudPath)) return;

    // Memory
    const icMemory = path.join(icloudPath, 'memory');
    if (this.dirExists(icMemory)) {
      for (const key of fs.readdirSync(icMemory)) {
        const dest = path.join(this.claudeDir, 'projects', key, 'memory');
        fs.mkdirSync(dest, { recursive: true });
        try { await this.rsyncOrCp(path.join(icMemory, key), dest); } catch {}
      }
    }

    // CLAUDE.md
    const icClaudeMd = path.join(icloudPath, 'CLAUDE.md');
    if (this.fileExists(icClaudeMd) && !this.fileExists(path.join(this.claudeDir, 'CLAUDE.md'))) {
      fs.copyFileSync(icClaudeMd, path.join(this.claudeDir, 'CLAUDE.md'));
    }

    // Encyclopedia
    const icEnc = path.join(icloudPath, 'encyclopedia');
    if (this.dirExists(icEnc)) {
      const dest = path.join(this.claudeDir, 'encyclopedia');
      fs.mkdirSync(dest, { recursive: true });
      try { await this.rsyncOrCp(icEnc, dest); } catch {}
    }

    // Conversations
    const icConv = path.join(icloudPath, 'conversations');
    if (this.dirExists(icConv)) {
      for (const slugName of fs.readdirSync(icConv)) {
        const dest = path.join(this.claudeDir, 'projects', slugName);
        fs.mkdirSync(dest, { recursive: true });
        fs.cpSync(path.join(icConv, slugName), dest, { recursive: true, force: false });
      }
    }

    // System config
    const icSys = path.join(icloudPath, 'system-backup');
    if (this.fileExists(path.join(icSys, 'config.json'))) {
      fs.copyFileSync(path.join(icSys, 'config.json'), this.configPath);
    }

    // Conversation index to staging
    const icIndex = path.join(icSys, 'conversation-index.json');
    if (this.fileExists(icIndex)) {
      fs.mkdirSync(this.indexStagingDir, { recursive: true });
      fs.copyFileSync(icIndex, path.join(this.indexStagingDir, 'conversation-index.json'));
    }
  }

  // =========================================================================
  // Pull: Orchestrator
  // =========================================================================

  /** Pull personal data from preferred backend + run post-pull operations. */
  async pull(): Promise<void> {
    if (this.pulling) return;
    this.pulling = true;

    try {
      const preferred = this.getPreferredBackend();
      if (!preferred) {
        this.logBackup('INFO', 'No backend configured — skipping pull', 'sync.pull');
        return;
      }

      this.logBackup('INFO', `Pulling from ${preferred}`, 'sync.pull');

      switch (preferred) {
        case 'drive': await this.pullDrive(); break;
        case 'github': await this.pullGithub(); break;
        case 'icloud': await this.pulliCloud(); break;
      }

      // Sequential post-pull operations (order matters)
      this.rewriteProjectSlugs();
      this.aggregateConversations();

      // Merge staged conversation index (from pull) with local
      const stagedIndex = path.join(this.indexStagingDir, 'conversation-index.json');
      if (this.fileExists(stagedIndex)) {
        this.mergeConversationIndex(stagedIndex);
      }

      this.regenerateTopicCache();

      this.emit('pull-complete');
      this.logBackup('INFO', 'Pull complete', 'sync.pull');
    } catch (e) {
      this.logBackup('ERROR', `Pull failed: ${e}`, 'sync.pull');
      throw e;
    } finally {
      this.pulling = false;
    }
  }

  // =========================================================================
  // Conversation Index Management
  // =========================================================================

  /** Scan topic files and upsert into conversation-index.json. */
  updateConversationIndex(): void {
    const topicsDir = path.join(this.claudeDir, 'topics');
    if (!this.dirExists(topicsDir)) return;

    // Read existing index
    let index: ConversationIndex = this.readJson(this.conversationIndexPath) || { version: 1, sessions: {} };
    if (!index.sessions) index.sessions = {};

    const slug = this.getCurrentSlug();
    const device = os.hostname();
    const now = Date.now();
    const pruneThreshold = now - INDEX_PRUNE_DAYS * 24 * 60 * 60 * 1000;

    // Scan topic files
    let files: string[];
    try { files = fs.readdirSync(topicsDir); } catch { return; }

    for (const file of files) {
      if (!file.startsWith('topic-')) continue;
      const sessionId = file.replace(/^topic-/, '');
      const filePath = path.join(topicsDir, file);

      try {
        const topic = fs.readFileSync(filePath, 'utf8').trim();
        if (!topic || topic === 'New Session') continue;

        const stat = fs.statSync(filePath);
        const lastActive = stat.mtime.toISOString();

        // Only upsert if newer than existing entry
        const existing = index.sessions[sessionId];
        if (existing && new Date(existing.lastActive).getTime() >= stat.mtimeMs) continue;

        index.sessions[sessionId] = { topic, lastActive, slug, device };
      } catch {}
    }

    // Prune old entries
    for (const [sid, entry] of Object.entries(index.sessions)) {
      if (new Date(entry.lastActive).getTime() < pruneThreshold) {
        delete index.sessions[sid];
      }
    }

    this.atomicWrite(this.conversationIndexPath, JSON.stringify(index, null, 2));
  }

  /** Merge a remote conversation index with the local one (union, latest wins). */
  mergeConversationIndex(remotePath: string): void {
    const remote: ConversationIndex = this.readJson(remotePath) || { version: 1, sessions: {} };
    const local: ConversationIndex = this.readJson(this.conversationIndexPath) || { version: 1, sessions: {} };

    const merged: ConversationIndex = { version: 1, sessions: { ...local.sessions } };

    for (const [sid, remoteEntry] of Object.entries(remote.sessions || {})) {
      const localEntry = merged.sessions[sid];
      if (!localEntry || new Date(remoteEntry.lastActive).getTime() > new Date(localEntry.lastActive).getTime()) {
        merged.sessions[sid] = remoteEntry;
      }
    }

    this.atomicWrite(this.conversationIndexPath, JSON.stringify(merged, null, 2));
  }

  /** Create topic cache files from index for cross-device sessions. */
  regenerateTopicCache(): void {
    const index: ConversationIndex = this.readJson(this.conversationIndexPath) || { version: 1, sessions: {} };
    const topicsDir = path.join(this.claudeDir, 'topics');
    fs.mkdirSync(topicsDir, { recursive: true });

    for (const [sid, entry] of Object.entries(index.sessions || {})) {
      const topicFile = path.join(topicsDir, `topic-${sid}`);
      // Only create if local file doesn't exist (local-first)
      if (!this.fileExists(topicFile)) {
        try { fs.writeFileSync(topicFile, entry.topic); } catch {}
      }
    }
  }

  // =========================================================================
  // Cross-Device Operations
  // =========================================================================

  /** Create symlinks from foreign device project slugs into current device's slug. */
  rewriteProjectSlugs(): void {
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!this.dirExists(projectsDir)) return;

    const currentSlug = this.getCurrentSlug();

    for (const slugName of fs.readdirSync(projectsDir)) {
      if (slugName === currentSlug) continue;
      const slugDir = path.join(projectsDir, slugName);

      // Skip if it's already a symlink (previous rewrite)
      try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }
      if (!fs.statSync(slugDir).isDirectory()) continue;

      // For each subdirectory in the foreign slug, create a symlink in current slug
      const currentSlugDir = path.join(projectsDir, currentSlug);
      fs.mkdirSync(currentSlugDir, { recursive: true });

      for (const subName of fs.readdirSync(slugDir)) {
        const target = path.join(currentSlugDir, subName);
        if (this.fileExists(target) || this.dirExists(target)) continue; // Don't overwrite local

        const relativeSrc = path.join('..', slugName, subName);
        try {
          // Use 'junction' on Windows to avoid Developer Mode requirement
          const symlinkType = process.platform === 'win32' && fs.statSync(path.join(slugDir, subName)).isDirectory() ? 'junction' : undefined;
          fs.symlinkSync(relativeSrc, target, symlinkType);
        } catch {
          // Fallback: copy if symlink fails
          try {
            fs.cpSync(path.join(slugDir, subName), target, { recursive: true });
          } catch {}
        }
      }
    }
  }

  /** Symlink all .jsonl files from non-home slugs into home slug for /resume from ~. */
  aggregateConversations(): void {
    const projectsDir = path.join(this.claudeDir, 'projects');
    if (!this.dirExists(projectsDir)) return;

    const currentSlug = this.getCurrentSlug();
    const homeDir = path.join(projectsDir, currentSlug);
    if (!this.dirExists(homeDir)) return;

    for (const slugName of fs.readdirSync(projectsDir)) {
      if (slugName === currentSlug) continue;
      const slugDir = path.join(projectsDir, slugName);

      // Skip symlinked slug dirs
      try { if (fs.lstatSync(slugDir).isSymbolicLink()) continue; } catch { continue; }
      if (!fs.statSync(slugDir).isDirectory()) continue;

      // Symlink each .jsonl into home slug
      for (const file of fs.readdirSync(slugDir)) {
        if (!file.endsWith('.jsonl')) continue;
        const target = path.join(homeDir, file);
        if (this.fileExists(target)) continue; // Don't overwrite

        const relativeSrc = path.join('..', slugName, file);
        try {
          fs.symlinkSync(relativeSrc, target);
        } catch {}
      }
    }

    // Clean up dangling symlinks in home dir
    for (const file of fs.readdirSync(homeDir)) {
      const filePath = path.join(homeDir, file);
      try {
        const lstat = fs.lstatSync(filePath);
        if (lstat.isSymbolicLink()) {
          // Check if target exists
          try { fs.statSync(filePath); } catch {
            // Target doesn't exist — dangling symlink
            fs.unlinkSync(filePath);
          }
        }
      } catch {}
    }
  }

  // =========================================================================
  // Backup Metadata
  // =========================================================================

  /** Write backup-meta.json after successful sync. */
  private writeBackupMeta(): void {
    const toolkitRoot = this.configGet('toolkit_root', '');
    let toolkitVersion = 'unknown';
    if (toolkitRoot) {
      try { toolkitVersion = fs.readFileSync(path.join(toolkitRoot, 'VERSION'), 'utf8').trim(); } catch {}
    }

    const meta = {
      schema_version: 1,
      toolkit_version: toolkitVersion,
      last_backup: new Date().toISOString(),
      platform: process.platform,
    };

    this.atomicWrite(path.join(this.claudeDir, 'backup-meta.json'), JSON.stringify(meta, null, 2));
  }

  // =========================================================================
  // Session-End Push
  // =========================================================================

  /** Push a single session's JSONL to all backends (called on session close). */
  async pushSession(sessionId: string): Promise<void> {
    const slug = this.getCurrentSlug();
    const jsonlFile = path.join(this.claudeDir, 'projects', slug, `${sessionId}.jsonl`);
    if (!this.fileExists(jsonlFile)) return;

    // Update conversation index first
    this.updateConversationIndex();

    const backends = this.getBackends();
    const driveRoot = this.configGet('DRIVE_ROOT', 'Claude');

    for (const backend of backends) {
      try {
        switch (backend) {
          case 'drive': {
            await this.rclone(['copy', jsonlFile, `gdrive:${driveRoot}/Backup/personal/conversations/${slug}/`, '--checksum']);
            // Also push conversation index
            if (this.fileExists(this.conversationIndexPath)) {
              await this.rclone(['copyto', this.conversationIndexPath, `gdrive:${driveRoot}/Backup/system-backup/conversation-index.json`, '--checksum']);
            }
            break;
          }
          case 'github': {
            const repoDir = path.join(this.claudeDir, 'toolkit-state', 'personal-sync-repo');
            if (!this.dirExists(path.join(repoDir, '.git'))) break;
            const convDir = path.join(repoDir, 'conversations', slug);
            fs.mkdirSync(convDir, { recursive: true });
            fs.copyFileSync(jsonlFile, path.join(convDir, `${sessionId}.jsonl`));
            if (this.fileExists(this.conversationIndexPath)) {
              fs.mkdirSync(path.join(repoDir, 'system-backup'), { recursive: true });
              fs.copyFileSync(this.conversationIndexPath, path.join(repoDir, 'system-backup', 'conversation-index.json'));
            }
            await this.gitExec(['add', '-A'], repoDir);
            const diff = await this.gitExec(['diff', '--cached', '--quiet'], repoDir);
            if (diff.code !== 0) {
              await this.gitExec(['commit', '-m', 'auto: session-end sync', '--no-gpg-sign'], repoDir);
              await this.gitExec(['push', 'personal-sync', 'main'], repoDir);
            }
            break;
          }
          case 'icloud': {
            const icloudPath = this.resolveICloudPath();
            if (!icloudPath) break;
            const convDir = path.join(icloudPath, 'conversations', slug);
            fs.mkdirSync(convDir, { recursive: true });
            fs.copyFileSync(jsonlFile, path.join(convDir, `${sessionId}.jsonl`));
            if (this.fileExists(this.conversationIndexPath)) {
              fs.mkdirSync(path.join(icloudPath, 'system-backup'), { recursive: true });
              fs.copyFileSync(this.conversationIndexPath, path.join(icloudPath, 'system-backup', 'conversation-index.json'));
            }
            break;
          }
        }
      } catch (e) {
        this.logBackup('WARN', `Session-end ${backend} sync failed: ${e}`, 'sync.sessionend');
      }
    }

    this.logBackup('INFO', `Session-end sync for ${sessionId.slice(0, 8)}`, 'sync.sessionend');
  }
}
