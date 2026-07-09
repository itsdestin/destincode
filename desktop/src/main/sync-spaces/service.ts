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

// Why: enable(true) racing enable(false) (two windows, or panel double-click)
// would otherwise interleave — the disable stops the half-started engine and
// the resuming start adds watchers to a dead instance. Chaining every
// transition onto the previous one makes toggles strictly sequential.
let transition: Promise<void> = Promise.resolve();

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
  // Capture this start's instance locally: if a disable (or another start)
  // supersedes us mid-loop, the module-level `engine` no longer points at `e`
  // and we must stop OUR instance ourselves — otherwise its chokidar watchers
  // leak with nothing left holding a reference to close them.
  const e = new SpaceSyncEngine(transport, { onEvent: broadcast });
  engine = e;
  for (const space of roots!.spaces()) {
    if (engine !== e) { await e.stop(); return; } // superseded — clean up and bail
    try {
      await e.addSpace(space);
      const url = await manager!.ensureRemote(space);
      await transport.setRemote(space, url);
      void e.syncSpace(space); // initial reconcile
    } catch (err: any) {
      log(`sync-spaces: failed to start space ${space.id}: ${String(err?.message ?? err)}`);
      broadcast({ type: 'error', spaceId: space.id, message: String(err?.message ?? err) });
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
  // Chain this toggle onto the previous one (see `transition` comment above).
  // The .catch() keeps a failed earlier transition from poisoning every later
  // toggle — its error was already reported to the caller who triggered it.
  const run = transition.catch(() => { /* previous transition already surfaced its error */ }).then(async () => {
    if (enabled && !engine) await startEngine(logFn);
    if (!enabled && engine) {
      // Null BEFORE stopping so any still-in-flight start (the app-boot one
      // isn't chained through `transition`) sees the supersession immediately
      // and cleans up its own instance instead of watching a dead engine.
      const current = engine;
      engine = null;
      await current.stop();
    }
  });
  transition = run;
  await run;
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
      // No initial syncSpace here: a freshly created folder is empty — the
      // first file change (debounce) or the 2-minute poll drives the first sync.
    } catch { /* engine events surface the failure */ }
  }
  return result;
}

export function getManagedRoots(): ManagedRoots | null { return roots; }
