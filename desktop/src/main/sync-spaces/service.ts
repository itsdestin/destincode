// desktop/src/main/sync-spaces/service.ts
// Composition root: owns the singleton ManagedRoots/SpaceManager/Engine and
// exposes the functions IPC + remote-server call. Mirrors the sync-state.ts
// singleton pattern (setSyncService/getSyncService).
import os from 'os';
import { BrowserWindow } from 'electron';
import { ManagedRoots } from './managed-roots';
import { SpaceManager } from './space-manager';
import { GitTransport } from './git-transport';
import { SpaceSyncEngine } from './engine';
import { DailyBackup, BackupTarget } from './daily-backup';
import type { SpaceSyncEvent } from './types';

let roots: ManagedRoots | null = null;
let manager: SpaceManager | null = null;
let engine: SpaceSyncEngine | null = null;
let backup: DailyBackup | null = null;
let backupTimer: ReturnType<typeof setInterval> | null = null;
let recentEvents: SpaceSyncEvent[] = [];
let logFn: (m: string) => void = console.log;

// main.ts wires this to RemoteServer.broadcast so engine events also reach
// remote browser / Android clients. There is NO central push forwarder in this
// app — each emit site fans out to BOTH BrowserWindows and remote clients (see
// how ipc-handlers.ts sends transcript/status pushes via webContents AND
// remoteServer.broadcast). This keeps service.ts free of a remote-server import
// (remote-server imports THIS module, so importing back would be circular).
let remoteBroadcast: ((e: SpaceSyncEvent) => void) | null = null;
export function setSyncSpacesRemoteBroadcaster(fn: ((e: SpaceSyncEvent) => void) | null): void {
  remoteBroadcast = fn;
}

function broadcast(e: SpaceSyncEvent): void {
  recentEvents = [...recentEvents.slice(-49), e];
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('syncspaces:event', e); } catch { /* window closing */ }
  }
  // Fan out to remote clients too (see comment on remoteBroadcast above).
  try { remoteBroadcast?.(e); } catch { /* remote server not up / closing */ }
}

/** Called once from main.ts after app ready. Roots always exist (the picker
 *  needs them); the engine only starts when the user enabled sync.
 *  getBackupTargets is async because the backend config read (getSyncConfig)
 *  is async — the daily backup timer awaits it fresh each cycle. */
export async function startSyncSpaces(getBackupTargets: () => Promise<BackupTarget[]>, log: (m: string) => void): Promise<void> {
  logFn = log;
  roots = new ManagedRoots();
  roots.ensure();
  manager = new SpaceManager();
  if (manager.isEnabled()) await startEngine(logFn);
  backup = new DailyBackup();
  // runIfDue never throws by contract, but resolving the targets (async config
  // read) can — guard so the hourly timer can never become an unhandled reject.
  const runBackup = async () => {
    try { await backup!.runIfDue(roots!.spaces(), await getBackupTargets(), logFn); }
    catch (e: any) { logFn(`sync-spaces: daily backup check failed: ${String(e?.message ?? e)}`); }
  };
  backupTimer = setInterval(() => { void runBackup(); }, 60 * 60 * 1000);
  (backupTimer as any).unref?.();
  void runBackup();
}

async function startEngine(log: (m: string) => void): Promise<void> {
  const transport = new GitTransport({ deviceName: os.hostname() });
  engine = new SpaceSyncEngine(transport, { onEvent: broadcast });
  for (const space of roots!.spaces()) {
    try {
      await engine.addSpace(space);
      const url = await manager!.ensureRemote(space);
      await transport.setRemote(space, url);
      void engine.syncSpace(space); // initial reconcile
    } catch (e: any) {
      log(`sync-spaces: failed to start space ${space.id}: ${String(e?.message ?? e)}`);
      broadcast({ type: 'error', spaceId: space.id, message: String(e?.message ?? e) });
    }
  }
}

export async function stopSyncSpaces(): Promise<void> {
  if (backupTimer) clearInterval(backupTimer);
  await engine?.stop();
  engine = null;
}

// ---- IPC-facing functions (also used by remote-server cases) ----
export async function syncSpacesStatus() {
  return {
    enabled: manager?.isEnabled() ?? false,
    spaces: roots?.spaces().map(s => ({ ...s, remote: manager?.remoteFor(s.id) ?? null })) ?? [],
    recentEvents,
  };
}

export async function syncSpacesEnable(enabled: boolean) {
  manager!.setEnabled(enabled);
  if (enabled && !engine) await startEngine(logFn);
  if (!enabled && engine) { await engine.stop(); engine = null; }
  return syncSpacesStatus();
}

export async function syncSpacesSyncNow() {
  if (engine && roots) for (const s of roots.spaces()) void engine.syncSpace(s);
  return { ok: true };
}

export async function syncSpacesCreateProject(name: string) {
  const result = roots!.createProject(name);
  if (result.ok && engine) {
    const space = roots!.spaces().find(s => s.id === `project:${name}`)!;
    try {
      await engine.addSpace(space);
      const transport = new GitTransport({ deviceName: os.hostname() });
      await transport.init(space);
      await transport.setRemote(space, await manager!.ensureRemote(space));
    } catch { /* engine events surface the failure */ }
  }
  return result;
}

export function getManagedRoots(): ManagedRoots | null { return roots; }
