// desktop/src/main/sync-spaces/service.ts
// Composition root: owns the singleton ManagedRoots/SpaceManager/Engine and
// exposes the functions IPC + remote-server call. Mirrors the sync-state.ts
// singleton pattern (setSyncService/getSyncService).
import os from 'os';
import { BrowserWindow } from 'electron';
import { ManagedRoots } from './managed-roots';
import { SpaceManager, repoNameForSpace } from './space-manager';
import { GitTransport } from './git-transport';
import { SpaceSyncEngine } from './engine';
import { DailyBackup, BackupTarget } from './daily-backup';
import { importProjectFolder } from './import-project';
import { createSyncHubSocket } from '../sync-hub-socket';
import type { SpaceSyncEvent } from './types';

let roots: ManagedRoots | null = null;
let manager: SpaceManager | null = null;
let engine: SpaceSyncEngine | null = null;
let backup: DailyBackup | null = null;
let backupTimer: ReturnType<typeof setInterval> | null = null;
let recentEvents: SpaceSyncEvent[] = [];
let logFn: (m: string) => void = console.log;

// SyncHub (Plan 1b): the WebSocket that relays "something changed" signals
// between this account's devices. Held for the enabled lifetime; the engine's
// 120s poll is the fallback when it's down. hubStatus feeds syncSpacesStatus().
let hubSocket: ReturnType<typeof createSyncHubSocket> | null = null;
let hubStatus: 'off' | 'connecting' | 'connected' | 'disconnected' = 'off';

// Auth store facade (marketplace token) wired from main.ts. Read lazily per
// connect so a mid-session sign-in/out takes effect without an app restart.
// Kept as a narrow facade so service.ts doesn't import the whole auth store.
let authStore: { getToken(): string | null } | null = null;
export function setSyncSpacesAuthStore(store: { getToken(): string | null } | null): void {
  authStore = store;
}

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
  // Stamp at emit time — the renderer derives "Last synced N min ago" from it,
  // so every stored + fanned-out copy must carry the same timestamp.
  const stamped: SpaceSyncEvent = { ...e, at: Date.now() };
  recentEvents = [...recentEvents.slice(-49), stamped];
  // A local push means this account's OTHER devices should pull now. Signal the
  // room. Guard on type + pushed so hub-status / error / pull-only events never
  // recurse into a send. sendSignal is a no-op when the socket is down (the
  // 120s poll still covers the miss), so this is safe to fire unconditionally.
  if (stamped.type === 'synced' && stamped.pushed && hubSocket) {
    const space = roots?.spaces().find(s => s.id === stamped.spaceId);
    if (space) hubSocket.sendSignal('space-updated', repoNameForSpace(space));
  }
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('syncspaces:event', stamped); } catch { /* window closing */ }
  }
  // Fan out to remote clients too (see comment on remoteBroadcast above).
  try { remoteBroadcast?.(stamped); } catch { /* remote server not up / closing */ }
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
    if (engine !== e) { await e.stop(); return; } // superseded — clean up and bail (no socket created yet)
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

  // SyncHub (Plan 1b): instant "something changed" signals between this
  // account's devices. The 120s poll in the engine stays as the fallback —
  // SyncHub being down never blocks sync, it only makes it less instant (spec §6).
  hubStatus = 'connecting';
  const spaceForKey = (key: string) =>
    roots!.spaces().find((s) => repoNameForSpace(s) === key) ?? null;
  const sock = createSyncHubSocket({
    getToken: () => authStore?.getToken() ?? null,
    deviceName: os.hostname(),
    onEvent: (ev) => {
      if (ev.type === 'signal' && ev.kind === 'space-updated') {
        // Another device pushed — pull that space now. syncSpace is single-flight
        // + coalescing, so signal bursts and hello-replay dupes are free.
        const space = spaceForKey(ev.spaceKey);
        if (space && engine) void engine.syncSpace(space);
      } else if (ev.type === 'connected') {
        hubStatus = 'connected';
        broadcast({ type: 'hub-status', spaceId: 'hub', status: 'connected' });
        // Reconcile-on-connect: pull anything missed while we were offline.
        if (engine && roots) for (const s of roots.spaces()) void engine.syncSpace(s);
      } else if (ev.type === 'disconnected') {
        hubStatus = 'disconnected';
        broadcast({ type: 'hub-status', spaceId: 'hub', status: 'disconnected' });
      }
    },
  });
  // Supersession guard: while we were awaiting addSpace, a disable (or newer
  // start) may have replaced our engine — the app-boot start isn't chained
  // through `transition`, so it can race a disable. If so, the socket we just
  // built would outlive its engine; tear it down instead of connecting.
  if (engine !== e) { sock.destroy(); hubStatus = 'off'; return; }
  hubSocket = sock;
  hubSocket.setDesired(true);
}

// Tear the SyncHub socket down. setDesired(false) stops its reconnect loop
// BEFORE destroy() closes the current socket, so no retry fires after teardown.
// Matches where `engine` is nulled — the hub belongs to the engine's lifetime.
function teardownHub(): void {
  hubSocket?.setDesired(false);
  hubSocket?.destroy();
  hubSocket = null;
  hubStatus = 'off';
}

export async function stopSyncSpaces(): Promise<void> {
  if (backupTimer) clearInterval(backupTimer);
  teardownHub();
  await engine?.stop();
  engine = null;
}

// ---- IPC-facing functions (also used by remote-server cases) ----
export async function syncSpacesStatus() {
  return {
    enabled: manager?.isEnabled() ?? false,
    spaces: roots?.spaces().map(s => ({ ...s, remote: manager?.remoteFor(s.id) ?? null })) ?? [],
    recentEvents,
    syncHub: hubStatus, // SyncHub connection state (Plan 1b): 'off' when sync disabled
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
      teardownHub(); // stop cross-device signalling too — the engine is going away
      await current.stop();
    }
  });
  transition = run;
  await run;
  return syncSpacesStatus();
}

export async function syncSpacesSyncNow(spaceId?: string) {
  // spaceId narrows to one space (the Project View hero's "Sync now" button);
  // no arg keeps the SyncPanel's existing sync-everything behavior.
  if (engine && roots) {
    for (const s of roots.spaces()) {
      if (spaceId && s.id !== spaceId) continue;
      void engine.syncSpace(s);
    }
  }
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

/** Spec §3 import flows: move an existing folder into ~/YouCoded/Projects/ and
 *  make it a synced space. liveCwds comes from the caller (ipc-handlers /
 *  remote-server own the SessionManager) so this module stays free of a
 *  session-manager import. Unlike createProject, an imported folder HAS
 *  content — kick an immediate syncSpace instead of waiting for the poll. */
export async function syncSpacesImportProject(sourcePath: string, name: string, liveCwds: string[]) {
  if (!roots) return { ok: false as const, error: 'Sync is still starting up — try again in a moment' };
  const result = await importProjectFolder({
    sourcePath, name, liveCwds,
    projectsRoot: roots.projectsRoot,
    youcodedRoot: roots.youcodedRoot,
  });
  if (result.ok && engine) {
    const space = roots.spaces().find(s => s.id === `project:${name}`);
    if (space) {
      try {
        await engine.addSpace(space);
        const transport = new GitTransport({ deviceName: os.hostname() });
        await transport.init(space);
        await transport.setRemote(space, await manager!.ensureRemote(space));
        void engine.syncSpace(space); // imported content should reach the remote now, not at the next poll
      } catch { /* engine error events surface the failure (same contract as createProject) */ }
    }
  }
  return result;
}

export function getManagedRoots(): ManagedRoots | null { return roots; }
