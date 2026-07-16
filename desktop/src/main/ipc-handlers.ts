import { app, IpcMain, BrowserWindow, dialog, clipboard, nativeImage, shell, powerSaveBlocker, webContents } from 'electron';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import https from 'https';
import { execFile } from 'child_process';
import { SessionManager } from './session-manager';
import { HookRelay } from './hook-relay';
import { IPC, PERMISSION_OVERRIDES_DEFAULT, SESSION_FLAG_NAMES, type SessionFlagName, type TranscriptEvent, type HookEvent, type PastSession } from '../shared/types';
import { setPermissionOverrides } from './main';
import { LocalSkillProvider } from './skill-provider';
import { CommandProvider } from './command-provider';
import { IntegrationInstaller, listWithState } from './integration-installer';
import { RemoteConfig } from './remote-config';
import { RemoteServer } from './remote-server';
import { TranscriptWatcher, cwdToProjectSlug } from './transcript-watcher';
// Native runtime (platform roadmap Phase 1 Plan A) — the first-party harness
// stack: provider CRUD + key management, model catalog, and the live-session
// registry that owns HarnessSessions and their persistence.
import { NativeHome } from './native-home';
import { SecretsStore } from './providers/secrets-store';
import { ProviderRegistry } from './providers/provider-registry';
import { ModelCatalog } from './providers/model-catalog';
import { EngineManager } from './engine/engine-manager';
import type { EngineModel as EngineModelType } from '../shared/engine-types';
import { ModelManager } from './models/model-manager';
import { detectEndpoints } from './models/endpoint-detectors';
import { ENGINE_PORT } from '../shared/ports';
import { SessionStore } from './harness/session-store';
import { NativeSessionHost } from './harness/native-session-host';
import { resolveMappingAction } from './session-id-mapping';
import { listPastSessions, loadHistory } from './session-browser';
import { readTranscriptMeta } from './transcript-utils';
import { startThemeWatcher, listUserThemes, userThemeDir, userThemeManifest, THEMES_DIR } from './theme-watcher';
import { isBundledPlugin } from '../shared/bundled-plugins';
import { ThemeMarketplaceProvider } from './theme-marketplace-provider';
import { generateThemePreview } from './theme-preview-generator';
import { getSyncStatus, getSyncConfig, setSyncConfig, forceSync, getSyncLog, dismissWarning, addBackend, removeBackend, updateBackend, pushBackend, type SyncWarning } from './sync-state';
// Cross-device sync spaces (spec 2026-07-03) — the folder-based sync engine.
import {
  syncSpacesStatus, syncSpacesEnable, syncSpacesSyncNow, syncSpacesCreateProject, syncSpacesImportProject,
  syncSpacesRenameProject, syncSpacesStopProject, getManagedRoots, isSyncSpacesEnabled,
} from './sync-spaces/service';
import { readDevices, renameDevice } from './sync-spaces/device-registry';
// Connect-GitHub modal (device-flow auth) — detectGh/installGh are step fns;
// createGithubConnect is the stateful orchestrator that owns the in-flight flow.
import { detectGh, installGh } from './github-auth';
import { createGithubConnect, setGithubConnect } from './github-connect';
import { getConfig as getMarketplaceConfig, setConfig as setMarketplaceConfig } from './marketplace-config-store';
import { readComponent, type ComponentKind } from './marketplace-file-reader';
import { checkSyncPrereqs, installRclone, checkGdriveRemote, authGdrive, authGithub, createGithubRepo } from './sync-setup-handlers';
import { log } from './logger';
import { readLogTail, gatherDiagnostics, summarizeIssue, submitIssue, installWorkspace, openDevSessionIn } from './dev-tools';
import { createUpdateInstaller, findCachedDownload, makeLaunchInstaller, UpdateInstallError } from './update-installer';
import type { UpdateProgressEvent } from '../shared/update-install-types';
import { getChangelog } from './changelog-service';
// Analytics opt-out — Phase 6. The two exported functions read/write
// ~/.claude/youcoded-analytics.json; runAnalyticsOnLaunch (wired in main.ts)
// short-circuits when optIn is false.
import { getOptIn as getAnalyticsOptIn, setOptIn as setAnalyticsOptIn } from './analytics-service';
// Saved-folder store — extracted so sync-spaces/ can share the reader/writer.
import { SavedFolder, readFolders, writeFolders } from './saved-folders';
import { loadConfigSync, writeConfig, getAppliedAtLaunch, getCachedGpu } from './performance-config';
import type { PerformanceConfigSnapshot } from '../shared/types';
import { ARTIFACT_IPC } from './artifacts/ipc-channels';
import { appendVersion, readSidecar, writeSidecar, renameArtifact, removeArtifactRecord } from './artifacts/artifact-store';
import { listProjects, removeProject } from './artifacts/central-index';
import { buildSavedFolderProjects } from './artifacts/saved-folder-projects';
import { discoverProjectFiles, invalidateDiscoveryCache } from './artifacts/project-file-discovery';
import { ensureProject, applyGitTreatment } from './artifacts/project-manager';
import { canonicalize } from '../shared/artifacts/canonicalize';
import { evaluateBinaryRead } from './artifacts/read-binary-access';
import { trackedArtifacts } from './artifacts/visible-artifacts';
import { PROJECT_IPC } from './project/ipc-channels';
import { listProjectConversations, projectConversationHistory, ccProjectSlug } from './project-conversations';
// Conversation Store (Phase 2a): live intake of transcript activity, session
// cwd, title and flag changes. Keyed by CLAUDE session id (resolved from the
// desktop id via sessionIdMap below), matching the store's record id.
import { noteTranscriptEvent, noteSessionStarted, noteSessionEnded, noteTitleChanged, noteFlagChanged, noteSessionNote, getConversationStore, flushSessionToSpace } from './conversations/service';
// Plan 2b Task 8: holder-side takeover — when another device requests a session
// this device holds, cleanly interrupt/flush/release/move/destroy it.
import { createHolderTakeover } from './conversations/takeover';
import { getTagRegistry } from './conversations/tag-registry-service';
import { tagFlagKey, isTagColor, TagColor } from '../shared/tags';
import { getRepoInfo } from './project-repo';
import { listContext, readContextFile, writeContextFile } from './project-context';

// Max age for clipboard paste images (1 hour)
const CLIPBOARD_MAX_AGE_MS = 60 * 60 * 1000;

// Root of ~/.claude — used by artifact handlers to locate the central index.
const CLAUDE_DIR = path.join(os.homedir(), '.claude');


export function registerIpcHandlers(
  ipcMain: IpcMain,
  sessionManager: SessionManager,
  mainWindow: BrowserWindow,
  skillProvider: LocalSkillProvider,
  commandProvider: CommandProvider,
  hookRelay?: HookRelay,
  remoteConfig?: RemoteConfig,
  remoteServer?: RemoteServer,
  // Multi-window ownership: when a session is created via IPC, assign it to
  // the calling renderer's window so subsequent per-session events route there.
  windowRegistry?: import('./window-registry').WindowRegistry,
  // Plan 2b Task 8 (optional): the lease client + a setter main.ts uses to
  // receive the holder-side takeover handler (which needs the local sessionIdMap,
  // built inside this function). Absent → lease lifecycle wiring is skipped
  // entirely (nothing breaks — acquire/release/takeover simply don't run).
  leaseWiring?: {
    client: import('./conversations/lease-client').LeaseClient;
    setHolderTakeover: (fn: (sessionId: string, from?: { deviceId: string; device: string }) => void) => void;
    // Plan 2b Task 9: the requester-side takeover flow, built in main.ts (where
    // deviceId + hubLeaseRequest + materializeOne + syncSpacesSyncNow are all
    // reachable). The three lease IPC handlers below are thin passthroughs to it.
    requester: import('./conversations/takeover').RequesterTakeoverType;
    // Plan 2b Task 11: this machine's device id, so the list-devices handler can
    // mark the current device with self:true.
    deviceId: string;
  },
) {
  // Broadcast a non-session-scoped event to every renderer. Status data, UI
  // actions, and similar globals must reach every window — not just window 1.
  // Session-scoped events should use sendForSession instead.
  const send = (channel: string, ...args: any[]) => {
    if (windowRegistry) {
      for (const wid of windowRegistry.getWindowIds()) {
        const wc = webContents.fromId(wid);
        if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
      }
      return;
    }
    if (!mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args);
    }
  };

  // Route a session-scoped emit to the owner AND any buddy subscribers.
  // Ownership and subscription are independent (a buddy window observes a
  // session without claiming ownership), so events must reach both. Falls
  // back to the primary mainWindow when neither owner nor subscribers
  // exist (preserves the existing pre-buddy fallback behavior for
  // remote-created sessions during Phase 1).
  const sendForSession = (sessionId: string, channel: string, ...args: any[]) => {
    const ids = new Set<number>();
    const ownerId = windowRegistry?.getOwner(sessionId);
    if (ownerId != null) ids.add(ownerId);
    if (windowRegistry) {
      for (const subId of windowRegistry.getSubscribers(sessionId)) ids.add(subId);
    }
    if (ids.size > 0) {
      for (const wid of ids) {
        // wid is a webContents.id, NOT a BrowserWindow.id — different ID
        // spaces. BrowserWindow.fromId silently returns null for a
        // webContents.id, so previously every peer-window event fell through
        // to the mainWindow fallback (window 1). webContents.fromId does the
        // correct lookup.
        const wc = webContents.fromId(wid);
        if (wc && !wc.isDestroyed()) wc.send(channel, ...args);
      }
      return;
    }
    // Fallback: no known owner and no subscribers (e.g., remote-created
    // session pre-assignment). Send to mainWindow so these orphaned events
    // still reach a renderer. Note: if `ids` was non-empty but every target
    // webContents was destroyed, the event is silently dropped — the fallback
    // is only taken when no recipients were identified at all.
    if (!mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args);
  };

  // Registry-wide push (not session-scoped): notify every window. Mirrors the
  // getAllWindows loop already used for 'appearance:sync' / 'update:progress'.
  const broadcastToAllWindows = (channel: string, payload: any) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  };

  // --- Theme file watcher ---
  const stopThemeWatcher = startThemeWatcher(mainWindow);

  ipcMain.handle(IPC.THEME_LIST, async () => {
    return listUserThemes();
  });

  // Security: strict slug format to prevent path traversal before path.resolve.
  // Allow leading underscore for reserved internal slugs (e.g. _preview used by theme-builder).
  const SAFE_SLUG_RE = /^[a-z0-9_]+(?:-[a-z0-9_]+)*$/;

  ipcMain.handle(IPC.THEME_READ_FILE, async (_event, slug: string) => {
    if (!SAFE_SLUG_RE.test(slug)) throw new Error('Invalid theme slug');
    const manifestPath = path.resolve(userThemeManifest(slug));
    if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    return fs.promises.readFile(manifestPath, 'utf-8');
  });

  ipcMain.handle(IPC.THEME_WRITE_FILE, async (_event, slug: string, content: string) => {
    if (!SAFE_SLUG_RE.test(slug)) throw new Error('Invalid theme slug');
    const themeDir = path.resolve(userThemeDir(slug));
    if (!themeDir.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
    await fs.promises.mkdir(path.join(themeDir, 'assets'), { recursive: true });
    await fs.promises.writeFile(path.join(themeDir, 'manifest.json'), content, 'utf-8');
  });

  // Window controls — used by custom caption buttons on Windows/Linux.
  // Operate on the SENDING window (BrowserWindow.fromWebContents), not the
  // primary mainWindow — otherwise window 2's caption buttons all act on
  // window 1.
  ipcMain.handle(IPC.WINDOW_MINIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.minimize();
  });
  ipcMain.handle(IPC.WINDOW_MAXIMIZE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });
  ipcMain.handle(IPC.WINDOW_CLOSE, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) win.close();
  });
  // macOS traffic-light repositioning. Non-Mac platforms don't have native
  // traffic lights, so this is a no-op there. Called from theme-engine when
  // chrome-style changes — floating chrome's rounded header would otherwise
  // leave the OS-default (8,12) lights stranded over empty space.
  ipcMain.handle(IPC.WINDOW_SET_TRAFFIC_LIGHT_POS, (event, pos: { x: number; y: number } | null) => {
    if (process.platform !== 'darwin') return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) return;
    // Electron 28+: setWindowButtonPosition(null) resets to the platform default.
    // Older fallback: passing undefined also resets. We type-narrow before calling.
    const anyWin = win as unknown as { setWindowButtonPosition: (p: Electron.Point | null) => void };
    anyWin.setWindowButtonPosition(pos ?? null);
  });

  // Theme-driven window + dock icon hot-swap. Called from theme-context whenever
  // the active theme changes. Two URL forms are accepted:
  //   1. theme-asset://<slug>/<relative-path>  — a file in a community/user theme's
  //      asset dir (server resolves the path and confines reads to that dir, so
  //      renderer cannot read arbitrary files).
  //   2. data:image/png;base64,<...>            — an in-memory PNG synthesized by
  //      the renderer (theme-default-icon.ts), used for every theme that doesn't
  //      declare its own appIcon. Capped at MAX_DATA_ICON_BYTES to prevent a
  //      compromised renderer from flooding main with huge buffers.
  // Anything else (or null, or failure) resets to the bundled default icon.
  const DEFAULT_ICON_PATH = path.join(__dirname, '../../assets/icon.png');
  const THEMES_DIR_FOR_ICON = path.join(os.homedir(), '.claude', 'wecoded-themes');
  const MAX_DATA_ICON_BYTES = 1024 * 1024; // 1 MB — a 256px PNG is typically <100KB
  ipcMain.handle(IPC.WINDOW_SET_ICON, (_e, url: string | null) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    let iconImg = nativeImage.createFromPath(DEFAULT_ICON_PATH);
    if (url && typeof url === 'string') {
      try {
        if (url.startsWith('theme-asset://')) {
          const parsed = new URL(url);
          const slug = parsed.hostname;
          if (SAFE_SLUG_RE.test(slug)) {
            const rel = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
            const themeDir = path.join(THEMES_DIR_FOR_ICON, slug);
            const resolved = path.resolve(themeDir, rel);
            if (resolved.startsWith(themeDir + path.sep)) {
              const img = nativeImage.createFromPath(resolved);
              if (!img.isEmpty()) iconImg = img;
            }
          }
        } else if (url.startsWith('data:image/png;base64,') && url.length <= MAX_DATA_ICON_BYTES) {
          const img = nativeImage.createFromDataURL(url);
          if (!img.isEmpty()) iconImg = img;
        }
      } catch { /* fall through to default */ }
    }
    mainWindow.setIcon(iconImg);
    if (process.platform === 'darwin' && app.dock) app.dock.setIcon(iconImg);
  });

  // Zoom controls — each returns the new zoom percentage for the overlay UI
  const ZOOM_STEP = 0.5; // ~12% per step (Electron uses logarithmic scale)
  const ZOOM_MIN = -3;   // ~50%
  const ZOOM_MAX = 5;    // ~300%

  function zoomLevelToPercent(level: number): number {
    return Math.round(Math.pow(1.2, level) * 100);
  }

  ipcMain.handle(IPC.ZOOM_IN, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    const current = mainWindow.webContents.getZoomLevel();
    const next = Math.min(current + ZOOM_STEP, ZOOM_MAX);
    mainWindow.webContents.setZoomLevel(next);
    return zoomLevelToPercent(next);
  });

  ipcMain.handle(IPC.ZOOM_OUT, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    const current = mainWindow.webContents.getZoomLevel();
    const next = Math.max(current - ZOOM_STEP, ZOOM_MIN);
    mainWindow.webContents.setZoomLevel(next);
    return zoomLevelToPercent(next);
  });

  ipcMain.handle(IPC.ZOOM_RESET, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    mainWindow.webContents.setZoomLevel(0);
    return 100;
  });

  ipcMain.handle(IPC.ZOOM_GET, () => {
    if (!mainWindow || mainWindow.isDestroyed()) return 100;
    return zoomLevelToPercent(mainWindow.webContents.getZoomLevel());
  });

  // --- Performance / GPU pref ---
  // The Settings → Performance section reads/writes ~/.claude/youcoded-performance.json
  // through these handlers. The Chromium force-{high,low}-power-gpu switch is
  // applied at module load in main.ts (cannot be changed at runtime), so set-config
  // only persists the value — the renderer is responsible for prompting a restart.
  ipcMain.handle(IPC.PERFORMANCE_GET_CONFIG, (): PerformanceConfigSnapshot => {
    const cfg = loadConfigSync();
    const gpu = getCachedGpu();
    return {
      preferPowerSaving: cfg.preferPowerSaving,
      appliedAtLaunch: getAppliedAtLaunch(),
      multiGpuDetected: gpu.multiGpuDetected,
      gpuList: gpu.gpuList,
    };
  });

  ipcMain.handle(IPC.PERFORMANCE_SET_CONFIG, (_event, payload: { preferPowerSaving: boolean }) => {
    // Validate the payload — IPC inputs are untrusted (a remote browser
    // client could send anything). We coerce to a strict boolean.
    const next = payload?.preferPowerSaving === true;
    writeConfig({ preferPowerSaving: next });
    return { ok: true as const };
  });

  ipcMain.handle(IPC.APP_RESTART, () => {
    // Generic restart channel — reused by any future setting that needs a
    // restart to apply. relaunch() schedules the restart for after exit().
    app.relaunch();
    app.exit(0);
  });

  // --- Theme marketplace ---
  // Phase 3a: pass the shared config store so theme installs also record into
  // the unified youcoded-skills.json packages map used for update tracking.
  const themeMarketplace = new ThemeMarketplaceProvider(skillProvider.configStore);
  // Phase 4: installer is now plugin-backed. Wire in a plugin lookup so the
  // installer can resolve an integration's setup.pluginId to the marketplace
  // entry that installPlugin() needs.
  const integrationInstaller = new IntegrationInstaller({
    getPluginEntryById: async (id: string) => {
      try {
        const entries = await skillProvider.listMarketplace();
        return entries.find((e) => e.id === id) ?? null;
      } catch {
        return null;
      }
    },
  });
  // Drop any stale cached integrations index so the new schema fields
  // (iconUrl, platforms, plugin setup) are picked up on first read.
  integrationInstaller.invalidateCatalogCache();

  ipcMain.handle(IPC.THEME_MARKETPLACE_LIST, async (_event, filters) => {
    return themeMarketplace.listThemes(filters);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_DETAIL, async (_event, slug: string) => {
    return themeMarketplace.getThemeDetail(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_INSTALL, async (_event, slug: string) => {
    return themeMarketplace.installTheme(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_UNINSTALL, async (_event, slug: string) => {
    return themeMarketplace.uninstallTheme(slug);
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_PUBLISH, async (_event, slug: string) => {
    return themeMarketplace.publishTheme(slug);
  });

  // Publish-lifecycle: resolve button state (draft / in-review / published-current /
  // published-drift / unknown) for a user-authored theme on each detail open.
  ipcMain.handle(IPC.THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE, async (_event, slug: string) => {
    return themeMarketplace.resolvePublishStateForSlug(slug);
  });

  // Manual refresh: drop in-memory registry cache + return a fresh listing in one round-trip.
  ipcMain.handle(IPC.THEME_MARKETPLACE_REFRESH_REGISTRY, async () => {
    themeMarketplace.invalidateRegistryCache();
    return themeMarketplace.listThemes();
  });

  ipcMain.handle(IPC.THEME_MARKETPLACE_GENERATE_PREVIEW, async (_event, slug: string) => {
    try {
      const manifestPath = path.resolve(userThemeManifest(slug));
      if (!manifestPath.startsWith(THEMES_DIR + path.sep)) throw new Error('Invalid theme slug');
      const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
      const previewPath = await generateThemePreview(userThemeDir(slug), manifest);
      // Verify the file really landed on disk — if the generator returned a
      // path but writeFile silently failed, the share sheet would render a
      // broken-image icon. Better to return null and fall back to the swatch.
      const stat = await fs.promises.stat(previewPath).catch(() => null);
      if (!stat || stat.size < 150) {
        console.warn(`[IPC] Preview file missing/tiny after generation: slug=${slug} path=${previewPath} size=${stat?.size ?? 'missing'}`);
        return null;
      }
      return previewPath;
    } catch (err: any) {
      console.warn(`[IPC] Failed to generate theme preview: slug=${slug} err=${err?.message ?? err}`);
      return null;
    }
  });

  // Forward session-created to the owning window. Deferred via nextTick so
  // the SESSION_CREATE IPC handler can run assignSession first — otherwise
  // sendForSession fires before ownership is set and falls back to mainWindow,
  // making a session created in window 2 appear in window 1. Remote-created
  // sessions still fall back to mainWindow since no renderer owns them yet.
  sessionManager.on('session-created', (info) => {
    process.nextTick(() => sendForSession(info.id, IPC.SESSION_CREATED, info));
  });

  // window.claude.terminal.getScreenText — reads the visible xterm buffer
  // for the given session. The actual read happens in the renderer (xterm
  // lives there), so main calls back via executeJavaScript. ~1s cadence
  // under the classifier; round-trip overhead is negligible.
  ipcMain.handle('terminal:get-screen-text', async (event, sessionId: string) => {
    try {
      // Tail read (120 buffer rows): the attention classifier keeps only the
      // last 40 logical lines, so serializing the full 1000+-row scrollback
      // every second was pure waste. 120 rows leaves ample wrap headroom.
      return await event.sender.executeJavaScript(
        `window.__terminalRegistry?.getScreenText(${JSON.stringify(sessionId)}, 120) ?? ''`
      );
    } catch {
      return '';
    }
  });

  // Session CRUD
  ipcMain.handle(IPC.SESSION_CREATE, async (event, opts) => {
    const info = sessionManager.createSession(opts);
    // Native sessions have no PTY worker — start (or resume) their HarnessSession
    // in the host now that createSession has minted the SessionInfo. The native
    // branch of createSession uses resumeSessionId AS the id, so info.id already
    // equals the resumed id and the host rebuilds the matching session.
    if (info.provider === 'native') {
      try {
        if (opts.resumeSessionId) {
          const resumed = await nativeHost.resume(opts.resumeSessionId, info.cwd);
          // No stored file (e.g. resuming an id that was never persisted) → start
          // a fresh session under the same id so the renderer isn't left with a
          // SessionInfo backed by no live HarnessSession.
          if (!resumed && opts.binding) {
            await nativeHost.create({ sessionId: info.id, cwd: info.cwd, binding: opts.binding });
          } else if (!resumed && !opts.binding) {
            // Resume asked for a session whose saved data is gone, and we have no
            // binding to start a fresh one under this id — the renderer already
            // holds a live SessionInfo with an empty chat and no way to know why.
            // Surface a session-error transcript event on the SAME pipe the host
            // uses (drives NATIVE_SESSION_ERROR → the error banner). Deferred via
            // nextTick so it lands AFTER SESSION_CREATED + assignSession, matching
            // the ordering guarantee the session-created forward relies on.
            const errEvent: TranscriptEvent = {
              type: 'session-error',
              sessionId: info.id,
              uuid: randomUUID(),
              timestamp: Date.now(),
              data: { text: 'This conversation could not be resumed — its saved data is missing.' },
            };
            process.nextTick(() => {
              sendForSession(info.id, IPC.TRANSCRIPT_EVENT, errEvent);
              remoteServer?.broadcast({ type: 'transcript:event', payload: errEvent });
            });
          }
        } else {
          await nativeHost.create({ sessionId: info.id, cwd: info.cwd, binding: opts.binding });
        }
      } catch (e) {
        log('ERROR', 'IPC', 'native session start failed', { sessionId: info.id, error: String(e) });
      }
      // Eager-load the bound model the moment the session opens (like LM Studio),
      // so the loading bar + GB progress appear immediately rather than only after
      // the first message. Fire-and-forget; the model poll drives the UI.
      const eagerModelId = nativeHost.modelForSession(info.id);
      if (eagerModelId) { void engineManager.loadModel(eagerModelId).catch(() => { /* engine not installed / boot failed — the first send surfaces it */ }); }
    }
    // Assign the new session to the calling window so per-session events (transcript,
    // pty output, permission prompts) route here once Task 1.4 migrates the emits.
    //
    // Exception: if the sender is a buddy window (the floater's compact chat),
    // assign to the leader main window instead. Buddies don't appear in the
    // switcher directory and shouldn't own sessions — otherwise the session
    // would be invisible to every main window's session list. The buddy still
    // sees the session via its subscribe() call in SessionPill.selectSession.
    if (windowRegistry) {
      let targetId = event.sender.id;
      if (windowRegistry.getKind(event.sender.id) === 'buddy') {
        const leader = windowRegistry.getLeaderId();
        if (leader != null) targetId = leader;
      }
      try { windowRegistry.assignSession(info.id, targetId); }
      catch (e) { log('WARN', 'IPC', 'assignSession failed', { error: String(e) }); }
    }
    return info;
  });

  // Pull-style directory snapshot — renderers call this on mount to avoid
  // racing the WINDOW_DIRECTORY_UPDATED push that fires before React subscribes.
  if (windowRegistry) {
    ipcMain.handle(IPC.WINDOW_GET_DIRECTORY, async () => {
      return windowRegistry.getDirectory((id) => sessionManager.getSession(id));
    });
  }

  ipcMain.handle(IPC.SESSION_DESTROY, async (_event, sessionId: string) => {
    // Idempotent + no-op for non-native ids: flushes/tears down the native
    // HarnessSession if this id is live, otherwise returns immediately.
    await nativeHost.destroy(sessionId);
    const result = sessionManager.destroySession(sessionId);
    if (result) {
      // Explicit user-initiated destroy → treat as clean exit (0). The
      // reducer no-ops clean exits unless a turn was in flight.
      sendForSession(sessionId, IPC.SESSION_DESTROYED, sessionId, 0);
      windowRegistry?.releaseSession(sessionId);
    }
    return result;
  });

  // Multi-window aware: when a windowRegistry is wired up, scope the list to
  // sessions owned by the calling renderer's window — otherwise a freshly-
  // spawned peer window picks up every session on mount and its ownership-
  // acquired dedup leaves strangers stuck in the local list. Sessions with no
  // owner yet (e.g., remote-created) fall back to the primary window's list
  // so remote clients still see everything. RemoteServer uses its own path
  // and doesn't go through this handler.
  ipcMain.handle(IPC.SESSION_LIST, async (event) => {
    const all = sessionManager.listSessions();
    if (!windowRegistry) return all;
    const callerId = event.sender.id;
    const primaryId = windowRegistry.getLeaderId();
    return all.filter((s) => {
      const owner = windowRegistry.getOwner(s.id);
      if (owner == null) return callerId === primaryId; // unowned → primary only
      return owner === callerId;
    });
  });

  ipcMain.handle(IPC.SESSION_SWITCH, async (_event, sessionId: string) => {
    // Switch is a client-side concern on desktop — the renderer manages active session.
    // This handler exists for protocol parity with Android/remote.
    return { ok: true };
  });

  // File picker dialog
  ipcMain.handle(IPC.DIALOG_OPEN_FILE, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters: [
        // All Files first so the picker opens in unrestricted mode by default
        { name: 'All Files', extensions: ['*'] },
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  // Sound file picker dialog — for custom notification sounds
  ipcMain.handle(IPC.DIALOG_OPEN_SOUND, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        // AIFF/AIF/AIFC covers Apple system sounds in /System/Library/Sounds/.
        // Chromium can't decode AIFF natively; sounds.ts has a JS AIFF parser for it.
        { name: 'Audio Files', extensions: ['mp3', 'wav', 'ogg', 'opus', 'aac', 'm4a', 'flac', 'webm', 'aiff', 'aif', 'aifc'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // Folder picker dialog
  ipcMain.handle(IPC.DIALOG_OPEN_FOLDER, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Save clipboard image to temp file (async I/O, cleanup on timer)
  const clipboardTmpDir = path.join(os.tmpdir(), 'claude-desktop-attachments');
  let clipboardCleanupScheduled = false;

  async function cleanupClipboardTemp(): Promise<void> {
    try {
      const files = await fs.promises.readdir(clipboardTmpDir);
      const now = Date.now();
      for (const file of files) {
        if (!file.startsWith('paste-')) continue;
        try {
          const stat = await fs.promises.stat(path.join(clipboardTmpDir, file));
          if (now - stat.mtimeMs > CLIPBOARD_MAX_AGE_MS) {
            await fs.promises.unlink(path.join(clipboardTmpDir, file));
          }
        } catch {}
      }
    } catch {}
  }

  ipcMain.handle(IPC.CLIPBOARD_SAVE_IMAGE, async () => {
    const img = clipboard.readImage();
    if (img.isEmpty()) return null;
    await fs.promises.mkdir(clipboardTmpDir, { recursive: true });

    if (!clipboardCleanupScheduled) {
      clipboardCleanupScheduled = true;
      setInterval(cleanupClipboardTemp, 3600_000);
    }

    const filePath = path.join(clipboardTmpDir, `paste-${Date.now()}.png`);
    await fs.promises.writeFile(filePath, img.toPNG());
    return filePath;
  });

  // Open the YouCoded CHANGELOG on GitHub in the default browser
  ipcMain.handle(IPC.OPEN_CHANGELOG, async () => {
    await shell.openExternal('https://github.com/itsdestin/youcoded/blob/master/CHANGELOG.md');
  });

  // Update panel fetches CHANGELOG.md via this handler. Cached in main;
  // forceRefresh is true only when the popup opens in the update-available path.
  ipcMain.handle(IPC.UPDATE_CHANGELOG, async (_event, opts: { forceRefresh?: boolean } = { forceRefresh: false }) => {
    return getChangelog({ forceRefresh: !!opts.forceRefresh });
  });

  // Open any URL in the default browser (allowlisted to https only)
  ipcMain.handle(IPC.OPEN_EXTERNAL, async (_event, url: string) => {
    if (typeof url === 'string' && url.startsWith('https://')) {
      await shell.openExternal(url);
    }
  });

  // Reveal a local file in the OS file manager. Used by the artifact panel's
  // "Reveal in folder" action. No-op for empty / non-string paths.
  ipcMain.handle(IPC.SHOW_ITEM_IN_FOLDER, async (_event, filePath: string) => {
    if (typeof filePath === 'string' && filePath.length > 0) {
      shell.showItemInFolder(filePath);
    }
  });

  // Open a local file with the OS default app (HTML→browser, .docx→Word, etc.).
  // shell.openPath resolves with '' on success or an error string on failure.
  ipcMain.handle(IPC.OPEN_PATH, async (_event, filePath: string) => {
    if (typeof filePath !== 'string' || filePath.length === 0) return 'no path';
    return shell.openPath(filePath);
  });

  // Read model + context from a transcript JSONL file (async, first/last byte-range reads)
  ipcMain.handle(IPC.READ_TRANSCRIPT_META, async (_event, transcriptPath: string) => {
    try {
      const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
      const resolved = path.resolve(transcriptPath);
      if (!resolved.startsWith(claudeProjects)) return null;
      return await readTranscriptMeta(transcriptPath);
    } catch {
      return null;
    }
  });

  // --- Model preference persistence ---
  ipcMain.handle('model:get-preference', async () => {
    try {
      const raw = fs.readFileSync(modelPrefPath, 'utf-8');
      const parsed = JSON.parse(raw);
      return parsed.model || 'sonnet';
    } catch {
      return 'sonnet';
    }
  });

  ipcMain.handle('model:set-preference', async (_event, model: string) => {
    try {
      fs.mkdirSync(path.dirname(modelPrefPath), { recursive: true });
      fs.writeFileSync(modelPrefPath, JSON.stringify({ model }));
      return true;
    } catch {
      return false;
    }
  });

  // --- Model modes (fast + effort) persistence ---
  // ~/.claude/youcoded-model-modes.json holds `{ fast, effort }`. These aren't
  // verified from transcripts (Claude Code doesn't include them there) — we
  // trust our local state and rely on the user's ModelPickerPopup as the source of truth.
  const modelModesPath = path.join(os.homedir(), '.claude', 'youcoded-model-modes.json');

  ipcMain.handle('modes:get', async () => {
    try {
      return JSON.parse(fs.readFileSync(modelModesPath, 'utf-8'));
    } catch {
      return { fast: false, effort: 'auto' };
    }
  });

  ipcMain.handle('modes:set', async (_event, modes: { fast?: boolean; effort?: string }) => {
    try {
      let current = { fast: false, effort: 'auto' };
      try { current = { ...current, ...JSON.parse(fs.readFileSync(modelModesPath, 'utf-8')) }; } catch {}
      const merged = { ...current, ...modes };
      fs.mkdirSync(path.dirname(modelModesPath), { recursive: true });
      fs.writeFileSync(modelModesPath, JSON.stringify(merged));
      return merged;
    } catch {
      return null;
    }
  });

  // --- Claude Code settings.json bridge (for Preferences panel) ---
  // Generic get/set keyed by field name so we don't need a handler per setting.
  // Reads/writes ~/.claude/settings.json which Claude Code itself also reads.
  // Field names follow Claude Code's own schema (e.g., 'editorMode', 'defaultMode').
  const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');

  ipcMain.handle('settings:get', async (_event, field: string) => {
    try {
      const raw = fs.readFileSync(claudeSettingsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Dot-path support for nested fields like 'permissions.defaultMode'
      return field.split('.').reduce((obj: any, k) => (obj == null ? undefined : obj[k]), parsed);
    } catch {
      return undefined;
    }
  });

  ipcMain.handle('settings:set', async (_event, field: string, value: unknown) => {
    try {
      let existing: Record<string, any> = {};
      try {
        existing = JSON.parse(fs.readFileSync(claudeSettingsPath, 'utf-8'));
      } catch {}
      // Dot-path support — write nested fields without clobbering siblings
      const keys = field.split('.');
      let cursor = existing;
      for (let i = 0; i < keys.length - 1; i++) {
        const k = keys[i];
        if (cursor[k] == null || typeof cursor[k] !== 'object') cursor[k] = {};
        cursor = cursor[k];
      }
      if (value === null || value === undefined) {
        delete cursor[keys[keys.length - 1]];
      } else {
        cursor[keys[keys.length - 1]] = value;
      }
      fs.mkdirSync(path.dirname(claudeSettingsPath), { recursive: true });
      fs.writeFileSync(claudeSettingsPath, JSON.stringify(existing, null, 2));
      return true;
    } catch {
      return false;
    }
  });

  // --- Appearance preference persistence ---
  ipcMain.handle('appearance:get', async () => {
    try {
      const raw = fs.readFileSync(appearancePrefPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });

  ipcMain.handle('appearance:set', async (_event, prefs: Record<string, any>) => {
    try {
      let existing: Record<string, any> = {};
      try {
        existing = JSON.parse(fs.readFileSync(appearancePrefPath, 'utf-8'));
      } catch {}
      const merged = { ...existing, ...prefs };
      fs.mkdirSync(path.dirname(appearancePrefPath), { recursive: true });
      fs.writeFileSync(appearancePrefPath, JSON.stringify(merged));
      return true;
    } catch {
      return false;
    }
  });

  // --- Transcript model verification ---
  ipcMain.handle('model:read-last', async (_event, transcriptPath: string) => {
    try {
      // Security: validate path stays within Claude projects directory (prevents arbitrary file read)
      const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
      const resolved = path.resolve(transcriptPath);
      if (!resolved.startsWith(claudeProjects + path.sep)) return null;

      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const lines = content.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === 'assistant' && entry.message?.model) {
            return entry.message.model;
          }
        } catch { continue; }
      }
      return null;
    } catch {
      return null;
    }
  });

  // --- Session defaults persistence ---
  const DEFAULTS_INITIAL = {
    skipPermissions: false,
    model: 'sonnet',
    projectFolder: '',
    permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT },
  };

  // Load permission overrides into main.ts cache on startup
  function syncPermissionOverrides(defaults: Record<string, any>) {
    const overrides = defaults.permissionOverrides;
    if (overrides && typeof overrides === 'object') {
      setPermissionOverrides(overrides);
    }
  }

  ipcMain.handle('defaults:get', async () => {
    try {
      const raw = fs.readFileSync(defaultsPrefPath, 'utf-8');
      const parsed = JSON.parse(raw);
      const result = { ...DEFAULTS_INITIAL, ...parsed,
        permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT, ...parsed.permissionOverrides },
      };
      syncPermissionOverrides(result);
      return result;
    } catch {
      return { ...DEFAULTS_INITIAL };
    }
  });

  ipcMain.handle('defaults:set', async (_event, updates: Record<string, any>) => {
    try {
      let current: Record<string, any> = { ...DEFAULTS_INITIAL };
      try {
        const parsed = JSON.parse(fs.readFileSync(defaultsPrefPath, 'utf-8'));
        current = { ...current, ...parsed,
          permissionOverrides: { ...PERMISSION_OVERRIDES_DEFAULT, ...parsed.permissionOverrides },
        };
      } catch {}
      // Deep-merge permissionOverrides instead of replacing
      const merged = { ...current, ...updates };
      if (updates.permissionOverrides) {
        merged.permissionOverrides = { ...current.permissionOverrides, ...updates.permissionOverrides };
      }
      fs.mkdirSync(path.dirname(defaultsPrefPath), { recursive: true });
      fs.writeFileSync(defaultsPrefPath, JSON.stringify(merged, null, 2));
      // Update in-memory cache so hook handler picks up changes immediately
      syncPermissionOverrides(merged);
      return merged;
    } catch {
      return null;
    }
  });

  // --- Anonymous analytics opt-out (Phase 6) ---------------------------------
  // Getters and setters for the boolean gate analytics-service reads on launch.
  // The About → Privacy section's toggle drives these; renderer handles the
  // optimistic flip with revert-on-failure, so we don't need to return a bool
  // from the setter.
  ipcMain.handle('analytics:get-opt-in', () => getAnalyticsOptIn());
  ipcMain.handle('analytics:set-opt-in', (_event, enabled: boolean) => {
    setAnalyticsOptIn(Boolean(enabled));
  });

  // --- Folder switcher persistence ---
  // Reader/writer + SavedFolder type now live in ./saved-folders (imported
  // above) so the sync-spaces import flow can rewrite an entry when a folder
  // moves. The FOLDERS_* handlers below call the no-arg forms, which default
  // to the same ~/.claude/youcoded-folders.json path.
  ipcMain.handle(IPC.FOLDERS_LIST, async () => {
    let folders = readFolders();
    // Seed with home directory on first use
    if (folders.length === 0) {
      const home = os.homedir();
      folders = [{ path: home, nickname: 'Home', addedAt: Date.now() }];
      writeFolders(folders);
    }
    // Annotate each folder with whether the path still exists on disk.
    // A saved folder that lives under ~/YouCoded/Projects/ IS a managed sync
    // project (the import flow rewrites saved entries to their new managed
    // path) — badge it like the synthesized managed rows below.
    const projectsRoot = getManagedRoots()?.projectsRoot;
    const projectsPrefix = projectsRoot ? path.resolve(projectsRoot).toLowerCase() + path.sep : null;
    const result: any[] = folders.map(f => ({
      ...f,
      exists: fs.existsSync(f.path),
      ...(projectsPrefix && path.resolve(f.path).toLowerCase().startsWith(projectsPrefix)
        ? { managed: true } : {}),
    }));
    // Managed projects (spec §3) always appear in the session-creation picker,
    // deduped against saved folders by normalized path. `managed: true` lets
    // the renderer badge them. addedAt:0 sorts them below user-added folders.
    const managed = getManagedRoots()?.listProjects() ?? [];
    const known = new Set(result.map(f => path.resolve(f.path).toLowerCase()));
    for (const p of managed) {
      if (!known.has(path.resolve(p.path).toLowerCase())) {
        result.push({ path: p.path, nickname: p.name, addedAt: 0, exists: true, managed: true });
      }
    }
    return result;
  });

  ipcMain.handle(IPC.FOLDERS_ADD, async (_event, folderPath: string, nickname?: string) => {
    const folders = readFolders();
    // Deduplicate by normalized path
    const normalized = path.resolve(folderPath);
    if (folders.some(f => path.resolve(f.path) === normalized)) {
      return folders.find(f => path.resolve(f.path) === normalized);
    }
    const entry: SavedFolder = {
      path: normalized,
      nickname: nickname || path.basename(normalized),
      addedAt: Date.now(),
    };
    folders.unshift(entry);
    writeFolders(folders);
    return entry;
  });

  ipcMain.handle(IPC.FOLDERS_REMOVE, async (_event, folderPath: string) => {
    const folders = readFolders();
    // Compare case-insensitively on Windows (paths are case-insensitive there).
    // WHY: Project View passes the project's CANONICAL path (lowercase drive,
    // e.g. c:\…) while the store holds the path.resolve form (uppercase drive,
    // C:\…). A case-sensitive compare would silently fail to remove the entry.
    const samePath = (a: string, b: string) =>
      process.platform === 'win32'
        ? a.toLowerCase() === b.toLowerCase()
        : a === b;
    const normalized = path.resolve(folderPath);
    const filtered = folders.filter(f => !samePath(path.resolve(f.path), normalized));
    if (filtered.length === folders.length) return false;
    writeFolders(filtered);
    return true;
  });

  ipcMain.handle(IPC.FOLDERS_RENAME, async (_event, folderPath: string, nickname: string) => {
    const folders = readFolders();
    const normalized = path.resolve(folderPath);
    const entry = folders.find(f => path.resolve(f.path) === normalized);
    if (!entry) return false;
    entry.nickname = nickname;
    writeFolders(folders);
    return true;
  });

  // --- Skills discovery & marketplace ---
  ipcMain.handle(IPC.SKILLS_LIST, async () => {
    return skillProvider.getInstalled();
  });

  ipcMain.handle(IPC.COMMANDS_LIST, async () => {
    return commandProvider.getCommands();
  });

  ipcMain.handle(IPC.SKILLS_LIST_MARKETPLACE, async (_event, filters) => {
    return skillProvider.listMarketplace(filters);
  });

  ipcMain.handle(IPC.SKILLS_GET_DETAIL, async (_event, id: string) => {
    return skillProvider.getSkillDetail(id);
  });

  ipcMain.handle(IPC.SKILLS_SEARCH, async (_event, query: string) => {
    return skillProvider.search(query);
  });

  ipcMain.handle(IPC.SKILLS_INSTALL, async (_event, id: string) => {
    const result = await skillProvider.install(id);
    // Reload plugins so Claude Code discovers the new plugin. Uses a
    // short delay because firing immediately races the prompt-ready state
    // (the reload gets queued but silently no-ops). Matches Android
    // behavior (SessionService.kt:458).
    if (result.status === 'installed' && result.type === 'plugin') {
      sessionManager.broadcastReloadPlugins();
    }
    return result;
  });

  ipcMain.handle(IPC.SKILLS_UNINSTALL, async (_event, id: string) => {
    // Defense-in-depth: UI disables the uninstall button for bundled
    // plugins; reject here too so a stale client or direct IPC call can't
    // bypass it.
    if (isBundledPlugin(id)) {
      return { ok: false, error: 'bundled', type: 'plugin' };
    }
    const result = await skillProvider.uninstall(id);
    // Reload plugins so Claude Code drops the uninstalled plugin — matches
    // Android behavior (SessionService.kt:490)
    if (result.type === 'plugin') {
      sessionManager.broadcastReloadPlugins();
    }
    return result;
  });

  ipcMain.handle(IPC.SKILLS_GET_FAVORITES, async () => {
    return skillProvider.getFavorites();
  });

  ipcMain.handle(IPC.SKILLS_SET_FAVORITE, async (_event, id: string, favorited: boolean) => {
    return skillProvider.setFavorite(id, favorited);
  });

  // Theme favorites — parallel to skills:set-favorite. Drives the Appearance
  // panel's favorites-only list and the "My favorite themes" Library section.
  ipcMain.handle(IPC.APPEARANCE_GET_FAVORITE_THEMES, async () => {
    return skillProvider.configStore.getThemeFavorites();
  });

  ipcMain.handle(IPC.APPEARANCE_FAVORITE_THEME, async (_event, slug: string, favorited: boolean) => {
    skillProvider.configStore.setThemeFavorite(slug, favorited);
    // Broadcast to peer windows so ThemeContext re-reads without requiring a
    // polled IPC fetch. Reuses the existing appearance broadcast pipe.
    try {
      const prefs = { themeFavoritesChanged: Date.now() };
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send('appearance:sync', prefs);
      }
    } catch { /* best-effort broadcast */ }
    return skillProvider.configStore.getThemeFavorites();
  });

  ipcMain.handle(IPC.SKILLS_GET_CHIPS, async () => {
    return skillProvider.getChips();
  });

  ipcMain.handle(IPC.SKILLS_SET_CHIPS, async (_event, chips) => {
    return skillProvider.setChips(chips);
  });

  ipcMain.handle(IPC.SKILLS_GET_OVERRIDE, async (_event, id: string) => {
    return skillProvider.getOverrides().then(o => o[id] || null);
  });

  ipcMain.handle(IPC.SKILLS_SET_OVERRIDE, async (_event, id: string, override) => {
    return skillProvider.setOverride(id, override);
  });

  ipcMain.handle(IPC.SKILLS_CREATE_PROMPT, async (_event, skill) => {
    return skillProvider.createPromptSkill(skill);
  });

  ipcMain.handle(IPC.SKILLS_DELETE_PROMPT, async (_event, id: string) => {
    return skillProvider.deletePromptSkill(id);
  });

  ipcMain.handle(IPC.SKILLS_PUBLISH, async (_event, id: string) => {
    return skillProvider.publish(id);
  });

  ipcMain.handle(IPC.SKILLS_GET_SHARE_LINK, async (_event, id: string) => {
    return skillProvider.generateShareLink(id);
  });

  ipcMain.handle(IPC.SKILLS_IMPORT_FROM_LINK, async (_event, encoded: string) => {
    return skillProvider.importFromLink(encoded);
  });

  ipcMain.handle(IPC.SKILLS_GET_CURATED_DEFAULTS, async () => {
    return skillProvider.getCuratedDefaults();
  });

  ipcMain.handle(IPC.SKILLS_GET_FEATURED, async () => {
    return skillProvider.getFeatured();
  });

  // Marketplace redesign Phase 3 — integrations IPC. list/status are real;
  // install/uninstall/configure are scaffolded (manifest-only; the actual
  // OAuth + script runner lands with the Google Workspace slice).
  ipcMain.handle(IPC.INTEGRATIONS_LIST, async () => {
    return listWithState(integrationInstaller);
  });
  ipcMain.handle(IPC.INTEGRATIONS_STATUS, async (_e, slug: string) => {
    return integrationInstaller.status(slug);
  });
  ipcMain.handle(IPC.INTEGRATIONS_INSTALL, async (_e, slug: string) => {
    return integrationInstaller.install(slug);
  });
  ipcMain.handle(IPC.INTEGRATIONS_UNINSTALL, async (_e, slug: string) => {
    return integrationInstaller.uninstall(slug);
  });
  ipcMain.handle(IPC.INTEGRATIONS_CONFIGURE, async (_e, slug: string, settings: Record<string, unknown>) => {
    return integrationInstaller.configure(slug, settings);
  });
  ipcMain.handle(IPC.INTEGRATIONS_CONNECT, async (_e, slug: string) => {
    return integrationInstaller.connect(slug);
  });

  // Reports process.platform so the renderer can gate UI (e.g. hide Install
  // buttons on macOS-only integrations when running on Windows). Returns the
  // raw Node code — the renderer uses platform-display.ts to humanize.
  ipcMain.handle(IPC.PLATFORM_GET, () => {
    return process.platform;
  });

  // Phase 4 — user-initiated cache bust. Next fetchIndex/getFeatured refetches.
  ipcMain.handle(IPC.MARKETPLACE_INVALIDATE_CACHE, async () => {
    await skillProvider.invalidateCache();
  });

  // Decomposition v3 §9.9: surface integration info for the detail view badges
  ipcMain.handle(IPC.SKILLS_GET_INTEGRATION_INFO, async (_event, id: string) => {
    return skillProvider.getIntegrationInfo(id);
  });

  // Decomposition v3 §9.10: onboarding bulk-install curated packages
  ipcMain.handle(IPC.SKILLS_INSTALL_MANY, async (_event, ids: string[]) => {
    return skillProvider.installMany(ids);
  });

  // Decomposition v3 §9.10: onboarding picks an output style
  ipcMain.handle(IPC.SKILLS_APPLY_OUTPUT_STYLE, async (_event, styleId: string) => {
    skillProvider.applyOutputStyle(styleId);
    return { ok: true };
  });

  // Phase 3a: unified marketplace packages map — lets the renderer know which
  // versions are currently installed (for update detection) and the on-disk
  // component paths (for uninstall cascade).
  ipcMain.handle(IPC.MARKETPLACE_GET_PACKAGES, async () => {
    return skillProvider.configStore.getPackages();
  });

  // Phase 3b: update an installed plugin/prompt to the latest marketplace
  // version. Re-downloads files, overwrites at the same path, and bumps the
  // version in youcoded-skills.json. Config is NOT touched.
  ipcMain.handle(IPC.SKILLS_UPDATE, async (_event, id: string) => {
    const result = await skillProvider.update(id);
    // Reload plugins in active sessions so Claude Code picks up updated code
    if (result.ok) {
      sessionManager.broadcastReloadPlugins();
    }
    return result;
  });

  // Phase 3b: update an installed theme to the latest registry version.
  // Re-downloads theme files at the same slug path and bumps the version.
  ipcMain.handle(IPC.THEME_MARKETPLACE_UPDATE, async (_event, slug: string) => {
    return themeMarketplace.updateTheme(slug);
  });

  // Phase 3c: per-entry config — reads/writes ~/.claude/youcoded-config/<id>.json.
  // Only entries that declare configSchema in their marketplace JSON use this.
  ipcMain.handle(IPC.MARKETPLACE_GET_CONFIG, async (_event, id: string) => {
    return getMarketplaceConfig(id);
  });

  ipcMain.handle(IPC.MARKETPLACE_SET_CONFIG, async (_event, id: string, values: Record<string, unknown>) => {
    setMarketplaceConfig(id, values);
    return { ok: true };
  });

  // In-app file viewer — reads a SKILL.md / command / agent file for a plugin.
  // Tries the local install dir first, then falls back to a raw GitHub URL
  // derived from the marketplace entry's sourceType/sourceRef.
  ipcMain.handle(IPC.MARKETPLACE_READ_COMPONENT, async (
    _event, args: { pluginId: string; kind: ComponentKind; name: string },
  ) => {
    try {
      return await readComponent(args, () => skillProvider.listMarketplace());
    } catch (err) {
      return { error: (err as Error).message };
    }
  });

  // --- Remote access settings ---
  let keepAwakeBlockerId: number | null = null;
  let keepAwakeTimeout: ReturnType<typeof setTimeout> | null = null;

  function applyKeepAwake(hours: number) {
    // Clear existing blocker
    if (keepAwakeBlockerId !== null) {
      powerSaveBlocker.stop(keepAwakeBlockerId);
      keepAwakeBlockerId = null;
    }
    if (keepAwakeTimeout) {
      clearTimeout(keepAwakeTimeout);
      keepAwakeTimeout = null;
    }
    // Start new blocker if hours > 0
    if (hours > 0) {
      keepAwakeBlockerId = powerSaveBlocker.start('prevent-app-suspension');
      keepAwakeTimeout = setTimeout(() => {
        if (keepAwakeBlockerId !== null) {
          powerSaveBlocker.stop(keepAwakeBlockerId);
          keepAwakeBlockerId = null;
        }
        if (remoteConfig) {
          remoteConfig.keepAwakeHours = 0;
          remoteConfig.save();
        }
      }, hours * 60 * 60 * 1000);
    }
  }

  if (remoteConfig) {
    // Apply saved keep-awake on startup
    if (remoteConfig.keepAwakeHours > 0) applyKeepAwake(remoteConfig.keepAwakeHours);
    ipcMain.handle(IPC.REMOTE_GET_CONFIG, async () => {
      return {
        ...remoteConfig.toSafeObject(),
        clientCount: remoteServer?.getClientCount() ?? 0,
      };
    });

    ipcMain.handle(IPC.REMOTE_SET_PASSWORD, async (_event, password: string) => {
      await remoteConfig.setPassword(password);
      remoteServer?.invalidateTokens();
      return true;
    });

    ipcMain.handle(IPC.REMOTE_SET_CONFIG, async (_event, updates: { enabled?: boolean; trustTailscale?: boolean; keepAwakeHours?: number }) => {
      if (typeof updates.enabled === 'boolean') remoteConfig.enabled = updates.enabled;
      if (typeof updates.trustTailscale === 'boolean') remoteConfig.trustTailscale = updates.trustTailscale;
      if (typeof updates.keepAwakeHours === 'number') {
        remoteConfig.keepAwakeHours = updates.keepAwakeHours;
        applyKeepAwake(updates.keepAwakeHours);
      }
      remoteConfig.save();
      return remoteConfig.toSafeObject();
    });

    ipcMain.handle(IPC.REMOTE_DETECT_TAILSCALE, async () => {
      return RemoteConfig.detectTailscale(remoteConfig.port);
    });

    ipcMain.handle(IPC.REMOTE_GET_CLIENT_COUNT, async () => {
      return remoteServer?.getClientCount() ?? 0;
    });

    ipcMain.handle(IPC.REMOTE_GET_CLIENT_LIST, async () => {
      return remoteServer?.getClientList() ?? [];
    });

    ipcMain.handle(IPC.REMOTE_DISCONNECT_CLIENT, async (_event, clientId: string) => {
      return remoteServer?.disconnectClient(clientId) ?? false;
    });

    ipcMain.handle(IPC.REMOTE_INSTALL_TAILSCALE, async () => {
      return RemoteConfig.installTailscale();
    });

    ipcMain.handle(IPC.REMOTE_AUTH_TAILSCALE, async () => {
      const result = await RemoteConfig.startTailscaleAuth();
      if (result.url) {
        shell.openExternal(result.url);
      }
      return result;
    });

    // UI action sync: Electron window broadcasts an action → forward to all remote clients
    ipcMain.on(IPC.UI_ACTION_BROADCAST, (_event, action: any) => {
      remoteServer?.broadcast({ type: 'ui:action', payload: action });
    });

    // UI action sync: Remote client broadcasts an action → forward to Electron window
    sessionManager.on('ui-action', (action: any) => {
      send(IPC.UI_ACTION_RECEIVED, action);
    });
  }

  // --- Session browser (resume) ---
  ipcMain.handle(IPC.SESSION_BROWSE, async () => {
    // Collect active Claude Code session IDs so we can exclude them.
    // Bug 1 (2026-07-13 dogfood): a stale sessionIdMap entry (missed exit event,
    // or a create+resume pair leaving two desktop ids on one claude id) hid a
    // CLOSED session from the browser until restart. Filter to mappings whose
    // desktop session actually still exists — the map is a cache, not truth.
    const activeIds = new Set<string>();
    for (const [desktopId, claudeId] of sessionIdMap.entries()) {
      if (sessionManager.getSession(desktopId)) activeIds.add(claudeId);
    }
    // CC (Claude Code) transcript rows.
    const ccRows = await listPastSessions(activeIds);
    // Native-harness rows — map NativeSessionHost.list() entries onto the
    // PastSession shape (now that PastSession carries `provider`). Native
    // sessions have no CC auto-title hook, so the store already derived a title
    // from the first user message; fall back to 'Untitled' when even that is
    // absent. mtimeMs/sizeBytes stand in for lastModified/size.
    const nativeRows: PastSession[] = nativeHost.list().map((r) => ({
      sessionId: r.sessionId,
      name: r.title ?? 'Untitled',
      projectSlug: r.slug,
      projectPath: r.cwd,
      lastModified: r.mtimeMs,
      size: r.sizeBytes,
      provider: 'native' as const,
    }));
    // ResumeBrowser re-sorts by lastModified, so a plain concat is fine here.
    return [...ccRows, ...nativeRows];
  });

  ipcMain.handle(IPC.SESSION_HISTORY, async (
    _event,
    sessionId: string,
    projectSlug: string,
    count: number,
    all: boolean,
  ) => {
    return loadHistory(sessionId, projectSlug, count, all);
  });


  // PTY input (fire-and-forget, not request-response)
  ipcMain.on(IPC.SESSION_INPUT, (_event, sessionId: string, text: string) => {
    sessionManager.sendInput(sessionId, text);
  });

  // PTY resize (fire-and-forget)
  ipcMain.on(IPC.SESSION_RESIZE, (_event, sessionId: string, cols: number, rows: number) => {
    sessionManager.resizeSession(sessionId, cols, rows);
  });

  // --- PTY output buffering ---
  // Buffer output per-session until the renderer signals its terminal is mounted.
  // This prevents losing the initial trust prompt on slow systems where
  // PTY output arrives before TerminalView mounts and registers its listener.
  const pendingOutput = new Map<string, string[]>();
  const readySessions = new Set<string>();

  // Perf: previously we dual-sent every PTY chunk to BOTH the per-session
  // channel AND the global IPC.PTY_OUTPUT channel. The global channel existed
  // solely so App.tsx could watch permission-mode strings ("bypass permissions
  // on" etc.) across all sessions with one listener. With many sessions
  // streaming that doubled IPC traffic and forced every BrowserWindow to
  // deserialize output for sessions it may not own. App.tsx now subscribes
  // per-session in sync with session:created / session:destroyed events, so
  // the global broadcast is no longer needed.
  sessionManager.on('pty-output', (sessionId: string, data: string) => {
    if (readySessions.has(sessionId)) {
      sendForSession(sessionId, `pty:output:${sessionId}`, data);
    } else {
      let buf = pendingOutput.get(sessionId);
      if (!buf) {
        buf = [];
        pendingOutput.set(sessionId, buf);
      }
      buf.push(data);
    }
  });

  // Renderer signals terminal is mounted and listening
  ipcMain.on(IPC.TERMINAL_READY, (_event, sessionId: string) => {
    readySessions.add(sessionId);
    const buffered = pendingOutput.get(sessionId);
    if (buffered) {
      for (const data of buffered) {
        sendForSession(sessionId, `pty:output:${sessionId}`, data);
      }
      pendingOutput.delete(sessionId);
    }
  });

  // No-op: Electron has no hardware back button. Registered for shape
  // parity with SessionService.kt's handleBridgeMessage() so the
  // 'system:notify-stack-state' string exists in ipc-handlers.ts too.
  ipcMain.on(IPC.SYSTEM_NOTIFY_STACK_STATE, () => {
    // intentionally empty
  });

  // Forward session exit events — exitCode is piped through to the renderer
  // so the reducer can distinguish clean shutdowns from 'session-died' cases.
  sessionManager.on('session-exit', (sessionId: string, exitCode: number) => {
    sendForSession(sessionId, IPC.SESSION_DESTROYED, sessionId, exitCode);
    pendingOutput.delete(sessionId);
    readySessions.delete(sessionId);
    windowRegistry?.releaseSession(sessionId);
  });

  // --- Prune stale context files on startup ---
  // Context files are written per-session by statusline.sh and cleaned up on
  // session exit, but a crash can leave orphans. Delete any .context-* files
  // that aren't associated with a running session.
  try {
    const claudeDir = path.join(os.homedir(), '.claude');
    const entries = fs.readdirSync(claudeDir);
    for (const entry of entries) {
      // Prune orphaned context + session-stats files from crashed sessions
      if (entry.startsWith('.context-') || entry.startsWith('.session-stats-')) {
        fs.unlink(path.join(claudeDir, entry), () => {});
      }
    }
  } catch { /* directory doesn't exist or unreadable — fine */ }

  // --- Status data poller ---
  // Reads YouCoded cache files and pushes status updates to the renderer
  const usageCachePath = path.join(os.homedir(), '.claude', '.usage-cache.json');
  const announcementCachePath = path.join(os.homedir(), '.claude', '.announcement-cache.json');

  // --- YouCoded app update checker via GitHub Releases API ---
  // Caches the latest release info and refreshes every 30 minutes.
  let cachedUpdateStatus: { current: string; latest: string; update_available: boolean; download_url: string | null } | null = null;
  let lastReleaseCheck = 0;
  const RELEASE_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes

  function fetchLatestRelease(): Promise<void> {
    return new Promise((resolve) => {
      const req = https.get('https://api.github.com/repos/itsdestin/youcoded/releases/latest', {
        headers: { 'User-Agent': 'YouCoded', 'Accept': 'application/vnd.github.v3+json' },
        timeout: 10000,
      }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          // Follow redirect (GitHub sometimes redirects)
          https.get(res.headers.location!, { headers: { 'User-Agent': 'YouCoded', 'Accept': 'application/vnd.github.v3+json' }, timeout: 10000 }, (rRes) => {
            let body = '';
            rRes.on('data', (chunk: Buffer) => { body += chunk.toString(); });
            rRes.on('end', () => { parseReleaseResponse(body); resolve(); });
          }).on('error', () => { resolve(); });
          return;
        }
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => { parseReleaseResponse(body); resolve(); });
      });
      req.on('error', () => { resolve(); });
      req.on('timeout', () => { req.destroy(); resolve(); });
    });
  }

  function parseReleaseResponse(body: string) {
    try {
      const release = JSON.parse(body);
      const tagName: string = release.tag_name || '';
      const latestVersion = tagName.replace(/^v/, '');
      const currentVersion = app.getVersion();
      const isNewer = compareVersions(latestVersion, currentVersion) > 0;

      // Find the right installer asset for the current platform
      const assets: Array<{ name: string; browser_download_url: string }> = release.assets || [];
      let downloadUrl: string | null = null;
      const platform = process.platform;
      if (platform === 'win32') {
        // Prefer .exe installer
        const exe = assets.find(a => a.name.endsWith('.exe'));
        downloadUrl = exe?.browser_download_url || null;
      } else if (platform === 'darwin') {
        // Prefer .dmg matching the current arch. electron-builder produces both
        // `YouCoded-<ver>-arm64.dmg` and `YouCoded-<ver>.dmg` (x64, no suffix),
        // and GitHub returns them in non-deterministic order — so a plain
        // `.endsWith('.dmg')` would hand Intel Macs the arm64 DMG (or vice
        // versa), which Gatekeeper refuses to mount. Match by arch first, then
        // fall back to any .dmg if a matching one isn't in the release.
        const wantArm = process.arch === 'arm64';
        const archDmg = assets.find(a => a.name.endsWith('.dmg') && a.name.includes('arm64') === wantArm);
        const anyDmg = assets.find(a => a.name.endsWith('.dmg'));
        downloadUrl = archDmg?.browser_download_url || anyDmg?.browser_download_url || null;
      } else {
        // Linux — prefer .AppImage, fallback to .deb
        const appImage = assets.find(a => a.name.endsWith('.AppImage'));
        const deb = assets.find(a => a.name.endsWith('.deb'));
        downloadUrl = appImage?.browser_download_url || deb?.browser_download_url || null;
      }
      // Fallback to release page if no matching asset found
      if (!downloadUrl) downloadUrl = release.html_url || null;

      cachedUpdateStatus = { current: currentVersion, latest: latestVersion, update_available: isNewer, download_url: downloadUrl };
      lastReleaseCheck = Date.now();
    } catch {
      // Parse failed — keep previous cache or set current version only
      if (!cachedUpdateStatus) {
        cachedUpdateStatus = { current: app.getVersion(), latest: app.getVersion(), update_available: false, download_url: null };
      }
    }
  }

  /** Simple semver compare: returns >0 if a > b, <0 if a < b, 0 if equal */
  function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na !== nb) return na - nb;
    }
    return 0;
  }

  function getUpdateStatus() {
    // Return cached value, kick off background refresh if stale
    if (Date.now() - lastReleaseCheck > RELEASE_CHECK_INTERVAL) {
      fetchLatestRelease().catch(() => {});
    }
    const status = cachedUpdateStatus || { current: app.getVersion(), latest: app.getVersion(), update_available: false, download_url: null };

    // Dev-only: force update_available=true for manual UpdatePanel verification without waiting for a real release.
    // Set YOUCODED_DEV_FAKE_UPDATE=1 to simulate a new release one patch ahead of the current version.
    // Note: the download_url points at the real GitHub releases page, so clicking Update Now opens the browser
    // to the actual latest release — not the fake +1 version. That's fine for UI verification; no real installer
    // exists for the fake version. No-op unless the env var is exactly '1'.
    // `!app.isPackaged` gate: belt-and-suspenders so a stray env var in a user's
    // shell can't flip the update pill on in a packaged build. Dev-only by design.
    if (!app.isPackaged && process.env.YOUCODED_DEV_FAKE_UPDATE === '1') {
      const currentVersion = app.getVersion();
      const parts = currentVersion.split('.').map(n => parseInt(n, 10));
      const maj = parts[0] || 0;
      const min = parts[1] || 0;
      const patch = parts[2] || 0;
      return {
        current: currentVersion,
        latest: `${maj}.${min}.${patch + 1}`,
        update_available: true,
        download_url: 'https://github.com/itsdestin/youcoded/releases/latest',
      };
    }

    return status;
  }

  // -------------------------------------------------------------------------
  // In-app update installer — download + launch the platform installer.
  // Spec: docs/superpowers/specs/2026-04-22-in-app-update-installer-design.md
  // -------------------------------------------------------------------------
  const updateCacheDir = path.join(app.getPath('userData'), 'update-cache');

  const installer = createUpdateInstaller({
    cacheDir: updateCacheDir,
    onProgress: (ev: UpdateProgressEvent) => {
      // Broadcast to every live renderer. Renderers filter by jobId (single-job
      // invariant in the engine means only one is in flight, but filtering keeps
      // UI state correct if a prior job's final tick arrives after the popup closed).
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:progress', ev);
      }
    },
  });

  const launchInstaller = makeLaunchInstaller({
    shellOpenExternal: (url: string) => shell.openExternal(url),
    appRelaunch: () => app.relaunch(),
    fallbackDownloadUrl: () => cachedUpdateStatus?.download_url ?? '',
    // production reads process.env.APPIMAGE (Linux only); tests pass an override.
  });

  // Dev-only fake-update flag: when set AND running from source (unpackaged),
  // short-circuit the download/launch to use a bundled 1 MB dummy installer.
  // Lets us exercise the popup flow end-to-end without a real release. Gated on
  // !app.isPackaged so production builds can never enter this path even if the
  // env var is somehow set.
  const devFakeUpdate = !app.isPackaged && process.env.YOUCODED_DEV_FAKE_UPDATE === '1';

  ipcMain.handle('update:download', async () => {
    if (devFakeUpdate) {
      // Copy the bundled dummy installer into the cache dir so the launch path
      // exercises the same file-move logic it would hit in prod. Emits one
      // synchronous 100% progress event so the renderer sees the full arc.
      const ext = process.platform === 'win32' ? '.exe'
               : process.platform === 'darwin' ? '.dmg'
               : '.AppImage';
      // app.getAppPath() resolves to the desktop/ root (where package.json lives),
      // which is where dev-assets/ sits. More robust than __dirname across dev
      // build variations (tsc watch vs esbuild output).
      const srcPath = path.join(app.getAppPath(), 'dev-assets', `fake-installer${ext}`);
      if (!fs.existsSync(updateCacheDir)) fs.mkdirSync(updateCacheDir, { recursive: true });
      const dstPath = path.join(updateCacheDir, `YouCoded-fake-dev${ext}`);
      fs.copyFileSync(srcPath, dstPath);
      const bytesTotal = fs.statSync(dstPath).size;
      const jobId = `dev-${Date.now()}`;
      for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('update:progress', { jobId, bytesReceived: bytesTotal, bytesTotal, percent: 100 });
      }
      return { jobId, filePath: dstPath, bytesTotal };
    }
    // Renderer never passes a URL — we resolve main-side from the trusted cache
    // populated by the GitHub Releases check. Prevents renderer from spoofing
    // the download target.
    const status = getUpdateStatus();
    const url = status?.download_url;
    if (!url) throw new UpdateInstallError('url-rejected', 'no download URL available');
    return await installer.startDownload(url);
  });

  ipcMain.handle('update:cancel', async (_event, payload: { jobId: string }) => {
    installer.cancelDownload(payload.jobId);
    return { success: true };
  });

  ipcMain.handle('update:launch', async (_event, payload: { jobId: string; filePath: string }) => {
    if (devFakeUpdate) {
      // Never actually launch anything in dev — just surface the cached file in
      // the OS file manager so Destin can confirm it exists.
      shell.showItemInFolder(payload.filePath);
      // Return the fallback: 'browser' shape so the renderer flips out of launching
      // state and calls onClose() — do NOT schedule app.quit() (that would kill the dev session).
      return { success: true, quitPending: false, fallback: 'browser' as const };
    }
    const result = await launchInstaller({ jobId: payload.jobId, filePath: payload.filePath });
    if (result.success && result.quitPending) {
      // 500ms grace so the child installer process has detached cleanly before we exit.
      setTimeout(() => app.quit(), 500);
    }
    return result;
  });

  ipcMain.handle('update:get-cached-download', async (_event, payload: { version: string }) => {
    return findCachedDownload(updateCacheDir, payload.version, process.platform);
  });

  // Initial fetch on startup
  fetchLatestRelease().catch(() => {});
  const modelPrefPath = path.join(os.homedir(), '.claude', 'youcoded-model.json');
  const appearancePrefPath = path.join(os.homedir(), '.claude', 'youcoded-appearance.json');
  const defaultsPrefPath = path.join(os.homedir(), '.claude', 'youcoded-defaults.json');

  function readJsonFile(filePath: string): any {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
      return null;
    }
  }

  const syncStatusPath = path.join(os.homedir(), '.claude', '.sync-status');
  // Legacy .sync-warnings text file is no longer read; typed warnings come from .sync-warnings.json.
  const syncWarningsJsonPath = path.join(os.homedir(), '.claude', '.sync-warnings.json');

  function readTextFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf8').trim() || null;
    } catch {
      return null;
    }
  }

  /** Read typed sync warnings synchronously — returns [] if missing or unparseable. */
  function readSyncWarningsSync(): SyncWarning[] {
    try {
      const text = fs.readFileSync(syncWarningsJsonPath, 'utf8');
      const parsed = JSON.parse(text);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  // Fix: per-session status bar chips were disappearing for a few seconds after
  // switching back to an idle session. Root cause: statusline.sh writes the
  // three session files (.context-, .session-stats-, .gitbranch-) with
  // truncate-then-write (fs.writeFileSync / shell `>`). If a 10s status poll
  // lands inside that truncate window, readTextFile returns null and the entry
  // is omitted from the rebuilt map, which the renderer then replaces wholesale
  // — wiping the chips until the next successful poll. These caches preserve
  // the last-known good value so a transient read miss doesn't blank the UI.
  // Entries are purged on session-exit below.
  const lastContextByDesktopId: Record<string, number> = {};
  const lastGitBranchByDesktopId: Record<string, string> = {};
  const lastSessionStatsByDesktopId: Record<string, any> = {};

  // Per-session attention state, updated by the renderer via
  // `remote:attention-changed` and read by buildStatusData() so remote
  // browsers see matching StatusDot colors. Declared alongside the other
  // last-known caches (above) so buildStatusData's lexical scope has all
  // four in the TDZ-safe range. The listener that writes into this Map
  // is registered further down where the handler block begins.
  const lastAttentionBySession = new Map<string, string>();

  function buildStatusData() {
    const usage = readJsonFile(usageCachePath);
    const announcement = readJsonFile(announcementCachePath);
    const updateStatus = getUpdateStatus();
    const syncStatus = readTextFile(syncStatusPath);
    const syncWarnings = readSyncWarningsSync();

    // Sync state for live updates — SyncPanel also fetches via IPC,
    // but these fields let the compact section row update in real-time.
    const syncMarkerRaw = readTextFile(path.join(os.homedir(), '.claude', 'toolkit-state', '.sync-marker'));
    const lastSyncEpoch = syncMarkerRaw ? parseInt(syncMarkerRaw, 10) || null : null;
    let syncInProgress = false;
    try { syncInProgress = fs.statSync(path.join(os.homedir(), '.claude', 'toolkit-state', '.sync-lock')).isDirectory(); } catch {}
    const backupMeta = readJsonFile(path.join(os.homedir(), '.claude', 'backup-meta.json'));

    // Read per-session context remaining % (written by statusline.sh)
    const contextMap: Record<string, number> = {};
    for (const [desktopId, claudeId] of sessionIdMap) {
      const raw = readTextFile(path.join(os.homedir(), '.claude', `.context-${claudeId}`));
      if (raw != null) {
        const num = parseInt(raw, 10);
        if (!isNaN(num)) {
          contextMap[desktopId] = num;
          lastContextByDesktopId[desktopId] = num;
        }
      } else if (desktopId in lastContextByDesktopId) {
        contextMap[desktopId] = lastContextByDesktopId[desktopId];
      }
    }

    // Read per-session git branch (written by statusline.sh, same pattern as context %)
    const gitBranchMap: Record<string, string> = {};
    for (const [desktopId, claudeId] of sessionIdMap) {
      const raw = readTextFile(path.join(os.homedir(), '.claude', `.gitbranch-${claudeId}`));
      if (raw) {
        gitBranchMap[desktopId] = raw;
        lastGitBranchByDesktopId[desktopId] = raw;
      } else if (desktopId in lastGitBranchByDesktopId) {
        gitBranchMap[desktopId] = lastGitBranchByDesktopId[desktopId];
      }
    }

    // Read per-session stats (cost, tokens, code changes — written by statusline.sh)
    const sessionStatsMap: Record<string, any> = {};
    for (const [desktopId, claudeId] of sessionIdMap) {
      const stats = readJsonFile(path.join(os.homedir(), '.claude', `.session-stats-${claudeId}.json`));
      if (stats) {
        sessionStatsMap[desktopId] = stats;
        lastSessionStatsByDesktopId[desktopId] = stats;
      } else if (desktopId in lastSessionStatsByDesktopId) {
        sessionStatsMap[desktopId] = lastSessionStatsByDesktopId[desktopId];
      }
    }

    // Per-session attention state populated by the `remote:attention-changed`
    // IPC listener. Remote browsers diff this on receipt to update StatusDot
    // colors for sessions that have diffed since the last broadcast.
    const attentionMap: Record<string, string> = {};
    for (const [desktopId] of sessionIdMap) {
      const state = lastAttentionBySession.get(desktopId);
      if (state) attentionMap[desktopId] = state;
    }

    // (The background bulk-conversations pull + its restore-progress chip were
    // removed in sync-legacy-demolition — the pull path no longer exists.)

    return { usage, announcement, updateStatus, syncStatus, syncWarnings, lastSyncEpoch, syncInProgress, backupMeta, contextMap, gitBranchMap, sessionStatsMap, attentionMap };
  }

  // Push status data every 10s — store handle so it can be cleared on shutdown
  const statusInterval = setInterval(() => {
    const data = buildStatusData();
    send(IPC.STATUS_DATA, data);
    // Feed full status data to remote server for browser clients (single polling source)
    if (remoteServer) remoteServer.broadcastStatusData(data);
  }, 10000);

  // Also push immediately on first hook event (session is active)
  let sentInitialStatus = false;
  if (hookRelay) {
    hookRelay.on('hook-event', () => {
      if (!sentInitialStatus) {
        sentInitialStatus = true;
        const data = buildStatusData();
        send(IPC.STATUS_DATA, data);
        if (remoteServer) remoteServer.broadcastStatusData(data);
      }
    });
  }

  // --- Usage cache refresher ---
  // Runs usage-fetch.js periodically to keep .usage-cache.json fresh
  // even when the YouCoded toolkit's statusline isn't running.
  const rawUsageFetchPath = path.resolve(__dirname, '../../hook-scripts/usage-fetch.js');
  const unpackedUsageFetchPath = rawUsageFetchPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const usageFetchScript = fs.existsSync(unpackedUsageFetchPath) ? unpackedUsageFetchPath : rawUsageFetchPath;

  function refreshUsageCache() {
    try {
      execFile('node', [usageFetchScript], { timeout: 15000 }, () => {
        // Output written to .usage-cache.json; buildStatusData() reads it
      });
    } catch { /* node not found or script error — status bar just shows no data */ }
  }

  refreshUsageCache();
  const usageRefreshInterval = setInterval(refreshUsageCache, 5 * 60 * 1000);

  // --- Topic file watcher (auto-title) ---
  // The auto-title hook writes topics to ~/.claude/topics/topic-{CLAUDE_CODE_SESSION_ID}.
  // But our desktop session IDs differ from Claude Code's internal IDs.
  // We discover the mapping from hook events (which contain both IDs)
  // and watch the correct file.
  const topicDir = path.join(os.homedir(), '.claude', 'topics');
  // Maps desktop session ID → Claude Code session ID
  const sessionIdMap = new Map<string, string>();

  // Holder-side takeover (Plan 2b Task 8): when another device requests this
  // session, cleanly interrupt, flush the final turn to the space, release the
  // lease, tell the UI it moved, and end the local session. Wired here because
  // the reverse-map (claude id → desktop id) needs sessionIdMap; sendForSession is
  // in scope for the dual-path renderer + remote push.
  if (leaseWiring) {
    const pushMoved = (desktopId: string, device?: string) => {
      // Enrich the push so the renderer's MovedGate can offer "Resume on this
      // device" without a second lookup. At push time (step 7) the holder session
      // still exists — destroy is step 8 — so both the claude id and the live
      // session's cwd are available. projectSlug mirrors how the Resume Browser
      // derives it (ccProjectSlug of the cwd) so handleResumeSession's history
      // load + resumeInfo land on the right CC project dir.
      const claudeSessionId = sessionIdMap.get(desktopId);
      const info = sessionManager.getSession(desktopId);
      const projectPath = info?.cwd;
      const projectSlug = projectPath ? ccProjectSlug(projectPath) : undefined;
      const payload = { sessionId: desktopId, device, claudeSessionId, projectSlug, projectPath };
      sendForSession(desktopId, IPC.SESSION_MOVED, payload);          // owning renderer window
      remoteServer?.broadcast({ type: IPC.SESSION_MOVED, payload }); // remote clients
    };
    const holderTakeover = createHolderTakeover({
      sessionManager, sessionIdMap, leaseClient: leaseWiring.client,
      flushSessionToSpace, pushMoved,
    });
    // Fire-and-forget from a hub event — the handler never throws (each step is
    // try/caught inside createHolderTakeover), so void is safe.
    leaseWiring.setHolderTakeover((sid, from) => { void holderTakeover(sid, from); });
  }

  // `lastAttentionBySession` is declared alongside the other status-value
  // caches above buildStatusData(); the listener that writes into it is
  // registered here where the handler block begins.
  ipcMain.on('remote:attention-changed', (_e, payload: { sessionId: string; state: string }) => {
    if (!payload?.sessionId) return;
    lastAttentionBySession.set(payload.sessionId, payload.state);
    // Broadcast immediately so remote clients see the change without waiting
    // for the 10s status:data timer. Payload rebuild is cheap.
    if (remoteServer) {
      const data = buildStatusData();
      remoteServer.broadcastStatusData(data);
    }
  });

  const transcriptWatcher = new TranscriptWatcher();

  transcriptWatcher.on('transcript-event', (event: any) => {
    sendForSession(event.sessionId, IPC.TRANSCRIPT_EVENT, event);
    if (remoteServer) {
      remoteServer.broadcast({ type: 'transcript:event', payload: event });
    }
    // Conversation Store (Phase 2a): feed live activity into the record store.
    // event.sessionId is the DESKTOP id; the store keys by CLAUDE id, so resolve
    // via sessionIdMap and skip if we haven't seen the mapping yet (a hook event
    // establishes it — the reconciler backfills anything missed before then).
    const claudeId = sessionIdMap.get(event.sessionId);
    if (claudeId) noteTranscriptEvent(claudeId, event);
  });

  // --- Native runtime stack (Phase 1 Plan A, Task 9) ---
  // NativeHome is the single writer for ~/.youcoded/; SecretsStore keeps API
  // keys in Electron's safeStorage-encrypted userData (NOT in the syncable home
  // dir). ProviderRegistry.init() seeds the built-in providers under the file
  // lock (fire-and-forget — list/languageModel read on demand). The catalog's
  // contextLengthFor feeds HarnessSession's context-window sizing.
  const nativeHome = new NativeHome();
  const secretsStore = new SecretsStore(app.getPath('userData'));
  // Plan B: the local engine. EngineManager owns acquisition + supervision; its
  // hook makes the 'local' provider real and its listModels feeds the model
  // picker. ENGINE_PORT rides the shifted-port scheme so the dev instance and
  // the built app never fight over one llama-server.
  const engineManager = new EngineManager(nativeHome, app.getPath('userData'), ENGINE_PORT);
  const providerRegistry = new ProviderRegistry(nativeHome, secretsStore, engineManager.registryHook());
  void providerRegistry.init();
  const modelCatalog = new ModelCatalog(app.getPath('userData'), undefined, {
    localModels: () => engineManager.catalogModels(),
  });
  const nativeHost = new NativeSessionHost(
    new SessionStore(nativeHome),
    (binding) => providerRegistry.languageModel(binding),
    async (binding) => modelCatalog.contextLengthFor(binding, await providerRegistry.list()),
  );

  // Native transcript events ride the SAME channel as CC's — the reducer
  // consumes an identical event shape regardless of runtime.
  nativeHost.on('transcript-event', (event: TranscriptEvent) => {
    sendForSession(event.sessionId, IPC.TRANSCRIPT_EVENT, event);
    if (remoteServer) {
      remoteServer.broadcast({ type: 'transcript:event', payload: event });
    }
  });

  // Native permission asks ride the SAME hook:event channel + broadcast as CC's
  // PermissionRequest/PermissionExpired — hook-dispatcher/ToolCard render them
  // unchanged. Ids are 'native-'-prefixed so permission:respond routes by id.
  nativeHost.on('hook-event', (event: HookEvent) => {
    sendForSession(event.sessionId, IPC.HOOK_EVENT, event);
    if (remoteServer) {
      remoteServer.broadcast({ type: 'hook:event', payload: event });
    }
  });

  // Plan C: model manager (curated catalog, HF search, downloads, detectors).
  // Constructed here — BEFORE setNativeRuntime — so remote WS clients reach the
  // SAME instance via the native-runtime injection below (the models:* handlers
  // themselves are registered further down, next to the engine block).
  const modelManager = new ModelManager(nativeHome, engineManager, app.getPath('userData'));

  // Give the remote server access to the native stack so its WS clients reach
  // the SAME instances (mirrors how setLastTopic / broadcastStatusData push
  // ipc-handler-owned state into remoteServer — no global needed).
  remoteServer?.setNativeRuntime({ nativeHost, providerRegistry, modelCatalog, engineManager, modelManager });

  // Plan 2b Task 11: give the remote server the SAME lease client/requester +
  // deviceId so its WS clients reach the identical lease/device state the
  // Electron IPC handlers use (mirrors setNativeRuntime). Absent when sync is off.
  if (leaseWiring && remoteServer) {
    remoteServer.setLeaseWiring({ client: leaseWiring.client, requester: leaseWiring.requester, deviceId: leaseWiring.deviceId });
  }

  // Transcript replay: a window that just acquired a session asks for every
  // historical event so its reducer can hydrate. Events stream back on the
  // normal TRANSCRIPT_EVENT channel (uuid dedup handles overlap with live).
  // We send directly to the requesting window — NOT via sendForSession —
  // because ownership has already transferred to them by the time this fires.
  ipcMain.on(IPC.TRANSCRIPT_REPLAY, (evt, { sessionId }: { sessionId: string }) => {
    // Native sessions replay from the SessionStore; getHistory returns null for
    // non-native ids so CC's watcher stays the source for claude sessions.
    const events = nativeHost.getHistory(sessionId) ?? transcriptWatcher.getHistory(sessionId);
    for (const ev of events) {
      evt.sender.send(IPC.TRANSCRIPT_EVENT, ev);
    }
  });

  // --- Native runtime IPC (Phase 1 Plan A) ---
  // Fire-and-forget I/O (no response): send + interrupt. The host serializes
  // sends per session and never throws for unknown ids.
  ipcMain.on(IPC.NATIVE_SEND, (_e, { sessionId, text }: { sessionId: string; text: string }) => {
    void nativeHost.send(sessionId, text);
  });
  ipcMain.on(IPC.NATIVE_INTERRUPT, (_e, { sessionId }: { sessionId: string }) => {
    nativeHost.interrupt(sessionId);
  });
  ipcMain.handle(IPC.NATIVE_SET_BINDING, async (_e, sessionId: string, binding: any) => nativeHost.setBinding(sessionId, binding));
  ipcMain.handle(IPC.NATIVE_SESSIONS_LIST, async () => nativeHost.list());
  // Provider management (Settings → Providers).
  ipcMain.handle(IPC.PROVIDER_LIST, async () => providerRegistry.list());
  ipcMain.handle(IPC.PROVIDER_UPSERT, async (_e, config: any) => providerRegistry.upsert(config));
  ipcMain.handle(IPC.PROVIDER_REMOVE, async (_e, id: string) => { await providerRegistry.remove(id); return true; });
  ipcMain.handle(IPC.PROVIDER_TEST, async (_e, id: string) => providerRegistry.testConnection(id));
  ipcMain.handle(IPC.PROVIDER_SET_KEY, async (_e, id: string, key: string) => { await providerRegistry.setKey(id, key); return true; });
  ipcMain.handle(IPC.PROVIDER_CATALOG, async () => modelCatalog.get(await providerRegistry.list()));
  // --- Local engine IPC (Plan B) ---
  // install/restart resolve to a fresh status() so the caller doesn't need a
  // second round-trip. The push emitters below keep every window + remote in
  // sync during long installs and on any run-state transition.
  ipcMain.handle(IPC.ENGINE_STATUS, async () => engineManager.status());
  ipcMain.handle(IPC.ENGINE_INSTALL, async () => { await engineManager.install(); return engineManager.status(); });
  ipcMain.handle(IPC.ENGINE_RESTART, async () => { await engineManager.restart(); return engineManager.status(); });
  // Push: install progress + run-state transitions → every window + remotes.
  engineManager.on('install-progress', (p) => {
    send(IPC.ENGINE_INSTALL_PROGRESS, p);
    remoteServer?.broadcast({ type: 'engine:install-progress', payload: p });
  });
  engineManager.on('status-changed', () => {
    const s = engineManager.status();
    send(IPC.ENGINE_STATUS_CHANGED, s);
    remoteServer?.broadcast({ type: 'engine:status-changed', payload: s });
  });
  // --- Per-model residency → per-session model-state coordinator (2026-07-14) ---
  // #1: when the last session using a model releases it, unload it immediately.
  nativeHost.setModelReleasedHandler((modelId) => { void engineManager.unloadModel(modelId); });
  // Join per-model residency (engine) with session→model (host): push each live
  // native session its bound model's state so ChatView can show the unloaded /
  // loading banner (#4/#5). Only push on change per session.
  // Signature includes loadedBytes so LOAD PROGRESS updates (state stays
  // 'loading' while bytes climb) are pushed, not just state transitions.
  const lastSessionModelState = new Map<string, string>();
  engineManager.on('models-changed', (models: EngineModelType[]) => {
    for (const m of models) {
      const payload = { modelId: m.id, state: m.state, sizeBytes: m.sizeBytes, loadedBytes: m.loadedBytes ?? null };
      const sig = `${m.state}:${m.loadedBytes ?? ''}`;
      for (const sessionId of nativeHost.sessionsForModel(m.id)) {
        if (lastSessionModelState.get(sessionId) === sig) continue;
        lastSessionModelState.set(sessionId, sig);
        const full = { sessionId, ...payload };
        sendForSession(sessionId, IPC.NATIVE_MODEL_STATE, full);
        remoteServer?.broadcast({ type: 'native:model-state', payload: full });
      }
    }
  });
  // Whole live per-model state (initial fetch for the coordinator's consumers).
  ipcMain.handle(IPC.ENGINE_MODELS, async () => engineManager.liveModels());
  // #2 create-time / swap-time memory guard; #4 [Reload Model].
  ipcMain.handle(IPC.MODELS_MEMORY_CHECK, async (_e, modelId: string) => modelManager.memoryCheck(modelId));
  ipcMain.handle(IPC.MODELS_LOAD, async (_e, modelId: string) => { await engineManager.loadModel(modelId); return true; });
  // --- Model manager IPC (Plan C) ---
  // Download progress fans out to every window + remotes on one push channel,
  // mirroring the engine install-progress emitter above.
  modelManager.on('download-progress', (p) => {
    send(IPC.MODELS_DOWNLOAD_PROGRESS, p);
    remoteServer?.broadcast({ type: 'models:download-progress', payload: p });
  });
  ipcMain.handle(IPC.ENGINE_SET_BACKEND, async (_e, backend: string) => { await engineManager.setBackend(backend as any); return engineManager.status(); });
  ipcMain.handle(IPC.ENGINE_SET_CONTEXT, async (_e, contextSize: number) => { await engineManager.setContext(contextSize); return engineManager.status(); });
  ipcMain.handle(IPC.MODELS_CURATED, async () => modelManager.curatedList());
  ipcMain.handle(IPC.MODELS_SEARCH, async (_e, query: string) => modelManager.search(query));
  ipcMain.handle(IPC.MODELS_QUANTS, async (_e, repo: string) => modelManager.quants(repo));
  ipcMain.handle(IPC.MODELS_DOWNLOAD, async (_e, repo: string, quant: any) => modelManager.download(repo, quant));
  ipcMain.handle(IPC.MODELS_DOWNLOAD_CANCEL, async (_e, downloadId: string) => { modelManager.cancel(downloadId); return true; });
  ipcMain.handle(IPC.MODELS_DELETE, async (_e, id: string) => { await engineManager.deleteModel(id); return true; });
  ipcMain.handle(IPC.MODELS_INSTALLED, async () => engineManager.installedModels());
  ipcMain.handle(IPC.ENDPOINTS_DETECT, async () =>
    detectEndpoints(fetch, ((await providerRegistry.list()) as any[])));
  // /clear and /compact both truncate or rewrite the JSONL. App.tsx listens
  // to detect compaction completion (pending → COMPACTION_COMPLETE).
  transcriptWatcher.on('transcript-shrink', (payload: any) => {
    sendForSession(payload.sessionId, IPC.TRANSCRIPT_SHRINK, payload);
    if (remoteServer) {
      remoteServer.broadcast({ type: 'transcript:shrink', payload });
    }
  });
  const topicWatchers = new Map<string, fs.FSWatcher | NodeJS.Timeout>();
  const lastTopics = new Map<string, string>();

  // Broadcast session rename to remote WebSocket clients + update SessionInfo
  function broadcastRename(desktopId: string, name: string) {
    const session = sessionManager.getSession(desktopId);
    if (session) session.name = name;
    remoteServer?.broadcast({ type: 'session:renamed', payload: { sessionId: desktopId, name } });
    remoteServer?.setLastTopic(desktopId, name);
    // Fan out a directory refresh so any renderer that reads session names
    // from WINDOW_DIRECTORY_UPDATED (buddy SessionPill, main SessionStrip)
    // picks up the new name. sendForSession(SESSION_RENAMED) only reaches
    // the session's owner + subscribers — the buddy only subscribes to its
    // ONE viewed session, so without this its dropdown shows stale names
    // for every OTHER session. getDirectory() is the lazy snapshot; emit
    // 'changed' triggers broadcastWindowState() in main.ts which rebuilds
    // and pushes it.
    windowRegistry?.emit('changed');
  }

  function readTopicFile(claudeSessionId: string): string | null {
    try {
      const content = fs.readFileSync(path.join(topicDir, `topic-${claudeSessionId}`), 'utf8').trim();
      return content || null;
    } catch {
      return null;
    }
  }

  const pendingWatchers = new Set<string>();

  function startWatching(desktopId: string, claudeId: string) {
    if (topicWatchers.has(desktopId) || pendingWatchers.has(desktopId)) return;
    pendingWatchers.add(desktopId);

    // Read initial value
    const initial = readTopicFile(claudeId);
    if (initial && initial !== 'New Session') {
      lastTopics.set(desktopId, initial);
      sendForSession(desktopId, IPC.SESSION_RENAMED, desktopId, initial);
      broadcastRename(desktopId, initial);
      // Conversation Store (Phase 2a): mirror the auto-title into the record.
      // Keyed by claudeId (the store's record id). This is the only sanctioned
      // title writer (carry-forward 5) — no user-rename path exists yet.
      noteTitleChanged(claudeId, initial);
    }

    const topicFilePath = path.join(topicDir, `topic-${claudeId}`);

    // Prefer fs.watch for efficiency; fall back to polling if watch fails
    // (e.g., on network filesystems or platforms with limited inotify)
    try {
      const watcher = fs.watch(topicFilePath, { persistent: false }, () => {
        const topic = readTopicFile(claudeId);
        if (topic && topic !== 'New Session' && topic !== lastTopics.get(desktopId)) {
          lastTopics.set(desktopId, topic);
          sendForSession(desktopId, IPC.SESSION_RENAMED, desktopId, topic);
          broadcastRename(desktopId, topic);
          noteTitleChanged(claudeId, topic); // Conversation Store (Phase 2a) title write-through
        }
      });
      watcher.on('error', () => {
        // File may not exist yet — fall back to polling
        watcher.close();
        startPolling(desktopId, claudeId);
      });
      topicWatchers.set(desktopId, watcher);
      pendingWatchers.delete(desktopId);
    } catch {
      // fs.watch not available or file doesn't exist yet — poll instead
      pendingWatchers.delete(desktopId);
      startPolling(desktopId, claudeId);
    }
  }

  function startPolling(desktopId: string, claudeId: string) {
    if (topicWatchers.has(desktopId)) return;
    const interval = setInterval(() => {
      const topic = readTopicFile(claudeId);
      if (topic && topic !== 'New Session' && topic !== lastTopics.get(desktopId)) {
        lastTopics.set(desktopId, topic);
        sendForSession(desktopId, IPC.SESSION_RENAMED, desktopId, topic);
        broadcastRename(desktopId, topic);
        noteTitleChanged(claudeId, topic); // Conversation Store (Phase 2a) title write-through
      }
    }, 2000);
    topicWatchers.set(desktopId, interval);
  }

  // Tear down the topic + transcript watchers for a desktop session. Shared
  // by the remap path (CC rotated its session id on /clear) and the
  // session-exit cleanup — the close()-vs-clearInterval discriminator is
  // subtle enough that two drifting copies would be a bug factory.
  function teardownSessionWatchers(desktopId: string): void {
    const watcher = topicWatchers.get(desktopId);
    if (watcher) {
      if (typeof (watcher as fs.FSWatcher).close === 'function') {
        (watcher as fs.FSWatcher).close();
      } else {
        clearInterval(watcher as NodeJS.Timeout);
      }
      topicWatchers.delete(desktopId);
      lastTopics.delete(desktopId);
    }
    transcriptWatcher.stopWatching(desktopId);
  }

  // Listen for hook events to extract the desktop→claude session ID mapping
  if (hookRelay) {
    hookRelay.on('hook-event', (event: { sessionId: string; payload: Record<string, unknown> }) => {
      const desktopId = event.sessionId; // _desktop_session_id (set by parseHookPayload)
      const claudeId = event.payload?.session_id as string;
      if (!desktopId || !claudeId) return;

      // Decide whether to (re)map this desktop session to a Claude session id.
      // Not set-once: Claude Code rotates its session id mid-PTY on `/clear`, so
      // we must follow that rotation — but ONLY from SessionStart events, since
      // subagent/tool hooks carry child session ids that would poison the map.
      // (payload.hook_event_name is CC's raw field, distinct from the
      // normalized event.type which coerces missing names to 'unknown'.)
      // /compact is safe here: it rewrites the SAME transcript file without
      // rotating the id (the transcript-shrink machinery depends on that), so
      // its SessionStart arrives with a matching id and resolves to 'ignore'.
      const current = sessionIdMap.get(desktopId);
      if (resolveMappingAction(current, claudeId, event.payload?.hook_event_name as string) !== 'adopt') return;

      // Remap (e.g. /clear rotated the CC session id): tear down the old
      // topic + transcript watchers before starting new ones. startWatching
      // OVERWRITES the topicWatchers entry, so without closing the old watcher
      // first we'd leak its FSWatcher/interval and keep broadcasting renames
      // from the stale topic file.
      // INVARIANT: this remap assumes the rotated transcript starts EMPTY
      // (true for /clear). If a future CC change rotates onto a non-empty
      // file, the offset-0 replay would append into an already-populated
      // chat timeline — the renderer would need a CLEAR_TIMELINE-equivalent
      // coupled to the remap.
      if (current) {
        teardownSessionWatchers(desktopId);
        // 2b: /clear rotates the CC session id WITHOUT firing session-exit, so the
        // pre-rotation claudeId's lease + its 30s renew timer would otherwise leak
        // (renewing a dead id every 30s until app quit). Release it here.
        // Idempotent + best-effort; release() never rejects, .catch guards a future change.
        void leaseWiring?.client.release(current).catch(() => { /* best-effort */ });
      }

      sessionIdMap.set(desktopId, claudeId);
      startWatching(desktopId, claudeId);

      // Start watching the transcript file for this session
      const sessionInfo = sessionManager.getSession(desktopId);
      if (sessionInfo) {
        transcriptWatcher.startWatching(desktopId, claudeId, sessionInfo.cwd);
        // Conversation Store (Phase 2a): tell the store this claude session's cwd
        // so its activity upserts carry projectName/originalPath (local truth).
        noteSessionStarted(claudeId, sessionInfo.cwd);
        // 2b Task 8: this device now owns the session — take the lease.
        // Fire-and-forget: a denied (ok:false) result would only mean another
        // device holds it, but the sanctioned resume path already ran takeover
        // BEFORE spawn, so we never block session start on the lease. acquire()
        // never rejects, but the .catch keeps a future change from leaking one.
        //
        // Gate on sync being ENABLED: leases coordinate CROSS-DEVICE writers, which
        // only exist for a synced conversation. Without this, every CC SessionStart
        // (even for users who never enabled sync) took an optimistic local hold with
        // a 30s renew timer writing Personal/Leases/*.json — wasteful and creates a
        // Leases/ dir for no reason. Release on session-exit stays UNCONDITIONAL
        // (idempotent — harmless if never acquired) so a session that acquired while
        // sync was on still releases if sync later flips off.
        if (isSyncSpacesEnabled()) void leaseWiring?.client.acquire(claudeId).catch(() => { /* never-block */ });
      }
    });
  }

  // Stop watching when a session is destroyed
  sessionManager.on('session-exit', (sessionId: string) => {
    teardownSessionWatchers(sessionId);
    // Clean up context + session stats cache files
    const claudeId = sessionIdMap.get(sessionId);
    if (claudeId) {
      fs.unlink(path.join(os.homedir(), '.claude', `.context-${claudeId}`), () => {});
      fs.unlink(path.join(os.homedir(), '.claude', `.session-stats-${claudeId}.json`), () => {});
      // 2b (Bug 2 Part 2): release the conversation-store materialize guard +
      // apply any peer version now that this session ended — no restart needed.
      // Resolved from the map BEFORE the delete below, so the claude id is known.
      noteSessionEnded(claudeId);
      // 2b Task 8: drop our lease so another device can acquire. Idempotent +
      // best-effort; release() never rejects, .catch guards a future change.
      void leaseWiring?.client.release(claudeId).catch(() => { /* best-effort */ });
    }
    sessionIdMap.delete(sessionId);
    lastAttentionBySession.delete(sessionId);
    // Drop the last-known status values so buildStatusData doesn't keep
    // broadcasting chips for a session that's gone.
    delete lastContextByDesktopId[sessionId];
    delete lastGitBranchByDesktopId[sessionId];
    delete lastSessionStatsByDesktopId[sessionId];
  });

  // Set a named flag on a session (complete, priority, helpful). Persists in
  // the Conversation Store (~/YouCoded/Personal/Conversations/) via
  // noteFlagChanged, and broadcasts SESSION_META_CHANGED so any open resume
  // browser refreshes. Accepts either a Claude session ID (as stored in the
  // store) or a desktop session ID — the desktop ID is resolved via
  // sessionIdMap. Unknown flag names are rejected server-side so a typo
  // surfaces as an error rather than silently writing dead data.
  ipcMain.handle(IPC.SESSION_SET_FLAG, async (_event, sessionId: string, flag: string, value: boolean) => {
    if (!SESSION_FLAG_NAMES.includes(flag as SessionFlagName)) {
      return { ok: false, error: `unknown flag: ${flag}` };
    }
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    try {
      // Plan 2c: flags are STORE-ONLY now. The legacy conversation-index
      // dual-write (svc.setSessionFlag) was removed — the Conversation Store is
      // the sole authority for flags; the frozen legacy index is read-only for
      // residual legacy-only rows. safeWrite semantics live inside noteFlagChanged.
      //
      // Phantom-record gate (review fix 5): only write when `resolved` is
      // actually a CLAUDE id. Either the mapping is known (sessionId was a
      // desktop id → resolved is the mapped claude id), or sessionId is NOT a
      // live desktop session (Resume Browser rows pass claude ids for past
      // sessions — safe to write as-is). Without this gate, flagging a LIVE
      // session before its SessionStart hook establishes the mapping would
      // seed a flag-only record keyed by the desktop randomUUID — UUID-shaped
      // (passes the store's id guard), synced to every device, and never
      // pruned (flagged records are deliberately kept). When gated out, the
      // flag re-applies once the SessionStart hook establishes the mapping and
      // the user (or a re-flag) drives it again — flags are store-only now,
      // so there's no legacy index still catching it in the meantime.
      if (sessionIdMap.has(sessionId) || !sessionManager.getSession(sessionId)) {
        noteFlagChanged(resolved, flag, !!value);
      }
      const payload = { flag, value: !!value };
      sendForSession(resolved, IPC.SESSION_META_CHANGED, resolved, payload);
      remoteServer?.broadcast({
        type: IPC.SESSION_META_CHANGED,
        payload: { sessionId: resolved, ...payload },
      });
      return { ok: true };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // --- Tag registry CRUD ---
  ipcMain.handle(IPC.TAGS_LIST, async () => {
    const reg = getTagRegistry();
    if (!reg) return [];
    try { return await reg.list(); } catch { return []; }
  });

  ipcMain.handle(IPC.TAGS_CREATE, async (_e, label: string, color: string) => {
    const reg = getTagRegistry();
    if (!reg) return { ok: false, error: 'tag registry unavailable' };
    const c: TagColor = isTagColor(color) ? color : 'tag-gray';
    try {
      const tag = await reg.create(String(label ?? ''), c);
      remoteServer?.broadcast({ type: IPC.TAGS_CHANGED, payload: {} });
      // Notify local windows too (buddy window + main share the registry).
      broadcastToAllWindows(IPC.TAGS_CHANGED, {});
      return { ok: true, tag };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  ipcMain.handle(IPC.TAGS_UPDATE, async (_e, id: string, patch: { label?: string; color?: string; archived?: boolean }) => {
    const reg = getTagRegistry();
    if (!reg) return { ok: false, error: 'tag registry unavailable' };
    const clean: { label?: string; color?: TagColor; archived?: boolean } = {};
    if (patch?.label !== undefined) clean.label = String(patch.label);
    if (patch?.color !== undefined) clean.color = isTagColor(patch.color) ? patch.color : 'tag-gray';
    if (patch?.archived !== undefined) clean.archived = !!patch.archived;
    try {
      const tag = await reg.update(String(id), clean);
      remoteServer?.broadcast({ type: IPC.TAGS_CHANGED, payload: {} });
      broadcastToAllWindows(IPC.TAGS_CHANGED, {});
      return { ok: true, tag };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  ipcMain.handle(IPC.TAGS_DELETE, async (_e, id: string) => {
    const reg = getTagRegistry();
    if (!reg) return { ok: false, error: 'tag registry unavailable' };
    try {
      await reg.delete(String(id));
      remoteServer?.broadcast({ type: IPC.TAGS_CHANGED, payload: {} });
      broadcastToAllWindows(IPC.TAGS_CHANGED, {});
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Apply/remove a tag on a session (writes tag:<id> into the store flag map) ---
  ipcMain.handle(IPC.SESSION_SET_TAG, async (_e, sessionId: string, tagId: string, value: boolean) => {
    if (typeof tagId !== 'string' || !tagId.startsWith('tag_')) {
      return { ok: false, error: `invalid tag id: ${tagId}` };
    }
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    const key = tagFlagKey(tagId);
    try {
      // Same phantom-record gate as SESSION_SET_FLAG: only write the store when
      // `resolved` is a known CLAUDE id or a non-live session.
      if (sessionIdMap.has(sessionId) || !sessionManager.getSession(sessionId)) {
        noteFlagChanged(resolved, key, !!value);
      }
      const payload = { flag: key, value: !!value };
      sendForSession(resolved, IPC.SESSION_META_CHANGED, resolved, payload);
      remoteServer?.broadcast({ type: IPC.SESSION_META_CHANGED, payload: { sessionId: resolved, ...payload } });
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Set/clear a session note ---
  ipcMain.handle(IPC.SESSION_SET_NOTE, async (_e, sessionId: string, note: string) => {
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    const text = String(note ?? '');
    if (text.length > 8000) return { ok: false, error: 'note exceeds 8000 characters' };
    try {
      if (sessionIdMap.has(sessionId) || !sessionManager.getSession(sessionId)) {
        noteSessionNote(resolved, text);
      }
      const payload = { note: text };
      sendForSession(resolved, IPC.SESSION_META_CHANGED, resolved, payload);
      remoteServer?.broadcast({ type: IPC.SESSION_META_CHANGED, payload: { sessionId: resolved, ...payload } });
      return { ok: true };
    } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  });

  // --- Read a live/past session's applied tags + note (session:browse excludes
  // live sessions, so Plan B's in-session StatusBar element reads meta here) ---
  ipcMain.handle(IPC.SESSION_GET_META, async (_e, sessionId: string) => {
    const store = getConversationStore();
    if (!store) return { tags: [], note: '' };
    const resolved = sessionIdMap.get(sessionId) || sessionId;
    try {
      const rec = await store.get('claude', resolved);
      if (!rec) return { tags: [], note: '' };
      const tags: string[] = [];
      for (const [k, v] of Object.entries(rec.flags)) {
        if (v.value && k.startsWith('tag:')) tags.push(k.slice(4));
      }
      return { tags, note: rec.note || '' };
    } catch { return { tags: [], note: '' }; }
  });

  // --- Sync management ---
  // Control plane for YouCoded toolkit sync — reads state files written
  // by sync.sh / session-start.sh and triggers sync via the existing scripts.
  ipcMain.handle(IPC.SYNC_GET_STATUS, () => getSyncStatus());
  ipcMain.handle(IPC.SYNC_GET_CONFIG, () => getSyncConfig());
  ipcMain.handle(IPC.SYNC_SET_CONFIG, (_e, updates) => setSyncConfig(updates));
  ipcMain.handle(IPC.SYNC_FORCE, () => forceSync());
  ipcMain.handle(IPC.SYNC_GET_LOG, (_e, lines) => getSyncLog(lines));
  ipcMain.handle(IPC.SYNC_DISMISS_WARNING, (_e, warning) => dismissWarning(warning));

  // Cross-device sync spaces (spec 2026-07-03) — folder-based sync engine,
  // distinct from the legacy sync:* backup control plane above. The service
  // module owns the singleton engine/manager/roots.
  ipcMain.handle(IPC.SYNC_SPACES_STATUS, () => syncSpacesStatus());
  ipcMain.handle(IPC.SYNC_SPACES_ENABLE, (_e, enabled: boolean) => syncSpacesEnable(!!enabled));
  // spaceId (optional) narrows the sync to one space for the Project View
  // "Sync now" button; SyncPanel calls with no arg = sync everything.
  ipcMain.handle(IPC.SYNC_SPACES_SYNC_NOW, (_e, spaceId?: string) =>
    syncSpacesSyncNow(spaceId ? String(spaceId) : undefined));
  ipcMain.handle(IPC.SYNC_SPACES_CREATE_PROJECT, (_e, name: string) => syncSpacesCreateProject(String(name ?? '')));
  ipcMain.handle(IPC.SYNC_SPACES_IMPORT_PROJECT, (_e, sourcePath: string, name: string) =>
    // Live-cwd guard input: the folder must not move under a running session.
    syncSpacesImportProject(String(sourcePath ?? ''), String(name ?? ''),
      sessionManager.listSessions().filter(s => s.status !== 'destroyed').map(s => s.cwd)));
  // Cross-device rename (display-name only) + stop-syncing (2026-07-12).
  ipcMain.handle(IPC.SYNC_SPACES_RENAME_PROJECT, (_e, p: { name: string; displayName: string }) =>
    syncSpacesRenameProject(String(p?.name ?? ''), String(p?.displayName ?? '')));
  ipcMain.handle(IPC.SYNC_SPACES_STOP_PROJECT, (_e, p: { name: string }) =>
    syncSpacesStopProject(String(p?.name ?? '')));

  // Conversation-lease takeover (Plan 2b Task 9). Thin passthroughs to the lease
  // client (query) and the requester flow (takeover/force) built in main.ts.
  // When lease wiring is absent (sync disabled), every handler degrades to a
  // "free / error" answer so the renderer's resume gate proceeds unblocked
  // (spec §3 never-block).
  ipcMain.handle(IPC.SYNC_SPACES_LEASE_QUERY, (_e, p: { claudeSessionId: string }) =>
    leaseWiring?.client.query(String(p?.claudeSessionId ?? '')) ?? { held: false, source: 'none' });
  ipcMain.handle(IPC.SYNC_SPACES_LEASE_TAKEOVER, (_e, p: { claudeSessionId: string }) =>
    leaseWiring?.requester.takeover(String(p?.claudeSessionId ?? '')) ?? { outcome: 'error' });
  ipcMain.handle(IPC.SYNC_SPACES_LEASE_FORCE, (_e, p: { claudeSessionId: string }) =>
    leaseWiring?.requester.force(String(p?.claudeSessionId ?? '')) ?? { ok: false });

  // Device registry (Plan 2b spec §10a): the "Your devices" list (Task 12 UI
  // consumes these). self:true marks the current machine so the UI can label it.
  ipcMain.handle(IPC.SYNC_SPACES_LIST_DEVICES, () => {
    const pr = getManagedRoots()?.personalRoot;
    if (!pr) return [];
    const selfId = leaseWiring?.deviceId ?? '';
    return readDevices(pr).map((d) => ({ ...d, self: d.id === selfId }));
  });
  ipcMain.handle(IPC.SYNC_SPACES_RENAME_DEVICE, async (_e, p: { id: string; name: string }) => {
    const pr = getManagedRoots()?.personalRoot;
    if (!pr) return { ok: false };
    try { await renameDevice(pr, String(p?.id ?? ''), String(p?.name ?? '')); return { ok: true }; }
    catch { return { ok: false }; }
  });

  // Connect-GitHub modal (device-flow auth). ONE orchestrator holds the single
  // in-flight flow; its emitDone fans the connect-done push out to BOTH the
  // Electron windows (send) and remote clients (remoteServer.broadcast) — the
  // same dual path as session:moved. The access token never enters this payload.
  const githubConnect = createGithubConnect((payload) => {
    send(IPC.GITHUB_CONNECT_DONE, payload);
    remoteServer?.broadcast({ type: IPC.GITHUB_CONNECT_DONE, payload });
  });
  // Register as the process-wide singleton so remote clients drive the SAME flow.
  setGithubConnect(githubConnect);
  ipcMain.handle(IPC.GITHUB_STATUS, () => detectGh());
  ipcMain.handle(IPC.GITHUB_CONNECT_START, () => githubConnect.start());
  ipcMain.handle(IPC.GITHUB_CONNECT_CANCEL, () => { githubConnect.cancel(); return { ok: true }; });
  ipcMain.handle(IPC.GITHUB_INSTALL_GH, () => installGh());

  // V2: Per-instance backend management (storage backends + multi-instance support)
  ipcMain.handle('sync:add-backend', (_e, instance) => addBackend(instance));
  ipcMain.handle('sync:remove-backend', (_e, id) => removeBackend(id));
  ipcMain.handle('sync:update-backend', (_e, id, updates) => updateBackend(id, updates));
  ipcMain.handle('sync:push-backend', (_e, id) => pushBackend(id));
  // sync:pull-backend ("Download now") was removed in sync-legacy-demolition.

  // Open a backend's remote location in the default browser/file explorer
  ipcMain.handle('sync:open-folder', async (_e, id: string) => {
    const { shell } = require('electron');
    const config = await getSyncConfig();
    const backend = config.backends.find((b: any) => b.id === id);
    if (!backend) return;

    switch (backend.type) {
      case 'drive': {
        // Deep-link to the actual sync folder on Google Drive by resolving its
        // file ID via rclone, then opening https://drive.google.com/drive/folders/<id>.
        // Falls back to the generic Drive homepage if rclone or the folder lookup fails.
        const rcloneRemote = backend.config?.rcloneRemote || 'gdrive';
        const driveRoot = backend.config?.DRIVE_ROOT || 'Claude';
        const parentPath = `${rcloneRemote}:${driveRoot}/Backup`;
        const targetName = 'personal';
        const fallbackUrl = 'https://drive.google.com';
        try {
          const stdout: string = await new Promise((resolve, reject) => {
            execFile(
              'rclone',
              ['lsjson', parentPath, '--dirs-only'],
              { timeout: 15000 },
              (err, out) => (err ? reject(err) : resolve(String(out || ''))),
            );
          });
          const entries = JSON.parse(stdout) as Array<{ Name: string; ID?: string }>;
          const match = entries.find((e) => e.Name === targetName && e.ID);
          if (match?.ID) {
            shell.openExternal(`https://drive.google.com/drive/folders/${match.ID}`);
          } else {
            shell.openExternal(fallbackUrl);
          }
        } catch {
          shell.openExternal(fallbackUrl);
        }
        break;
      }
      case 'github': {
        const repoUrl = backend.config?.PERSONAL_SYNC_REPO || '';
        if (repoUrl) shell.openExternal(repoUrl);
        break;
      }
      case 'icloud': {
        const icloudPath = backend.config?.ICLOUD_PATH || '';
        if (icloudPath) shell.openPath(icloudPath);
        break;
      }
    }
  });

  // Guided setup wizard: prerequisite detection, tool installation, OAuth, repo creation.
  // Each handler runs one specific command — no generic shell exec.
  ipcMain.handle('sync:setup:check-prereqs', (_e, backend) => checkSyncPrereqs(backend));
  ipcMain.handle('sync:setup:install-rclone', () => installRclone());
  ipcMain.handle('sync:setup:check-gdrive', () => checkGdriveRemote());
  ipcMain.handle('sync:setup:auth-gdrive', () => authGdrive());
  ipcMain.handle('sync:setup:auth-github', () => authGithub());
  ipcMain.handle('sync:setup:create-repo', (_e, repoName) => createGithubRepo(repoName));

  // --- Permission response (blocking hooks + native asks) ---
  // Native asks share the channel; ids are 'native-'-prefixed so routing is
  // exact — try the native broker first, then fall through to hookRelay (which
  // may be absent in native-only sessions).
  ipcMain.handle(IPC.PERMISSION_RESPOND, async (_event, requestId: string, decision: object) => {
    if (nativeHost.respondPermission(requestId, decision as Record<string, unknown>)) return true;
    return hookRelay ? hookRelay.respond(requestId, decision) : false;
  });

  // --- Settings → Development feature handlers (see dev-tools.ts) ---

  ipcMain.handle(IPC.DEV_LOG_TAIL, async (_event, maxLines: number) => {
    // Return the last N lines of the app log, redacted, for the bug-report flow.
    return readLogTail(typeof maxLines === 'number' ? maxLines : 200);
  });

  ipcMain.handle(IPC.DEV_DIAGNOSTICS, async () => {
    // Environment snapshot (git/claude paths, ~/.claude perms, marketplace
    // cache state, network reachability) prepended to the log tail in the
    // bug-report flow. Captures the most common Mac/Linux install-failure
    // signals that the plain log doesn't cover.
    return gatherDiagnostics();
  });

  ipcMain.handle(IPC.DEV_SUMMARIZE_ISSUE, async (_event, args) => {
    // Shell out to claude -p to produce a structured summary; falls back gracefully.
    return summarizeIssue(args);
  });

  ipcMain.handle(IPC.DEV_SUBMIT_ISSUE, async (_event, args) => {
    // Use gh CLI when authed; otherwise return a prefilled GitHub URL for browser fallback.
    return submitIssue(args);
  });

  ipcMain.handle(IPC.DEV_INSTALL_WORKSPACE, async (event) => {
    // Clone (or update) ~/youcoded-dev, stream progress lines back to the renderer,
    // and register the path as a project folder on success.
    const send = (line: string) => {
      event.sender.send(IPC.DEV_INSTALL_PROGRESS, line);
    };
    try {
      const result = await installWorkspace(send);
      // Register the workspace as a known project folder.
      // readFolders / writeFolders / SavedFolder come from the ./saved-folders
      // module imported at the top of this file (no-arg = default store path).
      try {
        const normalized = path.resolve(result.path);
        const folders = readFolders();
        if (!folders.some((f) => path.resolve(f.path) === normalized)) {
          const entry: SavedFolder = {
            path: normalized,
            nickname: path.basename(normalized),
            addedAt: Date.now(),
          };
          folders.unshift(entry);
          writeFolders(folders);
        }
      } catch (e) {
        log('WARN', 'dev', 'folders.add post-install failed', { error: String(e) });
      }
      return result;
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
  });

  ipcMain.handle(IPC.DEV_OPEN_SESSION_IN, async (_event, args: { cwd: string; initialInput?: string }) => {
    // Delegate to the exported helper so the logic is independently testable.
    return openDevSessionIn(args, { defaultsPrefPath, sessionManager, homedir: os.homedir });
  });

  // --- Artifact viewer IPC handlers ---
  // All request-response handlers plus the CHANGED push event (emitted via
  // webContents.send() inside SAVE and APPEND_VERSION — no ipcMain.handle needed
  // for push events).

  // Fix: data-flow gap — the renderer Tracker calls this when it observes a
  // Write/Edit/MultiEdit transcript event so the central index is populated and
  // artifacts appear in the Session Drawer even before the user opens it.
  // ensureProject and applyGitTreatment are both idempotent.
  ipcMain.handle(ARTIFACT_IPC.APPEND_VERSION, async (
    _e,
    projectRoot: string,
    sessionId: string,
    args: {
      path: string;
      kind: 'internal' | 'external';
      absolutePath: string | null;
      type: 'create' | 'edit' | 'delete' | 'read';
      author: 'agent' | 'user';
    }
  ) => {
    const { project } = await ensureProject(CLAUDE_DIR, projectRoot, sessionId);
    await applyGitTreatment(projectRoot);
    const result = await appendVersion(projectRoot, project.id, project.name, {
      path: args.path,
      kind: args.kind,
      absolutePath: args.absolutePath,
      sessionId,
      type: args.type,
      author: args.author,
    });
    // A newly created/edited file may also be a discovered doc — drop the cached
    // disk scan so it shows up on the next LIST_PROJECT without waiting for TTL.
    invalidateDiscoveryCache(projectRoot);
    // Broadcast the REAL artifact id so listeners can match it — the previous
    // artifactId: null was dropped by every consumer, which meant the
    // ActiveArtifactView "Claude also edited this file" conflict banner could
    // never fire for agent edits (its entire purpose).
    webContents.getAllWebContents().forEach((wc) =>
      wc.send(ARTIFACT_IPC.CHANGED, {
        projectRoot,
        artifactId: result.artifactId,
        kind: args.type,
        by: args.author,
      })
    );
    return { ok: result.committed, project };
  });

  ipcMain.handle(ARTIFACT_IPC.RENAME, async (
    _e,
    projectRoot: string,
    artifactId: string,
    newName: string
  ) => {
    const result = await renameArtifact(projectRoot, artifactId, newName);
    if (result.ok) {
      // Broadcast so every open window's artifact UI re-lists with the new name.
      webContents.getAllWebContents().forEach((wc) =>
        wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId, kind: 'rename', by: 'user' })
      );
    }
    return result;
  });

  // Remove a tracking RECORD (never the file). See removeArtifactRecord for
  // semantics — Session Drawer per-row remove.
  ipcMain.handle(ARTIFACT_IPC.REMOVE_RECORD, async (
    _e,
    projectRoot: string,
    artifactId: string
  ) => {
    const result = await removeArtifactRecord(projectRoot, artifactId);
    if (result.ok) {
      webContents.getAllWebContents().forEach((wc) =>
        wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId, kind: 'remove', by: 'user' })
      );
    }
    return result;
  });

  ipcMain.handle(ARTIFACT_IPC.LIST_SESSION, async (_e, sessionId: string, projectRoot: string) => {
    const sidecar = await readSidecar(projectRoot);
    if (!sidecar || 'corrupted' in sidecar) return { ok: true, artifacts: [] };
    // Filter to artifacts touched by this session
    const result = sidecar.artifacts.filter((a) =>
      a.versions.some((v) => v.sessionId === sessionId)
    );
    return { ok: true, artifacts: result };
  });

  // Project View IPC — list project-scoped conversations, their history, git
  // repo info, and the discovered context files (CLAUDE.md, rules, etc.).
  // Main-process modules already exist; these handlers just wire them to IPC.
  ipcMain.handle(PROJECT_IPC.LIST_CONVERSATIONS, async (_e, projectPath: string) => {
    return { ok: true, conversations: await listProjectConversations(projectPath) };
  });
  ipcMain.handle(PROJECT_IPC.CONVERSATION_HISTORY, async (_e, projectPath: string, sessionId: string, count: number, all: boolean) => {
    return { ok: true, messages: await projectConversationHistory(projectPath, sessionId, count ?? 20, !!all) };
  });
  ipcMain.handle(PROJECT_IPC.REPO_INFO, async (_e, projectPath: string) => {
    return { ok: true, ...(await getRepoInfo(projectPath)) };
  });
  ipcMain.handle(PROJECT_IPC.LIST_CONTEXT, async (_e, projectPath: string) => {
    return { ok: true, groups: await listContext(projectPath) };
  });
  ipcMain.handle(PROJECT_IPC.READ_CONTEXT_FILE, async (_e, projectPath: string, absolutePath: string) => {
    return readContextFile(projectPath, absolutePath);
  });
  ipcMain.handle(PROJECT_IPC.WRITE_CONTEXT_FILE, async (_e, projectPath: string, absolutePath: string, content: string) => {
    return writeContextFile(projectPath, absolutePath, content);
  });

  // CORE PRINCIPLE helpers — TWO distinct counts, never conflated:
  //
  //   countArtifacts → ARTIFACTS: files Claude directly created/edited (sidecar
  //     tracked, internal or included-external), non-deleted AND still on disk
  //     (orphans excluded). This is what the Artifacts tab shows with "Show
  //     deleted" OFF. NO on-disk discovery is mixed in here.
  //   countAllFiles → ALL FILES: the count of the project folder's real documents
  //     on disk (the full-browser view), independent of what Claude touched.
  //
  // Each is the single source of truth for its number, read identically by the
  // hero, the segment badges, and the switcher row.
  async function countArtifacts(projectRoot: string): Promise<number> {
    const sidecar = await readSidecar(projectRoot);
    if (!sidecar || 'corrupted' in sidecar) return 0;
    // Visible-with-deleted-OFF tracked set (see visible-artifacts.ts for the
    // full rules: Claude's work + pinned, minus excluded).
    const visible = trackedArtifacts(sidecar.artifacts as any[], sidecar.manualIncludes, sidecar.manualExcludes, projectRoot)
      .filter((a: any) => a.status !== 'deleted');
    // Drop orphans — files marked 'active' but bash-rm'd off disk (CC has no
    // Delete tool, so this is the common case). fs.access in parallel is cheap.
    const alive = await Promise.all(visible.map(async (a: any) => {
      const full = a.kind === 'internal' ? path.join(projectRoot, a.path) : a.absolutePath!;
      try { await fs.promises.access(full); return true; } catch { return false; }
    }));
    return alive.filter(Boolean).length;
  }

  // ALL FILES = on-disk discovery UNIONed with any tracked artifact that exists on
  // disk but discovery didn't reach (e.g. an artifact inside a skipped nested
  // sub-repo). The union GUARANTEES All files is a SUPERSET of Artifacts — it is
  // nonsensical for a project to report fewer "all files" than "artifacts".
  async function projectAllFiles(projectRoot: string): Promise<{ files: any[]; truncated: boolean }> {
    let scan: { files: any[]; truncated: boolean };
    try { scan = await discoverProjectFiles(projectRoot); }
    catch { scan = { files: [], truncated: false }; }
    const seen = new Set(scan.files.map((f: any) => f.path));
    const sidecar = await readSidecar(projectRoot);
    const extra: any[] = [];
    if (sidecar && !('corrupted' in sidecar)) {
      const candidates = sidecar.artifacts.filter((a) => {
        if (a.kind !== 'internal' || a.status === 'deleted') return false;
        return !seen.has(canonicalize(a.path, projectRoot));
      });
      // Orphan check (skip artifacts bash-rm'd off disk) in PARALLEL — same
      // pattern as countArtifacts above; the serial version added a round-trip
      // of latency per artifact on sidecars with many entries.
      const alive = await Promise.all(candidates.map(async (a) => {
        try { await fs.promises.access(path.join(projectRoot, a.path)); return true; }
        catch { return false; }
      }));
      candidates.forEach((a, i) => {
        if (!alive[i]) return;
        const rel = canonicalize(a.path, projectRoot);
        if (seen.has(rel)) return; // two sidecar entries can canonicalize to one path
        seen.add(rel);
        // Present as a browser entry (discovered shape) so the All files tab treats
        // it uniformly (no existence re-check; opens via the path-fallback GET).
        extra.push({
          id: rel, path: rel, kind: 'internal', absolutePath: null,
          lastModified: a.lastModified ?? '', status: 'active',
          versions: [], comments: [], tags: [], discovered: true,
        });
      });
    }
    return { files: [...scan.files, ...extra], truncated: scan.truncated };
  }

  // A "gated" root is the user's whole home directory or a drive/filesystem
  // root — trees so large that discovery ALWAYS hits its caps, making the
  // resulting list/count an arbitrary, run-to-run-varying sample. Rather than
  // show garbage numbers by default (and burn ~1.5s of directory I/O every
  // time the switcher computes counts — "Home" is always in the list), the All
  // files section shows a "Browse anyway?" gate and counts show "—". The gate
  // is about honesty, not safety: the scan itself is hard-bounded either way.
  function isGatedRoot(projectRoot: string): boolean {
    const canon = canonicalize(projectRoot, null);
    if (canon === canonicalize(os.homedir(), null)) return true;
    return /^[a-z]:?$/.test(canon) || canon === '/' || /^[a-z]:\/$/.test(canon);
  }

  async function countAllFiles(projectRoot: string): Promise<{ count: number; truncated: boolean } | null> {
    if (isGatedRoot(projectRoot)) return null; // gated — no scan, no fake number
    try {
      const r = await projectAllFiles(projectRoot);
      return { count: r.files.length, truncated: r.truncated };
    } catch { return { count: 0, truncated: false }; }
  }

  // LIST_PROJECT → ARTIFACTS ONLY. Returns the tracked sidecar artifacts (internal
  // always; external only if manually included). Deleted ones are INCLUDED so the
  // Artifacts tab's "Show deleted" toggle works; the renderer filters them. NO
  // on-disk discovery is merged in — that is LIST_ALL_FILES's job (the split is the
  // core principle). visibleCount (withCount) is the authoritative non-deleted,
  // on-disk artifact count shared with the hero + switcher.
  ipcMain.handle(ARTIFACT_IPC.LIST_PROJECT, async (_e, projectId: string, opts?: { withCount?: boolean }) => {
    const projects = await listProjects(CLAUDE_DIR);
    const p = projects.find((x) => x.id === projectId);
    // Synth (saved-folder) projects use their canonical PATH as id and have no
    // index entry — fall back to reading the sidecar at that path so their
    // artifacts resolve too. A bogus id simply yields no sidecar.
    const projectRoot = p ? p.path : projectId;
    const sidecar = await readSidecar(projectRoot);

    let tracked: any[] = [];
    if (sidecar && !('corrupted' in sidecar)) {
      // Shared predicate — see visible-artifacts.ts for the full rules.
      tracked = trackedArtifacts(sidecar.artifacts as any[], sidecar.manualIncludes, sidecar.manualExcludes, projectRoot);
    }

    const visibleCount = opts?.withCount ? await countArtifacts(projectRoot) : undefined;
    return {
      ok: true,
      artifacts: tracked,
      ...(visibleCount !== undefined ? { visibleCount } : {}),
    };
  });

  // LIST_ALL_FILES → ALL FILES. The project folder's real documents on disk (the
  // full-browser view). Pure discovery — bounded, deterministic (stops at nested
  // git repos), cached. Independent of the sidecar / what Claude touched, so a
  // Claude-authored doc legitimately appears in BOTH Artifacts and All files.
  // Gated roots (home dir / drive root) return { gated: true } with no scan
  // unless opts.force — the tab renders a "Browse anyway?" gate (see
  // isGatedRoot above for WHY).
  ipcMain.handle(ARTIFACT_IPC.LIST_ALL_FILES, async (_e, projectId: string, opts?: { force?: boolean }) => {
    const projects = await listProjects(CLAUDE_DIR);
    const p = projects.find((x) => x.id === projectId);
    const projectRoot = p ? p.path : projectId;
    if (isGatedRoot(projectRoot) && !opts?.force) {
      return { ok: true, files: [], truncated: false, gated: true };
    }
    const r = await projectAllFiles(projectRoot);
    return { ok: true, files: r.files, truncated: r.truncated };
  });

  ipcMain.handle(ARTIFACT_IPC.GET, async (_e, projectRoot: string, artifactId: string) => {
    const sidecar = await readSidecar(projectRoot);
    const artifact = (sidecar && !('corrupted' in sidecar))
      ? sidecar.artifacts.find((a) => a.id === artifactId)
      : undefined;

    let fullPath: string;
    if (artifact) {
      fullPath = artifact.kind === 'internal'
        ? path.join(projectRoot, artifact.path)
        : artifact.absolutePath!;
    } else {
      // Discovered (on-disk) file: the id IS a canonical relative path. Resolve
      // it inside the project root and refuse anything that escapes (traversal
      // guard) so this can't be used to read arbitrary files.
      const resolved = path.resolve(projectRoot, artifactId);
      const root = path.resolve(projectRoot);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        return { ok: false, error: 'artifact-not-found' };
      }
      fullPath = resolved;
    }

    let content: string | null = null;
    try {
      content = await fs.promises.readFile(fullPath, 'utf8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
      // File is missing — return orphan signal
    }
    return { ok: true, artifact: artifact ?? null, content, orphan: content === null };
  });

  // Read a file as base64 for the binary viewers (xlsx/docx/pdf/image). The
  // renderer can't fetch a file:// URL from the http(dev)/app(prod) origin, so
  // bytes come through IPC.
  //
  // SECURITY: unlike openPath (which only launches a local app and returns
  // nothing), this IPC RETURNS file contents — and on remote-access setups it is
  // reachable over the WebSocket from a remote browser. So reads are restricted
  // to (a) the user's known project roots (saved folders + central-index
  // projects) and (b) tracked external artifact paths (temp-dir files the
  // session drawer legitimately shows), with well-known secret locations
  // (.ssh, .netrc, .credentials.json, …) refused even inside those roots.
  // Pure decision logic + tests live in artifacts/read-binary-access.ts.
  const READ_BINARY_MAX_BYTES = 50 * 1024 * 1024; // 50 MB — base64 inflates 33%, and it all transits IPC/WS
  ipcMain.handle(ARTIFACT_IPC.READ_BINARY, async (_e, absolutePath: string) => {
    if (typeof absolutePath !== 'string' || absolutePath.length === 0) {
      return { ok: false, error: 'no path' };
    }
    try {
      const canon = canonicalize(absolutePath, null);
      // Known roots: saved folders (the session-creation picker) + every
      // central-index project path.
      const roots = [
        ...readFolders().map((f) => canonicalize(f.path, null)),
        ...(await listProjects(CLAUDE_DIR)).map((p) => canonicalize(p.path, null)),
      ];
      let verdict = evaluateBinaryRead(canon, roots, new Set());
      if (verdict === 'outside-roots') {
        // Second pass (rare): collect tracked EXTERNAL artifact paths + manual
        // includes from each root's sidecar — covers e.g. a temp-dir xlsx.
        const tracked = new Set<string>();
        for (const root of roots) {
          const sidecar = await readSidecar(root).catch(() => null);
          if (!sidecar || 'corrupted' in sidecar) continue;
          for (const a of sidecar.artifacts) {
            if (a.kind === 'external' && a.absolutePath) tracked.add(canonicalize(a.absolutePath, null));
          }
          for (const inc of sidecar.manualIncludes) tracked.add(canonicalize(inc.path, null));
        }
        verdict = evaluateBinaryRead(canon, roots, tracked);
      }
      if (verdict !== 'allowed') return { ok: false, error: 'not-allowed' };

      // Size gate before reading — a huge file would freeze the renderer (and
      // the WS transport) long before the viewer could reject it.
      const st = await fs.promises.stat(absolutePath);
      if (st.size > READ_BINARY_MAX_BYTES) return { ok: false, error: 'too-large' };

      const buf = await fs.promises.readFile(absolutePath);
      return { ok: true, base64: buf.toString('base64') };
    } catch (e: any) {
      return { ok: false, error: e?.code === 'ENOENT' ? 'orphan' : String(e?.message ?? e) };
    }
  });

  ipcMain.handle(ARTIFACT_IPC.SAVE, async (
    _e,
    projectRoot: string,
    projectId: string,
    projectName: string,
    artifactId: string,
    newContent: string,
    sessionId: string
  ) => {
    const sidecar = await readSidecar(projectRoot);
    const artifact = (sidecar && !('corrupted' in sidecar))
      ? sidecar.artifacts.find((a) => a.id === artifactId)
      : undefined;

    if (artifact) {
      const fullPath = artifact.kind === 'internal'
        ? path.join(projectRoot, artifact.path)
        : artifact.absolutePath!;
      // Atomic write: write to .tmp then rename, so the original is never half-written
      await fs.promises.writeFile(fullPath + '.tmp', newContent, 'utf8');
      await fs.promises.rename(fullPath + '.tmp', fullPath);
      await appendVersion(projectRoot, projectId, projectName, {
        path: artifact.path,
        kind: artifact.kind,
        absolutePath: artifact.absolutePath,
        sessionId,
        type: 'edit',
        author: 'user',
      });
      // Broadcast the change to every renderer so all open windows update their artifact UI
      webContents.getAllWebContents().forEach((wc) =>
        wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId, kind: 'edit', by: 'user' })
      );
      return { ok: true };
    }

    // Discovered (on-disk) file: write directly by path. NO sidecar mutation, so
    // editing a doc never silently creates a .youcoded/ tracking dir. Resolve
    // inside the project root and refuse escapes (traversal guard, same as GET).
    const resolved = path.resolve(projectRoot, artifactId);
    const root = path.resolve(projectRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      return { ok: false, error: 'artifact-not-found' };
    }
    await fs.promises.writeFile(resolved + '.tmp', newContent, 'utf8');
    await fs.promises.rename(resolved + '.tmp', resolved);
    invalidateDiscoveryCache(projectRoot); // refresh the cached mtime next scan
    webContents.getAllWebContents().forEach((wc) =>
      wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId, kind: 'edit', by: 'user' })
    );
    return { ok: true };
  });

  // Normalize an include/exclude entry to a canonical ABSOLUTE path. FilesTab
  // passes a relative path for internal artifacts and an absolute one for
  // externals; storing one uniform shape keeps trackedArtifacts' comparisons
  // trivial.
  const toCanonicalAbs = (projectRoot: string, p: string): string => {
    const fwd = p.replace(/\\/g, '/');
    const isAbs = /^[a-zA-Z]:\//.test(fwd) || fwd.startsWith('/');
    return canonicalize(isAbs ? fwd : `${projectRoot.replace(/\\/g, '/')}/${fwd}`, null);
  };

  // "+ Add file" = PIN a file into the Artifacts tab (any kind — external temp
  // files or in-project files Claude never edited). Three steps:
  //   1. Ensure an artifact RECORD exists (appendVersion dedups by path+kind and
  //      creates the sidecar if missing) — a pin with no record would show
  //      nothing, which was a real bug on fresh projects.
  //   2. Add to manualIncludes (idempotent).
  //   3. Remove from manualExcludes — re-adding is the RECOVERY path for a
  //      mistaken Exclude (includes also win over excludes in trackedArtifacts,
  //      so this is belt-and-suspenders).
  ipcMain.handle(ARTIFACT_IPC.INCLUDE_EXTERNAL, async (
    _e, projectRoot: string, absolutePath: string
  ) => {
    const canonical = toCanonicalAbs(projectRoot, absolutePath);
    const rootCanon = canonicalize(projectRoot, null);
    const isInternal = canonical === rootCanon || canonical.startsWith(rootCanon + '/');

    // 1. Ensure a record exists (author 'user', type 'read' — a pin, not an edit).
    const { project } = await ensureProject(CLAUDE_DIR, projectRoot, 'manual-include');
    const appendResult = await appendVersion(projectRoot, project.id, project.name, {
      path: isInternal ? canonical.slice(rootCanon.length + 1) : (canonical.split('/').pop() ?? canonical),
      kind: isInternal ? 'internal' : 'external',
      absolutePath: isInternal ? null : canonical,
      sessionId: 'manual-include',
      type: 'read',
      author: 'user',
    });

    // 2 + 3. Pin it and clear any standing exclude (CAS-retried).
    for (let attempt = 0; attempt < 5; attempt++) {
      const sidecar = await readSidecar(projectRoot);
      if (!sidecar || 'corrupted' in sidecar) return { ok: false, error: 'sidecar-missing' };
      const originalUpdatedAt = sidecar.updatedAt;
      const alreadyIncluded = sidecar.manualIncludes.some((i) => i.path === canonical);
      const hadExclude = sidecar.manualExcludes.includes(canonical);
      if (alreadyIncluded && !hadExclude) break; // nothing to change
      if (!alreadyIncluded) {
        sidecar.manualIncludes.push({ path: canonical, addedAt: new Date().toISOString(), addedBy: 'user' });
      }
      sidecar.manualExcludes = sidecar.manualExcludes.filter((p) => p !== canonical);
      sidecar.updatedAt = new Date().toISOString();
      const w = await writeSidecar(projectRoot, originalUpdatedAt, sidecar);
      if (w.committed) break;
    }
    webContents.getAllWebContents().forEach((wc) =>
      wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId: appendResult.artifactId, kind: 'include', by: 'user' })
    );
    return { ok: true };
  });

  // Exclude = HIDE a file from the Artifacts tab: un-pin it (remove from
  // manualIncludes) AND add a sticky manualExcludes entry so Claude re-editing
  // the file doesn't resurface it. Recovery: "+ Add file" (see above). Never
  // touches the file on disk or the session drawer's activity log.
  ipcMain.handle(ARTIFACT_IPC.EXCLUDE, async (
    _e, projectRoot: string, canonicalPath: string
  ) => {
    const canonical = toCanonicalAbs(projectRoot, canonicalPath);
    for (let attempt = 0; attempt < 5; attempt++) {
      const sidecar = await readSidecar(projectRoot);
      if (!sidecar || 'corrupted' in sidecar) return { ok: false, error: 'sidecar-missing' };
      const originalUpdatedAt = sidecar.updatedAt;
      sidecar.manualIncludes = sidecar.manualIncludes.filter((i) => i.path !== canonical);
      if (!sidecar.manualExcludes.includes(canonical)) sidecar.manualExcludes.push(canonical);
      sidecar.updatedAt = new Date().toISOString();
      const w = await writeSidecar(projectRoot, originalUpdatedAt, sidecar);
      if (w.committed) break;
    }
    webContents.getAllWebContents().forEach((wc) =>
      wc.send(ARTIFACT_IPC.CHANGED, { projectRoot, artifactId: null, kind: 'exclude', by: 'user' })
    );
    return { ok: true };
  });

  // Returns the Project View project list — the user's SAVED FOLDERS (the same
  // list the session-creation folder picker shows), reconciled with the central
  // index for artifact ids + stats. WHY saved folders rather than the raw index:
  // the index only gains an entry once Claude writes a tracked artifact in a
  // folder, so folders the user works in (conversations / reads only, or
  // pre-artifact-viewer) were invisible. The picker list is the user's own
  // source of truth and needs no Claude Code ~/.claude/projects dependency.
  ipcMain.handle(ARTIFACT_IPC.LIST_PROJECTS_INDEX, async (_e, opts?: { withCounts?: boolean }) => {
    let saved = readFolders();
    if (saved.length === 0) {
      // Mirror the folder picker's first-use seed so a fresh install isn't empty.
      saved = [{ path: os.homedir(), nickname: 'Home', addedAt: Date.now() }];
    }
    // Managed sync projects always appear in Project View, exactly like the
    // session picker's FOLDERS_LIST synthesizes them (2026-07-13 dogfood fix).
    // WHY: a project materialized by cross-device discovery is created in the
    // main process and is NEVER written to youcoded-folders.json, and it has no
    // central-index entry until it gains a tracked artifact — so without this it
    // showed in the picker but was invisible here. Append at the END so a saved
    // entry for the same path wins (keeps the user's nickname); buildSavedFolder-
    // Projects dedups by canonical path (first-wins) and reuses any index entry.
    const managed = getManagedRoots()?.listProjects() ?? [];
    for (const p of managed) saved.push({ path: p.path, nickname: p.name, addedAt: 0 });
    const indexProjects = await listProjects(CLAUDE_DIR);
    const projects = buildSavedFolderProjects(saved, indexProjects);

    // Conversation counts: a single global session scan, bucketed by CC slug.
    // Only when requested — listPastSessions is heavier (global), and ChatView's
    // frequent cwd-resolution calls don't need it. WHY a flag rather than always:
    // ChatView calls this on every drawer open and must stay fast.
    const ccSlug = (projectPath: string) =>
      cwdToProjectSlug(projectPath.replace(/^([a-z]):/, (_m, d) => `${d.toUpperCase()}:`));
    let convBySlug: Map<string, number> | null = null;
    if (opts?.withCounts) {
      const sessions = await listPastSessions();
      convBySlug = new Map();
      for (const s of sessions) convBySlug.set(s.projectSlug, (convBySlug.get(s.projectSlug) ?? 0) + 1);
    }

    // The stored stats.artifactCount is seeded to 0 and almost always stale, so
    // compute it live per project. Fast mode = tracked (sidecar) only — matches
    // what ChatView needs. withCounts mode ALSO scans on-disk docs (bounded +
    // cached, in parallel) so the switcher's "N files" reflects real files, not
    // just tracked artifacts, plus the conversation count.
    const computed = await Promise.all(projects.map(async (p) => {
      // artifactCount (stats.artifactCount) = ARTIFACTS (Claude-authored, tracked).
      // fileCount = ALL FILES (on-disk documents). Two distinct numbers, per the
      // core principle — the hero/segments/switcher each read the right one.
      let artifactCount: number;
      let fileCount: number | undefined;
      let fileCountTruncated: boolean | undefined;
      let conversationCount: number | undefined;
      if (opts?.withCounts) {
        // Authoritative counts via the SAME helpers the hero/segments use, so the
        // switcher row never disagrees with the open project's header. Gated
        // roots (home dir / drive root) return null — no scan, no fake number;
        // the switcher falls back to the artifact count. Truncated counts are
        // flagged so the UI can render "N+" instead of posing as exact.
        artifactCount = await countArtifacts(p.path);
        const allFiles = await countAllFiles(p.path);
        if (allFiles !== null) {
          fileCount = allFiles.count;
          fileCountTruncated = allFiles.truncated || undefined;
        }
        conversationCount = convBySlug!.get(ccSlug(p.path)) ?? 0;
      } else {
        // Fast path for ChatView's frequent cwd-resolution calls: cheap sidecar-
        // only artifact count, no on-disk scan and no existence check.
        const sidecar = await readSidecar(p.path);
        let trackedCount = 0;
        if (sidecar && !('corrupted' in sidecar)) {
          // Shared predicate — see visible-artifacts.ts for the full rules.
          trackedCount = trackedArtifacts(sidecar.artifacts as any[], sidecar.manualIncludes, sidecar.manualExcludes, p.path)
            .filter((a: any) => a.status !== 'deleted').length;
        }
        artifactCount = trackedCount;
      }

      return {
        ...p,
        stats: { ...p.stats, artifactCount },
        ...(fileCount !== undefined ? { fileCount } : {}),
        ...(fileCountTruncated ? { fileCountTruncated } : {}),
        ...(conversationCount !== undefined ? { conversationCount } : {}),
      };
    }));
    return { ok: true, projects: computed };
  });

  // Task 7.3: remove a project from the central index. The project folder and
  // its files are NOT deleted — only the YouCoded tracking record is removed.
  // When deleteSidecar is true, also removes .youcoded/artifacts.json from the
  // project folder so artifact history starts fresh on next session.
  ipcMain.handle(ARTIFACT_IPC.DELETE_PROJECT, async (
    _e, projectId: string, deleteSidecar: boolean
  ) => {
    const projects = await listProjects(CLAUDE_DIR);
    const p = projects.find((x) => x.id === projectId);
    if (!p) return { ok: false, error: 'project-not-found' };
    await removeProject(CLAUDE_DIR, projectId);
    if (deleteSidecar) {
      const sidecarPath = path.join(p.path, '.youcoded', 'artifacts.json');
      try {
        await fs.promises.unlink(sidecarPath);
      } catch {
        // Ignore ENOENT — sidecar may already be absent
      }
    }
    return { ok: true };
  });

  // Batch-check whether each requested artifact's resolved path still exists on
  // disk. Used by SessionDrawer + ProjectView to mark "file not on disk"
  // artifacts as deleted in the UI without mutating the sidecar. Internal
  // artifacts resolve to projectRoot/path; external artifacts resolve to
  // absolutePath. Parallel fs.access keeps this cheap even for hundreds of IDs.
  ipcMain.handle(ARTIFACT_IPC.CHECK_EXISTENCE, async (
    _e, projectRoot: string, artifactIds: string[]
  ) => {
    if (!projectRoot || !Array.isArray(artifactIds) || artifactIds.length === 0) {
      return { ok: true, missingIds: [] };
    }
    const sidecar = await readSidecar(projectRoot);
    if (!sidecar || 'corrupted' in sidecar) return { ok: true, missingIds: [] };
    const byId = new Map(sidecar.artifacts.map((a) => [a.id, a]));
    const results = await Promise.all(
      artifactIds.map(async (id) => {
        const a = byId.get(id);
        if (!a) return id; // unknown id treated as missing
        const fullPath = a.kind === 'internal'
          ? path.join(projectRoot, a.path)
          : a.absolutePath;
        if (!fullPath) return id;
        try {
          await fs.promises.access(fullPath);
          return null;
        } catch {
          return id;
        }
      })
    );
    return { ok: true, missingIds: results.filter((x): x is string => x !== null) };
  });

  // Return cleanup function for use during app shutdown
  return function cleanup() {
    stopThemeWatcher();
    clearInterval(statusInterval);
    clearInterval(usageRefreshInterval);
    transcriptWatcher.stopAll();
    // Flush + tear down every live native session on quit (best-effort, bounded
    // to one in-flight streaming part). Fire-and-forget with .catch — cleanup()
    // is synchronous and callers don't await it, so this mirrors the async
    // stopSyncSpaces() teardown pattern in main.ts window-all-closed.
    void nativeHost.destroyAll().catch(() => {});
    void engineManager.stopAll().catch(() => {}); // never leave an orphaned llama-server on quit
    for (const [id, watcher] of topicWatchers) {
      if (typeof (watcher as fs.FSWatcher).close === 'function') {
        (watcher as fs.FSWatcher).close();
      } else {
        clearInterval(watcher as NodeJS.Timeout);
      }
    }
    topicWatchers.clear();
    lastTopics.clear();
    sessionIdMap.clear();
  };
}
