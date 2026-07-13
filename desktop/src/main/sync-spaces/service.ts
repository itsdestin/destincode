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
import { readProjectRegistry, ensureProjectEntry, setProjectDisplayName, setProjectStopped } from './project-registry';
import { planReconcile, activeManagedSpaces } from './materialization-planner';
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

// Cross-device project discovery (2026-07-12). Single-flight + one coalesced
// rerun (mirrors the engine's syncSpace guard) so overlapping triggers (boot,
// hub-connected, Personal-updated) can't race two createProject calls for one name.
let discovering = false;
let discoverAgain = false;

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

// Main-process subscribers (conversations service materializes on 'synced').
// Renderer/remote consumers use the existing window/remote fan-outs; this hook
// exists because main-process modules have no webContents to receive on.
const localListeners = new Set<(e: SpaceSyncEvent) => void>();

export function onSyncSpacesEvent(fn: (e: SpaceSyncEvent) => void): () => void {
  localListeners.add(fn);
  return () => localListeners.delete(fn);
}

function broadcast(e: SpaceSyncEvent): void {
  // Stamp at emit time — the renderer derives "Last synced N min ago" from it,
  // so every stored + fanned-out copy must carry the same timestamp.
  const stamped: SpaceSyncEvent = { ...e, at: Date.now() };
  recentEvents = [...recentEvents.slice(-49), stamped];
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send('syncspaces:event', stamped); } catch { /* window closing */ }
  }
  // Fan out to remote clients too (see comment on remoteBroadcast above).
  try { remoteBroadcast?.(stamped); } catch { /* remote server not up / closing */ }
  // Fan out to main-process subscribers (each isolated — same rationale as the
  // window/remote blocks). Runs BEFORE the hub send so a bad listener can't
  // strand the cross-device signal, and its own try/catch keeps one throwing
  // listener from aborting the rest.
  for (const fn of localListeners) {
    try { fn(stamped); } catch { /* one bad listener must not strand the rest */ }
  }
  // A local push means this account's OTHER devices should pull now — signal
  // the room LAST, isolated in its own try/catch like the fan-outs above:
  // broadcast() is the single fan-out chokepoint invoked from the engine's
  // onEvent, and a hub send must never block or kill local event delivery.
  // Signalling is best-effort anyway — the 120s poll covers any miss. Guard on
  // type + pushed so hub-status / error / pull-only events never recurse into
  // a send.
  try {
    if (stamped.type === 'synced' && stamped.pushed && hubSocket) {
      const space = roots?.spaces().find(s => s.id === stamped.spaceId);
      if (space) hubSocket.sendSignal('space-updated', repoNameForSpace(space));
    }
  } catch { /* best-effort — the poll fallback covers it */ }

  // A Personal pull that APPLIED changes may have added/renamed/stopped registry
  // records — reconcile. Guarded to Personal + updated so it fires only when the
  // registry could have changed; runDiscovery is single-flight so bursts coalesce.
  try {
    if (stamped.type === 'synced' && stamped.updated && roots) {
      const personal = roots.spaces().find((s) => s.kind === 'personal');
      if (personal && stamped.spaceId === personal.id) void runDiscovery();
    }
  } catch { /* discovery is best-effort — boot/connect retries */ }
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
    try { await backup!.runIfDue(activeSpaces(), await getBackupTargets(), logFn); }
    catch (e: any) { logFn(`sync-spaces: daily backup check failed: ${String(e?.message ?? e)}`); }
  };
  backupTimer = setInterval(() => { void runBackup(); }, 60 * 60 * 1000);
  (backupTimer as any).unref?.();
  void runBackup();
}

// The spaces the engine should actually run — spaces() minus stopped projects
// (spec §7 single enforcement point). Reads the registry on disk each call;
// cheap (a small dir of tiny files).
function activeSpaces() {
  if (!roots) return [];
  return activeManagedSpaces(readProjectRegistry(roots.personalRoot), roots.spaces());
}

// Materialize one registered project this device is missing. ORDERING IS
// LOAD-BEARING (spec §7): ensureRemote FIRST (uses only the id — a gh-auth
// failure creates NOTHING); createProject makes the empty folder; addSpace makes
// it a live, poll-retriable space BEFORE the first pull (a failed pull leaves a
// recoverable empty space, not an orphan); setRemote + syncSpace's first-sync
// pull adopts origin/main (unborn local main → checkout -B main origin/main).
async function materializeProject(entry: { name: string; repoName: string }): Promise<void> {
  if (!engine || !roots || !manager) return;
  const e = engine;
  const url = await manager.ensureRemote({ id: `project:${entry.name}`, kind: 'project', root: '' });
  const created = roots.createProject(entry.name);
  if (!created.ok) return; // taken locally between plan and now — idempotent no-op
  const space = roots.spaces().find((s) => s.id === `project:${entry.name}`);
  if (!space || engine !== e) return; // disabled mid-materialize — next boot/connect adds it
  await e.addSpace(space);
  const transport = new GitTransport({ deviceName: os.hostname() });
  await transport.setRemote(space, url);
  await e.syncSpace(space);
}

// Reconcile local projects against the synced registry: materialize missing
// active projects, detach stopped ones (keeping the folder). Reads the registry
// ON DISK — callers ensure freshness (startEngine awaits a Personal pull; the
// broadcast/connected triggers fire after a Personal sync) — rather than syncing
// Personal itself (which would recurse through the broadcast trigger). Never
// throws: a per-project failure becomes an error event and retries next
// boot/connect. Single-flight with one coalesced rerun.
async function runDiscovery(): Promise<void> {
  if (!engine || !roots) return;
  if (discovering) { discoverAgain = true; return; }
  discovering = true;
  try {
    do {
      discoverAgain = false;
      if (!engine || !roots) break;
      const registry = readProjectRegistry(roots.personalRoot);
      const localNames = roots.listProjects().map((p) => p.name);
      const liveNames = engine.liveSpaceIds()
        .filter((id) => id.startsWith('project:')).map((id) => id.slice('project:'.length));
      const plan = planReconcile(registry, localNames, liveNames);
      for (const name of plan.toStop) {
        if (!engine) break;
        try { await engine.removeSpace(`project:${name}`); } // keep the folder
        catch (err: any) { broadcast({ type: 'error', spaceId: `project:${name}`, message: `Could not stop syncing "${name}": ${String(err?.message ?? err)}` }); }
      }
      for (const entry of plan.toMaterialize) {
        if (!engine || !roots) break;
        try { await materializeProject(entry); }
        catch (err: any) { broadcast({ type: 'error', spaceId: `project:${entry.name}`, message: `Could not add project "${entry.name}" from another device: ${String(err?.message ?? err)}` }); }
      }
    } while (discoverAgain);
  } finally {
    discovering = false;
  }
}

async function startEngine(log: (m: string) => void): Promise<void> {
  const transport = new GitTransport({ deviceName: os.hostname() });
  // Capture this start's instance locally: if a disable (or another start)
  // supersedes us mid-loop, the module-level `engine` no longer points at `e`
  // and we must stop OUR instance ourselves — otherwise its chokidar watchers
  // leak with nothing left holding a reference to close them.
  const e = new SpaceSyncEngine(transport, { onEvent: broadcast });
  engine = e;
  for (const space of activeSpaces()) { // stopped projects never re-added (spec §7 gate)
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

  // Supersession guard: while we were awaiting addSpace above, a disable (or a
  // newer start) may have replaced our engine — the app-boot start isn't
  // chained through `transition`, so it can race a disable/enable pair. A
  // superseded run owns NO global state: it must not create a socket and must
  // not touch hubStatus — the newer run's live socket may already have set it
  // to 'connected', and stamping 'connecting'/'off' here would make
  // syncSpacesStatus() lie until the next disconnect/reconnect. (Our engine
  // was already stopped by whichever transition superseded us.) Everything
  // below the check is synchronous, so it can't be re-raced.
  if (engine !== e) return;

  // Cross-device discovery: await a fresh Personal pull so the registry is
  // current, register this device's own projects, then reconcile.
  const personalSpace = roots!.spaces().find((s) => s.kind === 'personal');
  if (personalSpace) { try { await e.syncSpace(personalSpace); } catch { /* offline — poll/connect retries */ } }
  if (engine !== e) return; // disabled while we synced Personal — bail
  backfillRegistry();
  void runDiscovery();

  // SyncHub (Plan 1b): instant "something changed" signals between this
  // account's devices. The 120s poll in the engine stays as the fallback —
  // SyncHub being down never blocks sync, it only makes it less instant (spec §6).
  hubStatus = 'connecting';
  const spaceForKey = (key: string) =>
    roots!.spaces().find((s) => repoNameForSpace(s) === key) ?? null;
  hubSocket = createSyncHubSocket({
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
        if (engine && roots) for (const s of activeSpaces()) void engine.syncSpace(s);
        void runDiscovery(); // retry any project a prior materialize missed; apply stop tombstones
      } else if (ev.type === 'disconnected') {
        hubStatus = 'disconnected';
        broadcast({ type: 'hub-status', spaceId: 'hub', status: 'disconnected' });
      }
    },
  });
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

// Register a project so peers can discover it. repoName is derived purely from
// the id, so ensureProjectEntry writes the same file on every device (§8).
function registerProject(name: string, root: string): void {
  if (!roots) return;
  ensureProjectEntry(roots.personalRoot, {
    name,
    repoName: repoNameForSpace({ id: `project:${name}`, kind: 'project', root }),
  });
}

// One-time on enable: register every project already on this device so
// pre-existing / sync-was-off projects enter the registry. Idempotent
// (ensureProjectEntry is create-if-absent — no churn, no clobber).
function backfillRegistry(): void {
  if (!roots) return;
  for (const p of roots.listProjects()) registerProject(p.name, p.path);
}

export async function syncSpacesCreateProject(name: string) {
  const result = roots!.createProject(name);
  if (result.ok) registerProject(name, result.path);
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
  if (result.ok) registerProject(name, result.path);
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
