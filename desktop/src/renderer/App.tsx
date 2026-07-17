// Registers window.__terminalRegistry so main-process executeJavaScript
// can call getScreenText for the attention classifier's ~1s buffer reads.
// Must run before any TerminalView mounts (which call registerTerminal).
import './bootstrap/terminal-bridge';
import React, { useState, useEffect, useRef, useCallback, useMemo, useReducer } from 'react';
import TerminalView from './components/TerminalView';
import ChatView from './components/ChatView';
import HeaderBar from './components/HeaderBar';
import InputBar, { type InputBarHandle } from './components/InputBar';
import StatusBar from './components/StatusBar';
import { MODELS, type ModelAlias } from './components/StatusBar';
import FolderSwitcher from './components/FolderSwitcher';

// Labels for the welcome-screen model picker (mirrors SessionStrip)
const WELCOME_MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus',
  haiku: 'Haiku',
  fable: 'Fable',
};
import ErrorBoundary from './components/ErrorBoundary';
import { Scrim, OverlayPanel } from './components/overlays/Overlay';
import GamePanel from './components/game/GamePanel';
import { ChatProvider, useChatDispatch, useChatStore } from './state/chat-context';
import { artifactReducer, initialArtifactState } from './state/artifact-tracker';
import { ArtifactProvider } from './state/ArtifactContext';
import { categorizeArtifact } from '../shared/artifacts/categorization';
import { resolveTrackedPath } from '../shared/artifacts/resolve-tracked-path';
// Central slash-command router — also used by the drawer so drawer-initiated
// slash commands behave the same as typed ones (otherwise drawer bypasses InputBar's intercept).
import { dispatchSlashCommand } from './state/slash-command-dispatcher';
import { GameProvider, useGameState, useGameDispatch } from './state/game-context';
import { hookEventToAction } from './state/hook-dispatcher';
import { hasPendingInteraction } from './state/pty-input-gate';
import { buildOutgoingMessage } from './components/outgoing-message';
import type { SyncWarning } from '../main/sync-state';
import { usePromptDetector } from './hooks/usePromptDetector';
import { useVisualViewport } from './hooks/useVisualViewport';
import { usePresence } from './hooks/usePresence';
import { usePartyGame } from './hooks/usePartyGame';
import { useRemoteAttentionSync } from './hooks/useRemoteAttentionSync';
import { useSubmitConfirmation } from './hooks/useSubmitConfirmation';
import { useSessionAttention } from './hooks/useSessionAttention';
import { useActiveSessionModel } from './hooks/useActiveSessionModel';
import { useZoomControls } from './hooks/useZoomControls';
import { useChromeMeasurements } from './hooks/useChromeMeasurements';
import { broadcastExpandAll, broadcastCollapseAll, isInExpandAllMode } from './hooks/useExpandAllToggle';
import { AppIcon, WelcomeAppIcon, ThemeMascot } from './components/Icons';
import CommandDrawer from './components/CommandDrawer';
import { TerminalScrollButtons } from './components/TerminalToolbar';
import TrustGate, { useTrustGateActive } from './components/TrustGate';
import MovedGate from './components/MovedGate';
import SettingsPanel from './components/SettingsPanel';
import ResumeBrowser from './components/ResumeBrowser';
import CloseSessionPrompt, { CLOSE_PROMPT_SUPPRESS_KEY } from './components/CloseSessionPrompt';
import PreferencesPopup from './components/PreferencesPopup';
import { useNativeBinding, usePreset, RuntimeBindingFields, loadLastBinding, persistLastBinding, type Runtime, type Binding } from './components/RuntimeBinding';
import ModelPickerPopup from './components/ModelPickerPopup';
import OpenTasksPopup from './components/OpenTasksPopup';
import { useSessionTasks } from './hooks/useSessionTasks';
import MarketplaceScreen from './components/marketplace/MarketplaceScreen';
import LibraryScreen from './components/library/LibraryScreen';
import { MarketplaceProvider } from './state/marketplace-context';
import ThemeShareSheet from './components/ThemeShareSheet';
import SkillEditor from './components/SkillEditor';
import ShareSheet from './components/ShareSheet';
import { ProjectView } from './components/project-view/ProjectView';

import type { SkillEntry, PermissionMode, AttentionState, CommandEntry } from '../shared/types';
import type { NativePermissionMode } from '../shared/permission-types';
import FirstRunView from './components/FirstRunView';
import { getPlatform, isRemoteMode, onConnectionModeChange } from './platform';
import type { SessionStatusColor } from './components/StatusDot';
import { ThemeProvider } from './state/theme-context';
import { SkillProvider } from './state/skill-context';
import { AccountProvider } from './state/account-context';
import HandlePrompt from './components/HandlePrompt';
import { WorkerHealthProvider } from './state/worker-health-context';
import { ThemeBg } from './components/ThemeBg';
import { StatsWithHealthBridge } from './components/StatsWithHealthBridge';
import { RootErrorBoundary } from './components/RootErrorBoundary';
import ThemeEffects from './components/ThemeEffects';
import { ZoomOverlay } from './components/ZoomOverlay';
import { RemoteSnapshotExporter } from './components/RemoteSnapshotExporter';
import { BuddyMascotApp } from './components/buddy/BuddyMascotApp';
import { BuddyChatApp } from './components/buddy/BuddyChatApp';
import { BuddyBarApp } from './components/buddy/BuddyBarApp';

// Dev-only ToolCard fixture sandbox wrapper. The React.lazy + dynamic
// import() live inside a `import.meta.env.DEV` ternary so Vite statically
// replaces the prod branch with `null` and tree-shakes the entire sandbox
// module (plus its fixture glob) out of production bundles. A bare
// module-scope `React.lazy(() => import(...))` would keep the chunk
// reachable — Vite emits a chunk for every reachable dynamic import
// regardless of whether the call site is dead code at the CALL SITE.
// By making the lazy itself conditional on DEV, the whole dependency edge
// disappears in prod.
// Named-export unwrap: ToolSandbox is a named export, not default.
// @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
const ToolSandboxRoute: React.ComponentType = import.meta.env.DEV
  ? (() => {
      const Lazy = React.lazy(() =>
        import('./dev/ToolSandbox').then((m) => ({ default: m.ToolSandbox }))
      );
      return function ToolSandboxRouteDev() {
        return (
          <React.Suspense fallback={null}>
            <Lazy />
          </React.Suspense>
        );
      };
    })()
  : () => null;
// ESC-passthrough: provider owns capture-phase ESC routing for overlays.
// Mounted at app root so every overlay component is a descendant.
import { EscCloseProvider, useEscStackEmpty, useDismissTop } from './hooks/use-esc-close';
// Pure guard for the chat-focused ESC -> PTY forwarding listener below.
import { shouldForwardEscToPty } from './state/should-forward-esc-to-pty';

type ViewMode = 'chat' | 'terminal';

// Detect buddy mode from URL query param — computed at module scope, before component render
const buddyMode = new URLSearchParams(
  typeof window !== 'undefined' ? window.location.search : ''
).get('mode');

// --- Sound notifications (shared engine) ---
import { playSound } from './utils/sounds';

interface SessionStats {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  duration: number | null;       // seconds (converted from ms in statusline.sh)
  apiDuration: number | null;    // seconds (converted from ms in statusline.sh)
  linesAdded: number | null;
  linesRemoved: number | null;
}

interface StatusDataState {
  usage: any;
  announcement: any;
  updateStatus: any;
  model: string | null;
  contextMap: Record<string, number>;
  gitBranchMap: Record<string, string>;
  sessionStatsMap: Record<string, SessionStats>;
  syncStatus: string | null;
  syncWarnings: SyncWarning[] | null;
  lastSyncEpoch: number | null;
  syncInProgress: boolean;
  backupMeta: any;
}

// Match a raw model id (e.g. 'claude-sonnet-4-6') back to a status-bar
// ModelAlias (e.g. 'claude-sonnet-4-6' → 'sonnet'). Returns 'unknown' — never
// a guessed alias — when the string is missing or doesn't match anything
// YouCoded recognizes (crash/resume state with a model id that predates this
// build, a wiring bug upstream, etc.) so the badge can say so honestly instead
// of silently mislabeling the session as whatever the previous default was.
function matchModelAlias(modelStr?: string | null): ModelAlias | 'unknown' {
  return MODELS.find((m) => modelStr?.includes(m.replace(/\[.*\]/, ''))) ?? 'unknown';
}

// For call sites that need a REAL model to send to CC (new/resumed session
// creation) rather than something to display — 'unknown' is only ever a
// display sentinel and must never be sent as a literal `/model unknown`.
function realModelAlias(model: ModelAlias | 'unknown'): ModelAlias {
  return model === 'unknown' ? 'sonnet' : model;
}

const VALID_PERMISSION_MODES: PermissionMode[] = ['normal', 'auto-accept', 'plan', 'auto', 'bypass'];

// Same idea as matchModelAlias for permission mode: only accept a value that's
// actually one of CC's known modes, otherwise surface 'unknown' rather than
// defaulting to 'normal' and implying a permission posture that may not be real.
function matchPermissionMode(mode?: string | null): PermissionMode | 'unknown' {
  return VALID_PERMISSION_MODES.includes(mode as PermissionMode) ? (mode as PermissionMode) : 'unknown';
}

function AppInner() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  // Ref mirror of `sessions` for handlers that need to read the latest list
  // without re-subscribing on every change (e.g. the artifact tool-use handler
  // which needs to resolve cwd by sessionId).
  const sessionsRef = useRef<any[]>([]);
  useEffect(() => { sessionsRef.current = sessions; }, [sessions]);
  // Multi-window detach state (desktop-only; remote-shim stubs these as no-ops).
  // `myWindowId` identifies this renderer's BrowserWindow so the switcher can
  // distinguish local sessions from sessions owned by peer windows. `directory`
  // and `leaderWindowId` are pushed from main whenever window topology changes.
  const [myWindowId, setMyWindowId] = useState<number | null>(null);
  const [windowDirectory, setWindowDirectory] = useState<any>(null);
  const [leaderWindowId, setLeaderWindowId] = useState<number>(-1);
  const isLeader = myWindowId != null && leaderWindowId === myWindowId;
  const [viewModes, setViewModes] = useState<Map<string, ViewMode>>(new Map());
  const [statusData, setStatusData] = useState<StatusDataState>({
    usage: null, announcement: null, updateStatus: null,
    model: null, contextMap: {}, gitBranchMap: {}, sessionStatsMap: {},
    syncStatus: null, syncWarnings: [],
    lastSyncEpoch: null, syncInProgress: false, backupMeta: null,
  });

  // 'unknown' is a display-only sentinel (never fed back into the real
  // PermissionMode enforcement logic) — see matchPermissionMode below.
  const [permissionModes, setPermissionModes] = useState<Map<string, PermissionMode | 'unknown'>>(new Map());
  // Native sessions carry a SEPARATE permission mode (harness policy, not a CC
  // PTY mode). Kept in its own map so the two unions never mix; default 'ask' is
  // read lazily (no per-session seeding) since NativeSessionHost also defaults to
  // 'ask' and the chip is the only setter. Task 13.
  const [nativePermissionModes, setNativePermissionModes] = useState<Map<string, NativePermissionMode | 'unknown'>>(new Map());
  // Sessions that have received their first hook event (Claude is initialized).
  // Until this fires, show an "Initializing" overlay to prevent premature input.
  const [initializedSessions, setInitializedSessions] = useState<Set<string>>(new Set());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerSearchMode, setDrawerSearchMode] = useState(false);
  const [drawerFilter, setDrawerFilter] = useState<string | undefined>(undefined);
  const inputBarRef = useRef<InputBarHandle>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsBadge, setSettingsBadge] = useState(false);
  const [syncAutoOpen, setSyncAutoOpen] = useState(false);
  // Deep-link flag for the Model Providers popup — set by a provider-error
  // bubble's "Open Settings" jump so Settings opens straight to that section.
  const [providersAutoOpen, setProvidersAutoOpen] = useState(false);
  const [skills, setSkills] = useState<SkillEntry[]>([]);
  // Track which sessions the user has "seen" (switched to after activity completed)
  const [viewedSessions, setViewedSessions] = useState<Set<string>>(new Set());
  const [resumeInfo, setResumeInfo] = useState<Map<string, { claudeSessionId: string; projectSlug: string }>>(new Map());
  const [resumeRequested, setResumeRequested] = useState(false);
  // Plan 2b "Moved Gate" (2026-07-14). Sessions another device took over: we keep
  // the pill and render <MovedGate> (instead of chat/terminal) when it's clicked.
  // The RENDER reads `movedSessions` state; the `destroyedHandler` — registered
  // once in a mount effect whose only dep is the stable `dispatch`, so its closure
  // captured `movedSessions` at mount (permanently the initial empty Map) — reads
  // `movedSessionsRef.current` instead. recordMoved/clearMoved keep the state and
  // the ref in lockstep, the ref updated synchronously so the destroy handler
  // (which fires ms after the moved push) reliably sees the entry.
  type MovedInfo = { device?: string; claudeSessionId?: string; projectSlug?: string; projectPath?: string };
  const [movedSessions, setMovedSessions] = useState<Map<string, MovedInfo>>(new Map());
  const movedSessionsRef = useRef(movedSessions);
  const recordMoved = useCallback((sessionId: string, info: MovedInfo) => {
    const next = new Map(movedSessionsRef.current);
    next.set(sessionId, info);
    movedSessionsRef.current = next;
    setMovedSessions(next);
  }, []);
  const clearMoved = useCallback((sessionId: string) => {
    if (!movedSessionsRef.current.has(sessionId)) return;
    const next = new Map(movedSessionsRef.current);
    next.delete(sessionId);
    movedSessionsRef.current = next;
    setMovedSessions(next);
  }, []);
  // Conversation-lease takeover dialog (Plan 2b Task 9). When resuming a
  // conversation held live on another device, we ask before yanking it here.
  // The resume flow AWAITS the user's choice via a promise resolved by the
  // dialog buttons (takeoverResolveRef), so handleResumeSession stays one linear
  // async function instead of splitting across callbacks. phase 'confirm' is the
  // first ask; 'force' is the "holder isn't responding — take over anyway?" ask.
  const [takeoverPrompt, setTakeoverPrompt] = useState<{ device: string; phase: 'confirm' | 'force' } | null>(null);
  const takeoverResolveRef = useRef<((choice: boolean) => void) | null>(null);
  const askTakeover = useCallback((device: string, phase: 'confirm' | 'force') =>
    new Promise<boolean>((resolve) => {
      // Reentrancy guard: only one resolver slot exists. If a second resume opens
      // a dialog while one is pending, resolve the prior one as "declined" so its
      // awaiting handleResumeSession returns cleanly instead of hanging forever.
      takeoverResolveRef.current?.(false);
      takeoverResolveRef.current = resolve;
      setTakeoverPrompt({ device, phase });
    }), []);
  const resolveTakeover = useCallback((choice: boolean) => {
    setTakeoverPrompt(null);
    const r = takeoverResolveRef.current;
    takeoverResolveRef.current = null;
    r?.(choice);
  }, []);
  // Shown when the user closes an active session — offers to mark it complete
  // in one step so it's hidden from the resume menu by default.
  const [closePromptFor, setClosePromptFor] = useState<string | null>(null);
  // Preferences popup state — opened by /config in chat view or from SettingsPanel
  const [preferencesOpen, setPreferencesOpen] = useState(false);
  // Model/effort/fast picker — opened by bare /model, /fast, /effort (and future status-bar chip clicks)
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Open Tasks popup — opened by the OpenTasksChip in the StatusBar
  const [openTasksPopupOpen, setOpenTasksPopupOpen] = useState(false);
  // SINGLE useSessionTasks instance for the whole page. The chip (in StatusBar)
  // and the popup both read from this one derivation so their inactiveMap state
  // stays in sync — two independent useSessionTasks calls would each keep their
  // own localStorage-backed state, and the `storage` event doesn't fire within
  // the same page (only across tabs). Fallback '' when there's no session gives
  // an empty task list via useChatState's singleton EMPTY_SESSION_STATE.
  const openTasks = useSessionTasks(sessionId ?? '');
  // Fast + effort state — surfaced via status bar chips. Persisted to ~/.claude/youcoded-model-modes.json.
  const [fastMode, setFastMode] = useState(false);
  const [effortLevel, setEffortLevel] = useState<string>('auto');
  // Load persisted modes on mount, and re-load when popup closes (picks up
  // edits made in the popup). Simple poll on popup close keeps the chips in sync.
  useEffect(() => {
    const api = (window.claude as any).modes;
    if (!api) return;
    api.get().then((m: { fast?: boolean; effort?: string }) => {
      setFastMode(!!m?.fast);
      if (m?.effort) setEffortLevel(m.effort);
    }).catch(() => {});
  }, [modelPickerOpen]);
  // App-scoped marketplace destinations (NOT per-session). The full-screen
  // marketplace + library replaced the legacy three-tab modal entirely.
  const [activeView, setActiveView] = useState<'chat' | 'terminal' | 'marketplace' | 'library'>('chat');
  // Preferred type chip when the marketplace is opened from a legacy entry
  // point (e.g. SettingsPanel theme picker). Cleared after the screen reads it.
  const [marketplaceInitialType, setMarketplaceInitialType] = useState<'skill' | 'theme' | undefined>(undefined);
  // When the CommandDrawer's plugin-name badge is clicked, we navigate to
  // the marketplace AND immediately open that plugin's detail overlay.
  // MarketplaceScreen reads this, opens the overlay on mount, then calls
  // the passed clearing callback so subsequent manual navigations start fresh.
  const [marketplaceInitialDetailId, setMarketplaceInitialDetailId] = useState<string | undefined>(undefined);
  // Tab to show when Library opens — consumed by LibraryScreen (Task 5.2 wires
  // the prop; this state is lifted here so the event listener below can set it).
  const [libraryInitialTab, setLibraryInitialTab] = useState<'skills' | 'themes' | 'updates' | undefined>(undefined);

  // Open the marketplace destination; `installed` routes to the Library
  // sibling. Omit `tab` (or pass undefined) to land on the discovery page
  // with no type chip pre-selected — the command drawer uses this so the
  // user sees the hero + rails, not a pre-filtered grid.
  const openMarketplace = useCallback((tab?: 'installed' | 'skills' | 'themes') => {
    if (tab === 'installed') {
      setActiveView('library');
      return;
    }
    if (tab === 'skills') setMarketplaceInitialType('skill');
    else if (tab === 'themes') setMarketplaceInitialType('theme');
    else setMarketplaceInitialType(undefined);
    setActiveView('marketplace');
  }, []);

  // Navigate to the marketplace AND open a specific plugin's detail
  // overlay. Called from the plugin-name badge on skill cards.
  const openMarketplaceDetail = useCallback((pluginId: string) => {
    setMarketplaceInitialType(undefined);
    setMarketplaceInitialDetailId(pluginId);
    setActiveView('marketplace');
  }, []);

  // Stable callback so MarketplaceScreen's useEffect doesn't re-fire every
  // render. Prior inline lambda recreated every parent render → the child's
  // effect saw a new dep identity → re-ran → caused a setState-during-render
  // React warning.
  const clearMarketplaceInitialDetail = useCallback(
    () => setMarketplaceInitialDetailId(undefined),
    [],
  );

  // Listen for the global "open library" event dispatched by ThemeScreen's
  // "Browse all themes" button. Opens Library to the requested tab and closes
  // the Appearance popup (the popup is inside SettingsPanel which the user can
  // close separately; we just navigate away by switching the active view).
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const tab = detail?.tab as 'skills' | 'themes' | 'updates' | undefined;
      setLibraryInitialTab(tab);
      setActiveView('library');
      // Close settings panel so the Library fills the screen unobstructed.
      setSettingsOpen(false);
    };
    window.addEventListener('youcoded:open-library', onOpen);
    return () => window.removeEventListener('youcoded:open-library', onOpen);
  }, []);
  const [publishThemeSlug, setPublishThemeSlug] = useState<string | null>(null);
  const [editorSkillId, setEditorSkillId] = useState<string | null>(null);
  const [shareSkillId, setShareSkillId] = useState<string | null>(null);

  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null); // null = loading
  const handleFirstRunComplete = useCallback(() => setIsFirstRun(false), []);

  // Welcome screen "New Session" expansion form state
  const [welcomeFormOpen, setWelcomeFormOpen] = useState(false);
  const [welcomeCwd, setWelcomeCwd] = useState('');
  const [welcomeModel, setWelcomeModel] = useState('sonnet');
  const [welcomeDangerous, setWelcomeDangerous] = useState(false);
  // Runtime (Claude Code vs YouCoded native harness) + native binding for the
  // welcome/app-open new-session form — mirrors the SessionStrip form via the
  // shared RuntimeBinding hook so the two forms can't drift.
  const [welcomeRuntime, setWelcomeRuntime] = useState<Runtime>('claude');
  const [welcomeBinding, setWelcomeBinding] = useState<Binding | null>(() => loadLastBinding());
  const welcomeNb = useNativeBinding({ active: welcomeFormOpen, runtime: welcomeRuntime, binding: welcomeBinding, setBinding: setWelcomeBinding });
  // Native harness preset for the welcome form — shared lifecycle hook (see
  // RuntimeBinding.usePreset). Follows the folder heuristic until the user picks a
  // card, then latches; re-arms every time the form (re)opens via welcomeFormOpen.
  const { preset: welcomePreset, setPreset: setWelcomePreset } = usePreset({ active: welcomeFormOpen, cwd: welcomeCwd });

  // Per-session model state — keyed by sessionId, same pattern as permissionModes.
  // 'unknown' is a display-only sentinel — never a real /model target.
  const [sessionModels, setSessionModels] = useState<Map<string, ModelAlias | 'unknown'>>(new Map());
  const currentModel: ModelAlias | 'unknown' = sessionId ? (sessionModels.get(sessionId) ?? 'unknown') : 'sonnet';
  const [pendingModel, setPendingModel] = useState<ModelAlias | null>(null);
  const consecutiveFailures = useRef(0);
  // Fix: track whether a new user turn has started after the model switch.
  // Events from the in-flight turn (before the switch takes effect) use the
  // old model and would cause false "failed to switch" errors.
  const postSwitchTurnReady = useRef(false);
  const [toast, setToast] = useState<string | null>(null);
  const { zoomPercent, zoomVisible, handleZoomIn, handleZoomOut, handleZoomReset } = useZoomControls();

  const [sessionDefaults, setSessionDefaults] = useState({ skipPermissions: false, model: 'sonnet', projectFolder: '' });

  // Check first-run state with a 3-second safety timeout — never hang the app
  useEffect(() => {
    let resolved = false;
    const resolve = (value: boolean) => {
      if (!resolved) { resolved = true; setIsFirstRun(value); }
    };
    const timeout = setTimeout(() => resolve(false), 3000);

    (window as any).claude?.firstRun?.getState?.()
      .then((state: any) => {
        clearTimeout(timeout);
        resolve(!!(state && state.currentStep !== 'COMPLETE'));
      })
      .catch(() => { clearTimeout(timeout); resolve(false); });

    return () => clearTimeout(timeout);
  }, []);

  // Load session defaults on mount and whenever settings panel closes
  useEffect(() => {
    (window as any).claude?.defaults?.get?.().then((defs: any) => {
      if (defs) setSessionDefaults(defs);
    }).catch(() => {});
  }, [settingsOpen]);

  usePromptDetector();
  // Recovers chat→PTY submits that get lost on Windows ConPTY when Claude is
  // busy — see useSubmitConfirmation for the full mechanism. Pass active
  // session + its view mode so the hook can suppress the `\r` retry while the
  // user is actively in terminal view (xterm routes keystrokes straight to
  // PTY, so an injected `\r` would commit the partial line they're typing).
  useSubmitConfirmation({
    activeSessionId: sessionId,
    activeViewMode: sessionId ? viewModes.get(sessionId) ?? 'chat' : 'chat',
    // Native sessions never enter the PTY-only `\r` retry path.
    providerForSession: (sid) => sessions.find((s) => s.id === sid)?.provider,
  });
  // Drives --vvp-offset from window.visualViewport so the input bar stays glued
  // to the top of the soft keyboard on Android / mobile browsers.
  useVisualViewport();
  useRemoteAttentionSync();

  // Removed: data-theme-layout effect. The chrome-glass refactor replaced
  // the data-theme-layout gating with data-chrome-style / data-input-style,
  // which are already published by theme-engine.ts. No CSS consumes
  // data-theme-layout anymore, so the effect was dead code.

  const dispatch = useChatDispatch();
  const chatStore = useChatStore();
  // Artifact tracker — global reducer for session/project artifact state.
  const [artifactState, dispatchArtifact] = useReducer(artifactReducer, initialArtifactState);
  // Ref mirror of artifact state so the (once-registered) tool-use handler can
  // dedup Read-tracking against the session's already-known artifacts without
  // re-subscribing on every reducer tick.
  const artifactStateRef = useRef(artifactState);
  useEffect(() => { artifactStateRef.current = artifactState; }, [artifactState]);
  // Latest-value ref so transcript-shrink and turn-complete handlers see
  // up-to-date compactionPending state without re-subscribing on every reducer tick.
  // Tranche 1: fed by a store subscription instead of a [chatStateMap] effect,
  // so AppInner no longer re-renders per dispatch just to keep this ref current.
  // The ~12 chatStateMapRef.current reads all over this file are unchanged.
  const chatStateMapRef = useRef(chatStore.getState());
  useEffect(() => {
    chatStateMapRef.current = chatStore.getState();
    return chatStore.subscribeAll(() => { chatStateMapRef.current = chatStore.getState(); });
  }, [chatStore]);

  // Guarded PTY send for command-shaped writes triggered by UI actions
  // (command drawer, skill runs, /sync, /config, /model, Settings sends).
  // While a permission/AskUserQuestion/plan request is pending, CC's native
  // Ink select menu is live in the PTY — the sent text would be eaten as menu
  // input and its trailing \r would press Enter on the highlighted option,
  // silently answering the prompt (stray-Enter fix, youcoded#110). Same rule
  // InputBar.sendMessage applies to typed messages. Deliberate menu-driving
  // writes (ToolCard plan keys, TrustGate, prompt option clicks, terminal
  // view) must NOT use this helper. Returns false when the send was refused.
  const notifyIfPtyBlocked = useCallback((sid: string): boolean => {
    const session = chatStateMapRef.current.get(sid);
    if (session && hasPendingInteraction(session)) {
      setToast('Claude is waiting for your response — answer the prompt first.');
      setTimeout(() => setToast(null), 3000);
      return true;
    }
    return false;
  }, []);

  const guardedPtySend = useCallback((sid: string, text: string): boolean => {
    if (notifyIfPtyBlocked(sid)) return false;
    window.claude.session.sendInput(sid, text);
    return true;
  }, [notifyIfPtyBlocked]);

  // Compaction watchdog: activity-aware — resets on any reducer update for a
  // session with compactionPending set. Any transcript event bumps the timer
  // forward, so long compactions (large sessions) don't trigger a false "may
  // have failed" message as long as events keep flowing. Only fires if nothing
  // happens for 180s straight, which genuinely means something's stuck.
  //
  // Prior bug: fixed 60s timer. Big sessions took longer than 60s legitimately,
  // hit the watchdog, dispatched aborted=true, cleared pending flag — then the
  // real shrink event arrived but had no pending flag to key off of, so the
  // user saw "may have failed" even though compaction succeeded.
  const compactWatchdogs = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // Tranche 1: store subscription instead of a [chatStateMap] effect. Same
  // activity-aware body (the timer still resets on every dispatch while a
  // compaction is pending); AppInner no longer re-renders per dispatch to run
  // it. The pre-existing no-clear-timers-on-unmount behavior is preserved.
  useEffect(() => {
    const check = () => {
      const map = chatStore.getState();
      // Perf: this runs on every reducer dispatch. Steady state (no compaction
      // in flight, no live watchdogs) short-circuits without walking the
      // session map. When a compaction is live we still iterate — preserving
      // the activity-awareness described above (timer resets on every dispatch).
      if (compactWatchdogs.current.size === 0) {
        let anyPending = false;
        for (const session of map.values()) {
          if (session.compactionPending) { anyPending = true; break; }
        }
        if (!anyPending) return;
      }
      for (const [sid, session] of map) {
        const existing = compactWatchdogs.current.get(sid);
        if (session.compactionPending) {
          // Reset on every reducer tick while pending — if transcript events are
          // flowing for this session, the timer keeps bumping and never fires.
          if (existing) clearTimeout(existing);
          const timer = setTimeout(() => {
            const current = chatStateMapRef.current.get(sid);
            if (current?.compactionPending) {
              dispatch({
                type: 'COMPACTION_COMPLETE',
                sessionId: sid,
                markerId: `compact-timeout-${Date.now()}`,
                afterContextTokens: null,
                aborted: true,
              });
            }
            compactWatchdogs.current.delete(sid);
          }, 180_000);
          compactWatchdogs.current.set(sid, timer);
        } else if (existing) {
          clearTimeout(existing);
          compactWatchdogs.current.delete(sid);
        }
      }
    };
    check();
    return chatStore.subscribeAll(check);
  }, [chatStore, dispatch]);

  // Attention-reporter ref declared up here so hooks-order stays deterministic;
  // the useEffect that writes to it lives AFTER sessionStatuses is computed
  // (search for "Attention reporter effect" below).
  const lastAttentionReportedRef = useRef<Map<string, { attentionState: AttentionState; awaitingApproval: boolean; status: SessionStatusColor }>>(new Map());

  const gameState = useGameState();
  const gameDispatch = useGameDispatch();
  // The game pane and the artifact drawer share the framed-shell's single right
  // slot, so they're mutually exclusive: opening one closes the other. Two
  // transition-gated effects (each keyed on only the OTHER pane's open flag)
  // enforce this without ping-ponging — closing one pane never re-opens the
  // other. Covers every open path, including the game panel auto-opening on an
  // incoming challenge (CHALLENGE_RECEIVED sets panelOpen) and the artifact
  // drawer opening from a file-pill / tool-card click.
  // Drawer open/closed is per-session; exclusivity acts on the ACTIVE session.
  const activeDrawerOpen = sessionId ? (artifactState.drawerOpenBySession[sessionId] ?? false) : false;
  useEffect(() => {
    if (gameState.panelOpen && activeDrawerOpen && sessionId) {
      dispatchArtifact({ type: 'DRAWER_CLOSED', sessionId });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameState.panelOpen]);
  useEffect(() => {
    if (activeDrawerOpen && gameState.panelOpen) {
      gameDispatch({ type: 'TOGGLE_PANEL' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDrawerOpen]);
  // Gate on isLeader so only the first-launched window opens the lobby
  // socket — avoids duplicate presence for the same GitHub identity when
  // multiple peer windows are open. When detach isn't available (remote
  // shim / Android), myWindowId stays null so isLeader is false — fall
  // back to true-by-default so the lobby still connects.
  const lobbyLeader = (window as any).claude?.detach?.openDetached ? isLeader : true;
  // Presence socket lives in the platform layer now (spec §3); usePresence
  // expresses desired state and maps relayed events onto the same reducer
  // actions the retired PartyKit lobby hook used. Same public API shape.
  const lobby = usePresence(lobbyLeader);
  const game = usePartyGame(lobby.updateStatus, lobby.challengePlayer);

  // createGame is gone from GameConnection (2026-07-09): the manual room-code
  // UI was removed — challenges are the only game entry. joinGame stays (an
  // accepted challenge joins by the received code).
  const gameConnection = useMemo(() => ({
    joinGame: game.joinGame,
    makeMove: game.makeMove,
    sendChat: game.sendChat,
    requestRematch: game.requestRematch,
    leaveGame: game.leaveGame,
    challengePlayer: game.challengePlayer,
    respondToChallenge: lobby.respondToChallenge,
    reconnectLobby: lobby.reconnect,
  }), [game.joinGame, game.makeMove, game.sendChat, game.requestRematch, game.leaveGame, game.challengePlayer, lobby.respondToChallenge, lobby.reconnect]);

  // Tranche 1: sessionStatuses now derives from the cached selector — AppInner
  // re-renders only when a triple changes, not on every dispatch (see
  // useSessionAttention). sessionStatuses keeps its old shape for HeaderBar.
  const sessionAttention = useSessionAttention(sessions, viewedSessions, sessionId);
  const sessionStatuses = useMemo(() => {
    const m = new Map<string, SessionStatusColor>();
    for (const [id, info] of sessionAttention) m.set(id, info.status);
    return m;
  }, [sessionAttention]);

  // Play the 'attention' sound when any session transitions to red (awaiting
  // approval). Red is a visible state, so color-driven dedup is correct here.
  const prevStatusSoundRef = useRef<Map<string, SessionStatusColor>>(new Map());
  // Remote attention diffing: tracks the last-seen attentionMap from status:data
  // so we only dispatch ATTENTION_STATE_CHANGED when a session's state actually flips.
  // On desktop, useAttentionClassifier already handles this locally (no-op here because
  // the reducer is idempotent for same-value transitions and the diff prevents redundant
  // dispatches). On remote browsers the classifier doesn't run, so this is the only path.
  const prevAttentionRef = useRef<Record<string, string>>({});
  // Perf: last status:data payload (serialized). Main pushes every 10s even
  // when nothing changed; without this guard the unconditional setStatusData
  // re-rendered the whole app tree at idle, forever.
  const lastStatusJsonRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevStatusSoundRef.current;
    for (const [id, color] of sessionStatuses) {
      const was = prev.get(id);
      if (was === color) continue;
      if (color === 'red' && was !== 'red') playSound('attention');
    }
    prevStatusSoundRef.current = new Map(sessionStatuses);
  }, [sessionStatuses]);

  // Play the 'ready' sound when any session's isThinking transitions true → false.
  // Replaces the prior blue-color-transition trigger, which never fired for the
  // currently-viewed session (blue requires "unseen, not active"). Thinking-false
  // is the actual "response finished" signal and fires regardless of visibility.
  const prevThinkingRef = useRef<Map<string, boolean>>(new Map());
  // Tranche 1: this MUST stay a React effect keyed on [sessionAttention], NOT a
  // per-dispatch store subscription (mirrors the attention-sound effect above,
  // deliberately left keyed on [sessionStatuses]). A per-dispatch subscription
  // observed every INTRA-BATCH isThinking toggle: transcript replay/hydrate
  // dispatches N turn events inside one rAF flush, and a session with K
  // completed turns toggles isThinking true→false K times within the batch →
  // K spurious 'ready' chimes where the old coalesced [chatStateMap] effect
  // stayed silent (adversarial review finding #1, 2026-07-17). Keying on the
  // selector coalesces to one post-commit run on the final state, and reading
  // raw isThinking from the store there is safe (effect body, not render). This
  // catches every real transition because isThinking→false only happens via
  // endTurn / process-exit / native-error, each of which also flips the status
  // triple → sessionAttention identity changes → this effect runs.
  useEffect(() => {
    const prev = prevThinkingRef.current;
    const next = new Map<string, boolean>();
    for (const [id, state] of chatStore.getState()) {
      const was = prev.get(id);
      const isThinking = !!state.isThinking;
      next.set(id, isThinking);
      // Only fire when we actually observed a true → false transition. Skip if
      // the session just appeared (was === undefined) to avoid a spurious chime
      // on reducer init or remote hydrate when isThinking arrives already false.
      if (was === true && !isThinking) playSound('ready');
    }
    prevThinkingRef.current = next;
  }, [sessionAttention]);

  // Attention reporter effect: pushes per-session attention state + the
  // derived dot color to main whenever sessionAttention changes. Main
  // aggregates across all windows and broadcasts
  // session:attention-summary so buddy surfaces can render the same dots.
  //
  // A ref-based diff ensures we only report when state actually changes —
  // the selector already collapses no-op dispatches, and we compare the
  // derived triple before sending as a second guard. Session removal sends
  // { clear: true } so main drops stale entries.
  //
  // Tranche 1: the triple (attentionState, awaitingApproval, status) now
  // comes from the useSessionAttention selector rather than being re-derived
  // here from chatStateMap + sessionStatuses.
  //
  // Stays a REACT EFFECT (not a store subscription) and is declared here (not
  // where the ref is) because it must observe the post-render selector output
  // — running it before sessionAttention is computed would read `undefined`.
  useEffect(() => {
    const prev = lastAttentionReportedRef.current;
    const currentIds = new Set<string>();
    for (const [sid, info] of sessionAttention) {
      currentIds.add(sid);
      // Thread the same dot color the main switcher renders for this
      // session so the buddy pill's dot is visually identical.
      const next = { attentionState: info.attentionState, awaitingApproval: info.awaitingApproval, status: info.status };
      const last = prev.get(sid);
      if (!last
        || last.attentionState !== next.attentionState
        || last.awaitingApproval !== next.awaitingApproval
        || last.status !== next.status
      ) {
        window.claude.attention.report({ sessionId: sid, ...next });
        prev.set(sid, next);
      }
    }
    for (const sid of prev.keys()) {
      if (!currentIds.has(sid)) {
        window.claude.attention.report({ sessionId: sid, clear: true });
        prev.delete(sid);
      }
    }
  }, [sessionAttention]);

  // Buddy "open main app" → land on the buddy's viewed session. Reads the
  // existing sessionsRef mirror so the IPC subscription survives
  // sessions-array churn without resubscribing.
  useEffect(() => {
    const off = window.claude?.buddy?.onFocusSession?.((sid: string) => {
      if (sessionsRef.current.some((s: any) => s.id === sid)) {
        setSessionId(sid);
        // Notify Android/remote bridge so the native terminal view switches too
        (window as any).claude?.session?.switch?.(sid);
      }
    });
    return off;
  }, []);

  // Push stack-state changes to the host. On Android, MainActivity uses this
  // to flip OnBackPressedCallback.isEnabled so hardware back is intercepted
  // when an overlay is open and falls through to Android default (background)
  // when nothing is dismissable. On desktop this call is a no-op (preload.ts's
  // window.claude.system.notifyStackState is a stub).
  const escStackEmpty = useEscStackEmpty();
  useEffect(() => {
    window.claude.system?.notifyStackState?.(escStackEmpty);
  }, [escStackEmpty]);

  // Hardware back button (Android) → dismiss top of stack. dismissTop is a
  // hook so we capture it in a ref the WS listener (which lives outside
  // React's render cycle) can read. Re-subscribing the listener on every
  // dismissTop change would churn the WebSocket subscription needlessly.
  const dismissTop = useDismissTop();
  const dismissTopRef = useRef(dismissTop);
  useEffect(() => { dismissTopRef.current = dismissTop; }, [dismissTop]);

  useEffect(() => {
    const handler = () => dismissTopRef.current();
    const unsubscribe = window.claude.system?.onBack?.(handler);
    return unsubscribe;
  }, []);

  // Native local-model residency → per-session ModelLoadingBar (2026-07-14).
  // Main joins per-model engine state with session→model and pushes each native
  // session its bound model's state (loaded/loading/sleeping/unloaded).
  useEffect(() => {
    const off = window.claude.native?.onModelState?.((s: any) => {
      if (!s?.sessionId || !s?.modelId || !s?.state) return;
      dispatch({
        type: 'NATIVE_MODEL_STATE_CHANGED',
        sessionId: s.sessionId,
        state: s.state,
        modelId: s.modelId,
        sizeBytes: typeof s.sizeBytes === 'number' ? s.sizeBytes : null,
        loadedBytes: typeof s.loadedBytes === 'number' ? s.loadedBytes : null,
      });
    });
    return () => { off?.(); };
  }, []);

  useEffect(() => {
    const createdHandler = window.claude.on.sessionCreated((info) => {
      setSessions((prev) => {
        // Deduplicate — replay buffers resend session:created for existing sessions
        if (prev.some((s) => s.id === info.id)) return prev;
        dispatch({ type: 'SESSION_INIT', sessionId: info.id });
        // Only auto-focus genuinely new sessions (not replayed ones)
        setSessionId(info.id);
        return [...prev, info];
      });
      // Native harness sessions (roadmap Phase 1+) are chat-first — they have
      // no PTY, so 'terminal' would be an empty pane. Claude sessions also
      // default to chat. (Gemini, the old terminal-only provider, is gone.)
      const defaultView = 'chat';
      setViewModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, defaultView));
      setPermissionModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, matchPermissionMode(info.permissionMode)));
      setSessionModels((prev) => {
        if (prev.has(info.id)) return prev;
        return new Map(prev).set(info.id, matchModelAlias(info.model));
      });
      // Native harness sessions (roadmap Phase 1+) have no hook relay, so they'd
      // never trigger the "first hook = initialized" gate. Mark them ready immediately.
      if (info.provider && info.provider !== 'claude') {
        setInitializedSessions((prev) => {
          if (prev.has(info.id)) return prev;
          const next = new Set(prev);
          next.add(info.id);
          return next;
        });
      }
      // Seed the native permission chip from the harness's ACTUAL starting mode
      // (a fresh Coder preset starts on 'auto-edit', not the default 'ask') —
      // fetch async and validate against the known modes, mirroring
      // cycleNativePermission's guard. Fires for both fresh + resumed native
      // sessions (both flow through session:created). Skip if already seeded.
      if (info.provider === 'native' && (window as any).claude?.native?.getPermissionMode) {
        (window.claude.native as any).getPermissionMode(info.id).then((mode: string) => {
          const VALID: NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
          // Unrecognized response → 'unknown', not a silent 'ask' guess: an
          // older/remote host that answered with something we don't understand
          // could actually be sitting on 'full-auto', and showing 'ASK FIRST'
          // in that case would understate what the session is allowed to do.
          setNativePermissionModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(
            info.id, VALID.includes(mode as NativePermissionMode) ? (mode as NativePermissionMode) : 'unknown',
          ));
        }).catch(() => {
          // getPermissionMode unavailable (remote/older host) — we genuinely
          // don't know the mode, so say so instead of defaulting to 'ask'.
          setNativePermissionModes((prev) => prev.has(info.id) ? prev : new Map(prev).set(info.id, 'unknown'));
        });
      }
    });

    const destroyedHandler = window.claude.on.sessionDestroyed((id: string, exitCode: number = 0) => {
      // Plan 2b Moved Gate: this session was TAKEN OVER, not closed. Keep its pill
      // (so clicking it hits the gate), skip the "session died" banner
      // (SESSION_PROCESS_EXITED), and DON'T wipe chat state (SESSION_REMOVE) — the
      // gate replaces the view; state is freed on Exit/Resume. Read the REF, not
      // `movedSessions`: this handler's mount-effect closure captured the state at
      // mount (empty), so a state read here would never see the moved entry.
      if (movedSessionsRef.current.has(id)) {
        // Drop from the aux maps (inert once the gate owns the view). Dropping
        // initializedSessions also keeps the input bar disabled as defence-in-depth.
        setViewModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
        setPermissionModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
        setNativePermissionModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
        setSessionModels((prev) => { const n = new Map(prev); n.delete(id); return n; });
        setInitializedSessions((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
        return;
      }
      // Fire BEFORE removing the session from state — the reducer needs the
      // current SessionChatState to decide whether this warrants a 'session-died'
      // banner (in-flight tools OR nonzero exit). SESSION_REMOVE below wipes it.
      dispatch({ type: 'SESSION_PROCESS_EXITED', sessionId: id, exitCode });
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== id);
        // Auto-switch to another session when closing the active one
        setSessionId((curr) => {
          if (curr !== id) return curr;
          return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
        });
        return remaining;
      });
      setViewModes((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setPermissionModes((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setNativePermissionModes((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      setSessionModels((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      dispatch({ type: 'SESSION_REMOVE', sessionId: id });
      setInitializedSessions((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    });

    const hookHandler = window.claude.on.hookEvent((event) => {
      const action = hookEventToAction(event);
      if (action) {
        dispatch(action);
      }
      // First hook event for a session = Claude is initialized
      if (event.sessionId) {
        setInitializedSessions((prev) => {
          if (prev.has(event.sessionId)) return prev;
          const next = new Set(prev);
          next.add(event.sessionId);
          // Broadcast so other devices transition out of Initializing too
          (window as any).claude?.remote?.broadcastAction({ type: '_SESSION_INITIALIZED', sessionId: event.sessionId });
          return next;
        });
      }
    });

    // Batch transcript dispatches into animation frames — multiple fs.watch events
    // within a single frame become one React render instead of N separate renders.
    //
    // Hidden-window caveat: Electron suspends requestAnimationFrame while the
    // window is minimized/occluded, which used to FREEZE chat state (queued
    // actions never flushed) while wall-clock timers kept firing — the 8s
    // submit-retry then evaluated its idle gate against stale state and could
    // send a stray \r into the PTY. While hidden we batch on a 16ms timeout
    // instead: same batching cost, but state keeps advancing.
    const pendingTranscriptActions: any[] = [];
    let transcriptRafId: number | null = null;
    let transcriptTimerId: ReturnType<typeof setTimeout> | null = null;
    let transcriptBatchCancelled = false;

    function flushTranscriptActions() {
      transcriptRafId = null;
      transcriptTimerId = null;
      if (transcriptBatchCancelled) return;
      const batch = pendingTranscriptActions.splice(0);
      // React 18 batches all synchronous dispatches → single render for the whole batch
      for (const action of batch) {
        dispatch(action);
      }
    }

    function batchTranscriptDispatch(action: any) {
      pendingTranscriptActions.push(action);
      if (transcriptRafId !== null || transcriptTimerId !== null) return;
      if (document.visibilityState === 'hidden') {
        transcriptTimerId = setTimeout(flushTranscriptActions, 16);
      } else {
        transcriptRafId = requestAnimationFrame(flushTranscriptActions);
      }
    }

    // If the window hides while an rAF flush is pending, that rAF may never
    // fire — hand the pending batch to a timeout so it can't strand.
    function onTranscriptVisibilityChange() {
      if (document.visibilityState === 'hidden' && transcriptRafId !== null) {
        cancelAnimationFrame(transcriptRafId);
        transcriptRafId = null;
        if (transcriptTimerId === null) {
          transcriptTimerId = setTimeout(flushTranscriptActions, 16);
        }
      }
    }
    document.addEventListener('visibilitychange', onTranscriptVisibilityChange);

    const transcriptHandler = (window.claude.on as any).transcriptEvent?.((event: any) => {
      if (!event?.type || !event?.sessionId) return;

      switch (event.type) {
        case 'user-message':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_USER_MESSAGE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
            // Forward the subagent stamp so the reducer can tell "briefing
            // written into a subagent's JSONL" apart from a real user prompt
            // and drop the former (it's already shown on the Agent card).
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'user-interrupt':
          // ESC-passthrough: transcript-watcher detected a user-initiated
          // interrupt (ESC sent to the PTY). Reducer records it so we can
          // tag the next assistant turn as interrupted.
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_INTERRUPT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
            kind: event.data.kind,
          });
          break;
        case 'assistant-text':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_ASSISTANT_TEXT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            text: event.data.text,
            timestamp: event.timestamp,
            // Task 2.4: forward the per-message model from the transcript so the
            // reducer can stamp turn.model on the first text of each turn.
            model: event.data.model,
            // Native runtime: per-token delta id — same partId merges into the
            // last text segment (mirror BubbleFeed.tsx, must stay identical).
            partId: event.data.partId,
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'tool-use':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_TOOL_USE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            toolUseId: event.data.toolUseId,
            toolName: event.data.toolName,
            toolInput: event.data.toolInput || {},
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'tool-result':
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_TOOL_RESULT',
            sessionId: event.sessionId,
            uuid: event.uuid,
            toolUseId: event.data.toolUseId,
            result: event.data.toolResult || '',
            isError: event.data.isError || false,
            structuredPatch: event.data.structuredPatch,
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'turn-complete':
          // Task 2.2: forward the full metadata payload. transcript-watcher emits these as
          // optional fields on event.data (shared/types.ts); coalesce undefined → null so
          // the action type (string | null, not optional) stays well-typed.
          batchTranscriptDispatch({
            type: 'TRANSCRIPT_TURN_COMPLETE',
            sessionId: event.sessionId,
            uuid: event.uuid,
            timestamp: event.timestamp,
            stopReason: event.data.stopReason ?? null,
            model: event.data.model ?? null,
            anthropicRequestId: event.data.anthropicRequestId ?? null,
            usage: event.data.usage ?? null,
            // Forward the subagent stamp so the reducer can drop a sub-agent's
            // end_turn instead of overwriting parent turn.model and tearing down
            // the parent's in-flight state via endTurn(). Mirrors assistant-text /
            // tool-use / tool-result dispatches above.
            parentAgentToolUseId: event.data.parentAgentToolUseId,
            agentId: event.data.agentId,
          });
          break;
        case 'assistant-thinking': {
          // Text payload → real reasoning content (collapsible in chat).
          // No payload → lifecycle heartbeat only (existing behavior:
          // bumps lastActivityAt and clears any stale attention banner).
          if (event.data?.text) {
            batchTranscriptDispatch({
              type: 'TRANSCRIPT_ASSISTANT_REASONING',
              sessionId: event.sessionId,
              uuid: event.uuid,
              text: event.data.text,
              timestamp: event.timestamp,
              partId: event.data.partId,
            });
          } else {
            batchTranscriptDispatch({
              type: 'TRANSCRIPT_THINKING_HEARTBEAT',
              sessionId: event.sessionId,
            });
          }
          break;
        }
        case 'session-error':
          // Native runtime only: a provider/stream failure. End the turn and
          // surface the 'error' AttentionBanner (mirror BubbleFeed.tsx).
          batchTranscriptDispatch({
            type: 'NATIVE_SESSION_ERROR',
            sessionId: event.sessionId,
            message: event.data.text ?? 'The model request failed.',
          });
          break;
        case 'compact-summary': {
          // Canonical compaction-complete signal — fired by the transcript
          // watcher when Claude Code writes an isCompactSummary entry. Works
          // for both in-session /compact (appends to same JSONL, so shrink
          // never fires) and resume-from-summary (first entry of new JSONL).
          const sessionState = chatStateMapRef.current.get(event.sessionId);
          if (sessionState?.compactionPending) {
            const contextTokens = statusData.sessionStatsMap[event.sessionId]?.contextTokens ?? null;
            dispatch({
              type: 'COMPACTION_COMPLETE',
              sessionId: event.sessionId,
              markerId: `compact-done-${Date.now()}`,
              afterContextTokens: contextTokens,
              // Forward CC's summary text so the SystemMarker can offer
              // click-to-expand (replaces the dead "ctrl+o to see full summary"
              // affordance from CC's TUI, which never worked inside YouCoded).
              ...(event.data.summary ? { summary: event.data.summary } : {}),
            });
          }
          break;
        }
      }
    });

    // Backup completion path: file-shrink detection. Primary detection now
    // runs through the 'compact-summary' transcript event above (canonical
    // isCompactSummary field). Shrink is still wired so we recover correctly
    // if Claude Code's future behavior changes to rewrite/truncate the JSONL.
    const shrinkHandler = (window.claude.on as any).transcriptShrink?.((payload: { sessionId: string }) => {
      if (!payload?.sessionId) return;
      const sessionState = chatStateMapRef.current.get(payload.sessionId);
      if (!sessionState?.compactionPending) return; // /clear or unrelated shrink — ignore
      const contextTokens = statusData.sessionStatsMap[payload.sessionId]?.contextTokens ?? null;
      dispatch({
        type: 'COMPACTION_COMPLETE',
        sessionId: payload.sessionId,
        markerId: `compact-done-${Date.now()}`,
        afterContextTokens: contextTokens,
      });
    });

    const renamedHandler = window.claude.on.sessionRenamed((sid, name) => {
      setSessions((prev) =>
        prev.map((s) => (s.id === sid ? { ...s, name } : s)),
      );
    });

    // Plan 2b Moved Gate: another device took over this session's lease. Record
    // it so its pill survives the imminent destroy and clicking it renders
    // <MovedGate>. Still dispatch SESSION_MOVED for its endTurn effect (cleanly
    // stops any 'thinking' state on the now-dead session). The push carries the
    // resume params so the gate's "Resume on this device" needs no extra lookup.
    const movedHandler = (window.claude.on as any).sessionMoved?.((payload: { sessionId: string; device?: string; claudeSessionId?: string; projectSlug?: string; projectPath?: string }) => {
      if (!payload?.sessionId) return;
      recordMoved(payload.sessionId, {
        device: payload.device,
        claudeSessionId: payload.claudeSessionId,
        projectSlug: payload.projectSlug,
        projectPath: payload.projectPath,
      });
      dispatch({ type: 'SESSION_MOVED', sessionId: payload.sessionId, device: payload.device });
    });

    // Permission-mode detection (per-session) is wired up in a dedicated
    // effect below, scoped to the current sessions list. Previously this used
    // a global pty:output listener; that channel is no longer broadcast
    // (every PTY chunk used to be double-sent to pay for a single listener —
    // see ipc-handlers.ts pty-output comments).

    const statusHandler = window.claude.on.statusData((data) => {
      // Skip byte-identical payloads. Safe to skip the attention diff below
      // too: an identical payload implies an identical attentionMap, which
      // was already folded into prevAttentionRef when first seen.
      const json = JSON.stringify(data);
      if (json === lastStatusJsonRef.current) return;
      lastStatusJsonRef.current = json;
      setStatusData((prev) => ({
        ...prev,
        usage: data.usage,
        announcement: data.announcement,
        updateStatus: data.updateStatus,
        syncStatus: data.syncStatus,
        syncWarnings: Array.isArray(data.syncWarnings) ? data.syncWarnings : [],
        lastSyncEpoch: data.lastSyncEpoch ?? prev.lastSyncEpoch,
        syncInProgress: data.syncInProgress ?? prev.syncInProgress,
        backupMeta: data.backupMeta ?? prev.backupMeta,
        contextMap: data.contextMap || prev.contextMap,
        gitBranchMap: data.gitBranchMap || prev.gitBranchMap,
        sessionStatsMap: data.sessionStatsMap || prev.sessionStatsMap,
      }));

      // Diff attentionMap and dispatch per-session when state flips.
      // On desktop, useAttentionClassifier already does this from the xterm buffer —
      // the reducer's same-value guard and the diff here make this a no-op locally.
      // On remote browsers the classifier never runs, so this is the only attention path.
      const incoming = (data?.attentionMap ?? {}) as Record<string, string>;
      const prev = prevAttentionRef.current;
      for (const [sessionId, state] of Object.entries(incoming)) {
        if (prev[sessionId] !== state) {
          dispatch({
            type: 'ATTENTION_STATE_CHANGED',
            sessionId,
            state: state as any,
          });
        }
      }
      prevAttentionRef.current = incoming;
    });

    // UI action sync — receive actions broadcast from other devices
    const uiActionHandler = (window.claude.on as any).uiAction?.((action: any) => {
      if (!action) return;
      // Handle view switching from native side (e.g. Chat button in TerminalKeyboardRow)
      if (action.action === 'switch-view' && action.mode) {
        setSessionId((currentSid) => {
          if (currentSid) {
            setViewModes((prev) => new Map(prev).set(currentSid, action.mode));
          }
          return currentSid;
        });
        return;
      }
      if (!action.type) return;
      // Handle session initialization sync (not a chat reducer action)
      if (action.type === '_SESSION_INITIALIZED' && action.sessionId) {
        setInitializedSessions((prev) => {
          if (prev.has(action.sessionId)) return prev;
          const next = new Set(prev);
          next.add(action.sessionId);
          return next;
        });
        return;
      }
      dispatch(action);
    });

    // Prompt events — Android bridge broadcasts Ink menu prompts detected from PTY screen
    const promptShowHandler = (window.claude.on as any).promptShow?.((payload: any) => {
      // A prompt arriving proves the session is alive — dismiss "Initializing" overlay
      setInitializedSessions((prev) => {
        if (prev.has(payload.sessionId)) return prev;
        const next = new Set(prev);
        next.add(payload.sessionId);
        return next;
      });
      dispatch({
        type: 'SHOW_PROMPT',
        sessionId: payload.sessionId,
        promptId: payload.promptId,
        title: payload.title,
        description: payload.description,
        buttons: payload.buttons || [],
      });
    });
    const promptDismissHandler = (window.claude.on as any).promptDismiss?.((payload: any) => {
      dispatch({
        type: 'DISMISS_PROMPT',
        sessionId: payload.sessionId,
        promptId: payload.promptId,
      });
    });
    const promptCompleteHandler = (window.claude.on as any).promptComplete?.((payload: any) => {
      dispatch({
        type: 'COMPLETE_PROMPT',
        sessionId: payload.sessionId,
        promptId: payload.promptId,
        selection: payload.selection || '',
      });
    });

    // Android-only: corrects optimistic permission-mode cycling. Desktop's
    // detection runs through ptyOutput above, but Android doesn't forward
    // raw PTY bytes — ManagedSession.detectPermissionMode broadcasts this
    // event from its 1Hz screen poll instead.
    const sessionPermissionModeHandler = (window.claude.on as any).sessionPermissionMode?.((sid: string, mode: string) => {
      const valid: PermissionMode[] = ['normal', 'auto-accept', 'plan', 'bypass'];
      if (!valid.includes(mode as PermissionMode)) return;
      setPermissionModes((prev) => {
        if (prev.get(sid) === mode) return prev;
        return new Map(prev).set(sid, mode as PermissionMode);
      });
    });

    // Remote-only: host sends a full chat state snapshot immediately after the
    // remote client connects. Dispatches HYDRATE_CHAT_STATE so the reducer
    // pre-populates all session timelines without waiting for transcript replay.
    // Typed-optional on the shared surface — present only on remote-shim.
    const chatHydrateHandler = window.claude.on.chatHydrate?.((payload: any) => {
      dispatch({ type: 'HYDRATE_CHAT_STATE', sessions: payload });
    });

    // Artifact tracker: when Claude writes/edits a file inside the active project
    // root, call appendVersion so the central index is populated, then refresh the
    // session drawer from disk. We piggyback on the existing transcriptEvent
    // subscription — filtering to Write/Edit/MultiEdit tool-use events and only
    // paths inside the session's working directory (external files are never
    // auto-tracked). appendVersion + ensureProject (called inside the IPC handler)
    // are both idempotent, so duplicate events are safe.
    //
    // Note: the transcript event payload does NOT include cwd — only sessionId.
    // We resolve cwd by looking up the session in the sessions state. Because
    // the handler is registered in a useEffect that doesn't re-subscribe on
    // sessions changes, we read via sessionsRef.current to always see fresh data.
    const artifactToolUseHandler = (window.claude.on as any).transcriptEvent?.((event: any) => {
      if (!event?.type || !event?.sessionId) return;
      if (event.type !== 'tool-use') return;
      const toolName: string = event.data?.toolName ?? '';
      const isRead = toolName === 'Read';
      if (!['Write', 'Edit', 'MultiEdit', 'Read'].includes(toolName)) return;
      const targetPath: string = event.data?.toolInput?.file_path ?? event.data?.toolInput?.path ?? '';
      if (!targetPath) return;

      // Reads are tracked for DOCUMENTS only (plans, notes, mockups, images) so
      // the tool card becomes openable — code/config reads would flood the
      // drawer and aren't what the artifact viewer is for. Writes/Edits track
      // everything (they're genuine changes Claude made).
      if (isRead && categorizeArtifact(targetPath) !== 'document') return;

      // Resolve cwd by looking up the session — transcript events don't carry cwd.
      const session = sessionsRef.current?.find?.((s: any) => s.id === event.sessionId);
      const projectRoot: string = session?.cwd ?? '';
      if (!projectRoot) return;

      // Dedup reads: only the FIRST read of a doc this session appends a 'read'
      // version. Skip if the file is already a known session artifact (already
      // written/edited/read this session) so repeated reads don't stack version
      // noise or bump lastModified on a real artifact. appendVersion has no
      // dedup of its own.
      if (isRead) {
        const known = artifactStateRef.current.sessionArtifacts[event.sessionId] ?? [];
        const tnorm = targetPath.replace(/\\/g, '/');
        const already = known.some((a: any) => {
          const aPath = (a.kind === 'internal' ? a.path : a.absolutePath) ?? '';
          const an = aPath.replace(/\\/g, '/');
          return an === tnorm || tnorm.endsWith('/' + an) || an.endsWith('/' + tnorm);
        });
        if (already) return;
      }

      // Determine internal vs external. The Session Drawer shows BOTH (a
      // session's activity log includes anything Claude touched); Project View
      // filters externals out unless they're in manualIncludes.
      //
      // resolveTrackedPath also REMAPS cross-device paths: a resumed conversation
      // replays a transcript whose absolute paths were recorded on ANOTHER device
      // (Windows `C:\…\<project>\file` resumed on Linux). Without the remap those
      // synced files mis-filed as external → showed "deleted" in the artifact
      // viewer even though the file is right there under the local root.
      const resolved = resolveTrackedPath(targetPath, projectRoot);

      // Read → 'read' (viewed, not modified); Write → 'create'; Edit/MultiEdit → 'edit'.
      const versionType: 'create' | 'edit' | 'read' =
        isRead ? 'read' : toolName === 'Write' ? 'create' : 'edit';

      const appendArgs: {
        path: string;
        kind: 'internal' | 'external';
        absolutePath: string | null;
        type: 'create' | 'edit' | 'read';
        author: 'agent';
      } = {
        path: resolved.path,
        kind: resolved.kind,
        absolutePath: resolved.absolutePath,
        type: versionType,
        author: 'agent',
      };
      ((window.claude as any).artifacts?.appendVersion?.(projectRoot, event.sessionId, appendArgs) ?? Promise.resolve())
        .catch((e: any) => console.error('[artifact-tracker] appendVersion failed', e))
        .finally(() => {
          // Then refresh the session view from the now-updated sidecar.
          (window.claude as any).artifacts?.listSession?.(event.sessionId, projectRoot)
            .then((res: any) => {
              if (res && res.ok && Array.isArray(res.artifacts)) {
                dispatchArtifact({
                  type: 'SESSION_ARTIFACTS_LOADED',
                  sessionId: event.sessionId,
                  artifacts: res.artifacts,
                });
              }
            })
            .catch((e: any) => console.error('[artifact-tracker] listSession failed', e));
        });
    });

    // NOTE: the artifacts:changed push event is consumed directly by
    // ActiveArtifactView (edit-conflict banner). An earlier App-level
    // subscription here only set a pendingRefresh flag that nothing read —
    // removed as dead state.

    return () => {
      transcriptBatchCancelled = true;
      if (transcriptRafId !== null) cancelAnimationFrame(transcriptRafId);
      if (transcriptTimerId !== null) clearTimeout(transcriptTimerId);
      document.removeEventListener('visibilitychange', onTranscriptVisibilityChange);
      window.claude.off('session:created', createdHandler);
      window.claude.off('session:destroyed', destroyedHandler);
      window.claude.off('hook:event', hookHandler);
      window.claude.off('session:renamed', renamedHandler);
      if (movedHandler) window.claude.off('session:moved', movedHandler);
      window.claude.off('status:data', statusHandler);
      if (transcriptHandler) window.claude.off('transcript:event', transcriptHandler);
      if (shrinkHandler) window.claude.off('transcript:shrink', shrinkHandler);
      if (uiActionHandler) window.claude.off('ui:action:received', uiActionHandler);
      if (promptShowHandler) window.claude.off('prompt:show', promptShowHandler);
      if (promptDismissHandler) window.claude.off('prompt:dismiss', promptDismissHandler);
      if (promptCompleteHandler) window.claude.off('prompt:complete', promptCompleteHandler);
      if (sessionPermissionModeHandler) window.claude.off('session:permission-mode', sessionPermissionModeHandler);
      if (chatHydrateHandler) window.claude.off('chat:hydrate', chatHydrateHandler);
      if (artifactToolUseHandler) window.claude.off('transcript:event', artifactToolUseHandler);
    };
  }, [dispatch]);

  // Desktop permission-mode detection, scoped per-session. Watches for Claude
  // Code's in-terminal mode indicator strings ("bypass permissions on", etc.)
  // and updates the HeaderBar badge. Previously a single global pty:output
  // listener handled this, forcing every PTY chunk to be dual-broadcast.
  // Subscribing per-session halves steady-state IPC traffic.
  //
  // Android doesn't forward raw PTY bytes — it emits 'session:permission-mode'
  // instead (handled in the big effect above), so this effect is effectively
  // desktop-only. On Android the ptyOutputForSession call is still safe but
  // will never deliver data matching the mode strings.
  useEffect(() => {
    const claudeOn = (window.claude.on as any);
    if (typeof claudeOn.ptyOutputForSession !== 'function') return;
    const handles: Array<{ sid: string; remove: () => void }> = [];
    for (const s of sessions) {
      const remove = claudeOn.ptyOutputForSession(s.id, (data: string) => {
        const lower = data.toLowerCase();
        let mode: PermissionMode | null = null;
        // CC v2.1.83+ auto mode banner reads "auto mode on (shift+tab to cycle)" —
        // checked before "accept edits on" because the substring "auto mode" doesn't
        // overlap, but order is preserved for symmetry with the off-list below.
        if (lower.includes('bypass permissions on')) mode = 'bypass';
        else if (lower.includes('auto mode on')) mode = 'auto';
        else if (lower.includes('accept edits on')) mode = 'auto-accept';
        else if (lower.includes('plan mode on')) mode = 'plan';
        else if (lower.includes('bypass permissions off')
              || lower.includes('auto mode off')
              || lower.includes('accept edits off')
              || lower.includes('plan mode off')) mode = 'normal';
        if (mode) {
          setPermissionModes((prev) => {
            if (prev.get(s.id) === mode) return prev;
            return new Map(prev).set(s.id, mode!);
          });
        }
      });
      handles.push({ sid: s.id, remove });
    }
    return () => {
      for (const h of handles) {
        try { h.remove(); } catch { /* unsubscribe API may no-op */ }
      }
    };
  }, [sessions]);

  // Fetch session list on mount — catches sessions that existed before event handlers were registered
  // (e.g., remote browser reconnecting after the replay buffer events already fired)
  useEffect(() => {
    window.claude.session.list().then((list: any[]) => {
      if (!list || list.length === 0) return;
      setSessions((prev) => {
        const existingIds = new Set(prev.map((s) => s.id));
        const newSessions = list.filter((s) => !existingIds.has(s.id));
        if (newSessions.length === 0) return prev;
        for (const s of newSessions) {
          dispatch({ type: 'SESSION_INIT', sessionId: s.id });
          setViewModes((vm) => vm.has(s.id) ? vm : new Map(vm).set(s.id, 'chat'));
          setPermissionModes((pm) => pm.has(s.id) ? pm : new Map(pm).set(s.id, matchPermissionMode(s.permissionMode)));
          // These sessions were already running before this window's event
          // handlers attached (e.g. a remote reconnect) — session:created never
          // fired for them, so this is the only place their model gets seeded.
          setSessionModels((sm) => sm.has(s.id) ? sm : new Map(sm).set(s.id, matchModelAlias(s.model)));
        }
        return [...prev, ...newSessions];
      });
      setSessionId((prev) => prev ?? list[0].id);
      // Mark all existing sessions as initialized — they're already running,
      // so skip the "Initializing" overlay (which waits for first hook event)
      setInitializedSessions((prev) => {
        const next = new Set(prev);
        for (const s of list) next.add(s.id);
        return next;
      });
    }).catch(() => {});
  }, [dispatch]);

  // Multi-window ownership wiring (Phase 2 of detach feature).
  // Subscribes to directory/leader/ownership pushes from main and mutates
  // local session list + chat reducer in response. When this window acquires
  // a session (via detach or re-dock), we request transcript replay so the
  // reducer hydrates from disk — the reducer is deterministic from TRANSCRIPT_*
  // events and uuid dedup handles any overlap with live events.
  useEffect(() => {
    const det = (window as any).claude?.detach;
    const getId = (window as any).claude?.window?.getId;
    if (getId) getId().then((id: number) => {
      setMyWindowId(id);
      // Stash globally so non-React code (SessionStrip drop resolution) can
      // identify this window without threading a prop through every consumer.
      (window as any).__youcodedWindowId = id;
    }).catch(() => {});
    if (!det) return;

    const cleanupDir = det.onDirectoryUpdated?.((dir: any) => {
      setWindowDirectory(dir);
      // The directory snapshot carries leaderWindowId too. Pull it from every
      // directory push so non-leader windows still learn who the leader is —
      // main only fires WINDOW_LEADER_CHANGED when the id *changes* from the
      // previously broadcast value, so window 2+ would otherwise never hear
      // about the existing leader and stay stuck on "Connecting…" forever.
      if (typeof dir?.leaderWindowId === 'number') setLeaderWindowId(dir.leaderWindowId);
    });
    const cleanupLeader = det.onLeaderChanged?.((id: number) => setLeaderWindowId(id));
    // Pull the current directory immediately — the push from main may have
    // fired before this effect ran (on a brand-new window, React mounts after
    // registerWindow already broadcast, so we'd miss it). Same applies to the
    // leader — hydrate both from this response.
    det.getDirectory?.().then((dir: any) => {
      if (!dir) return;
      setWindowDirectory(dir);
      if (typeof dir.leaderWindowId === 'number') setLeaderWindowId(dir.leaderWindowId);
    }).catch(() => {});

    const cleanupAcquired = det.onOwnershipAcquired?.((payload: any) => {
      const { sessionId: sid, sessionInfo, freshWindow, refocusOnly } = payload;
      if (refocusOnly) {
        // Switcher asked us to focus an existing local session — just flip active.
        setSessionId(sid);
        return;
      }
      setSessions((prev) => {
        if (prev.some((s) => s.id === sid)) return prev;
        return [...prev, sessionInfo];
      });
      dispatch({ type: 'SESSION_INIT', sessionId: sid });
      // Native harness sessions (roadmap Phase 1+) are chat-first — they have
      // no PTY, so 'terminal' would be an empty pane. Claude sessions also
      // default to chat. (Gemini, the old terminal-only provider, is gone.)
      const defaultView = 'chat';
      setViewModes((prev) => prev.has(sid) ? prev : new Map(prev).set(sid, defaultView));
      setPermissionModes((prev) => prev.has(sid) ? prev : new Map(prev).set(sid, matchPermissionMode(sessionInfo.permissionMode)));
      // A window-transfer handoff never fires session:created here — this is
      // the only place this window seeds the transferred session's model.
      setSessionModels((prev) => prev.has(sid) ? prev : new Map(prev).set(sid, matchModelAlias(sessionInfo.model)));
      // Transferred sessions were already initialized on the source — skip the
      // "Initializing" overlay, it would flash briefly before replay completes.
      setInitializedSessions((prev) => {
        if (prev.has(sid)) return prev;
        const next = new Set(prev); next.add(sid); return next;
      });
      if (freshWindow) setSessionId(sid);
      // Hydrate reducer from disk. Main streams every transcript event back on
      // the normal channel; uuid dedup absorbs any overlap with live events.
      det.requestTranscriptReplay?.(sid);
    });

    const cleanupLost = det.onOwnershipLost?.((payload: any) => {
      const { sessionId: sid } = payload;
      setSessions((prev) => {
        const remaining = prev.filter((s) => s.id !== sid);
        setSessionId((curr) => {
          if (curr !== sid) return curr;
          return remaining.length > 0 ? remaining[remaining.length - 1].id : null;
        });
        return remaining;
      });
      setViewModes((prev) => { const n = new Map(prev); n.delete(sid); return n; });
      setPermissionModes((prev) => { const n = new Map(prev); n.delete(sid); return n; });
      setNativePermissionModes((prev) => { const n = new Map(prev); n.delete(sid); return n; });
      setInitializedSessions((prev) => {
        if (!prev.has(sid)) return prev;
        const n = new Set(prev); n.delete(sid); return n;
      });
      // Use SESSION_REMOVE — NOT SESSION_PROCESS_EXITED — because the session
      // is still alive, just owned by another window now.
      dispatch({ type: 'SESSION_REMOVE', sessionId: sid });
    });

    return () => {
      cleanupDir?.();
      cleanupLeader?.();
      cleanupAcquired?.();
      cleanupLost?.();
    };
  }, [dispatch]);

  // Load skills once on mount
  useEffect(() => {
    window.claude.skills.list().then((list) => {
      // Inject built-in resume skill at the top
      const resumeSkill: SkillEntry = {
        id: '_resume',
        displayName: 'Resume Session',
        description: 'Resume a previous conversation',
        category: 'personal',
        prompt: '',
        source: 'youcoded-core',
        type: 'prompt',
        visibility: 'published',
      };
      setSkills([resumeSkill, ...list]);
    }).catch(console.error);
  }, []);

  // Flush and reload session state when connection mode changes (local ↔ remote).
  // On Android, switching to remote means the WebSocket now talks to the desktop server —
  // all local session state is stale and must be replaced with the desktop's sessions.
  useEffect(() => {
    const unsub = onConnectionModeChange((mode) => {
      // Flush all session state
      setSessions([]);
      setSessionId(null);
      setViewModes(new Map());
      setPermissionModes(new Map());
      setNativePermissionModes(new Map());
      setSessionModels(new Map());
      setInitializedSessions(new Set());
      setViewedSessions(new Set());
      dispatch({ type: 'RESET' });

      // Reload session list from the new server
      window.claude.session.list().then((list: any[]) => {
        if (!list || list.length === 0) return;
        setSessions(list);
        for (const s of list) {
          dispatch({ type: 'SESSION_INIT', sessionId: s.id });
          setViewModes((vm) => new Map(vm).set(s.id, 'chat'));
          setPermissionModes((pm) => new Map(pm).set(s.id, matchPermissionMode(s.permissionMode)));
          setSessionModels((sm) => new Map(sm).set(s.id, matchModelAlias(s.model)));
        }
        setSessionId(list[0].id);
        // Mark existing sessions as initialized (already running)
        setInitializedSessions(new Set(list.map((s) => s.id)));
      }).catch(() => {});
    });
    return unsub;
  }, [dispatch]);

  // Mark session as viewed when the user switches to it
  useEffect(() => {
    if (sessionId) {
      setViewedSessions((prev) => {
        if (prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.add(sessionId);
        return next;
      });
    }
  }, [sessionId]);

  // Clear viewed status when a session starts thinking (user sent a new message).
  // Tranche 1: store subscription instead of a [chatStateMap] effect — reads
  // sessionsRef.current (the existing mirror) so it doesn't need `sessions` as a
  // dep. setViewedSessions is a stable setState, safe from a subscription cb.
  useEffect(() => {
    const check = () => {
      const map = chatStore.getState();
      const sessions = sessionsRef.current;
      // Early-exit: skip iteration if no sessions are currently thinking.
      let anyThinking = false;
      for (const s of sessions) {
        const chatState = map.get(s.id);
        if (chatState?.isThinking) { anyThinking = true; break; }
      }
      if (!anyThinking) return;

      for (const s of sessions) {
        const chatState = map.get(s.id);
        if (chatState?.isThinking) {
          setViewedSessions((prev) => {
            if (!prev.has(s.id)) return prev;
            const next = new Set(prev);
            next.delete(s.id);
            return next;
          });
        }
      }
    };
    check();
    return chatStore.subscribeAll(check);
  }, [chatStore]);

  // Check if remote setup banner is active (show badge on gear icon)
  // Badge shows whenever the blue "Set Up Remote Access" banner would be visible
  // in the settings panel — i.e., no remote clients are connected
  useEffect(() => {
    const claude = (window as any).claude;
    if (!claude?.remote) return;
    const check = () => {
      claude.remote.getClientCount().then((count: number) => {
        setSettingsBadge(count === 0);
      }).catch(() => {});
    };
    check();
    const interval = setInterval(check, 10000);
    return () => clearInterval(interval);
  }, []);

  // Seed syncWarnings once at mount so a danger badge shows instantly at
  // launch. Ongoing updates ride the status:data push (same authoritative
  // .sync-warnings.json source) — the old 15s getStatus poll duplicated data
  // the push already carried and woke the main process for nothing.
  useEffect(() => {
    const claude = (window as any).claude;
    if (!claude?.sync?.getStatus) return;
    claude.sync.getStatus()
      .then((s: any) => {
        if (!Array.isArray(s?.warnings)) return;
        setStatusData((prev) =>
          prev.syncWarnings && prev.syncWarnings.length > 0
            ? prev // a status:data push beat us — it's the fresher source
            : { ...prev, syncWarnings: s.warnings });
      })
      .catch(() => {});
  }, []);

  // Red dot on the gear icon so the user can't miss a push failure —
  // derived from the pushed warnings, no dedicated poll.
  const settingsDangerBadge = useMemo(
    () => (statusData.syncWarnings ?? []).some((w) => w?.level === 'danger'),
    [statusData.syncWarnings],
  );

  const handleOpenDrawer = useCallback((searchMode: boolean) => {
    setDrawerSearchMode(searchMode);
    setDrawerOpen(true);
    // When opened via "/" in InputBar, the InputBar drives the filter
    // When opened via compass button, use the drawer's internal search
    if (!searchMode) setDrawerFilter(undefined);
  }, []);

  const handleCloseDrawer = useCallback(() => {
    setDrawerOpen(false);
    setDrawerFilter(undefined);
  }, []);

  // Shift+Space cycles model in chat view
  const cycleModelRef = useRef<(() => void) | null>(null);
  const cycleModel = useCallback(() => {
    if (!sessionId) return;
    // currentModel may be 'unknown' — indexOf then legitimately returns -1,
    // which wraps to index 0 below, so cycling from an unknown state starts fresh.
    const idx = MODELS.indexOf(currentModel as ModelAlias);
    const next = MODELS[(idx + 1) % MODELS.length];
    // Send first, guarded: while a prompt is pending, "/model …\r" would land
    // on CC's live Ink menu and answer it. Refusing BEFORE the optimistic
    // state writes also keeps the model pill truthful when nothing was sent.
    if (!guardedPtySend(sessionId, `/model ${next}\r`)) return;
    setSessionModels((prev) => new Map(prev).set(sessionId, next));
    setPendingModel(next);
    // Fix: don't verify against in-flight events from the current turn —
    // wait until a new user turn starts so we know Claude is using the new model.
    postSwitchTurnReady.current = false;
    // Persist preference optimistically — the /model command is reliable,
    // verification is just a safety net. If verification later shows a
    // mismatch, the failure handler overwrites with the actual model.
    (window.claude as any).model?.setPreference(next);
  }, [currentModel, sessionId, guardedPtySend]);
  cycleModelRef.current = cycleModel;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when a text input is focused — Shift+Space is a normal typing
      // combo (capitalized word then space) and would fire accidentally.
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.shiftKey && e.key === ' ') {
        e.preventDefault();
        cycleModelRef.current?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  // Verify model switch via transcript events.
  // Fix: (1) properly remove the listener on cleanup to prevent leaked handlers
  // that fire stale closures and cause repeated false "failed to switch" errors.
  // (2) Wait for a new user turn after the switch before verifying — events
  // from the in-flight turn still carry the old model and would false-alarm.
  useEffect(() => {
    if (!pendingModel) return;

    const handler = (window.claude.on as any).transcriptEvent?.((event: any) => {
      if (!event || event.sessionId !== sessionId) return;

      // A user-message after the switch means the next assistant response
      // will reflect the new model — safe to verify from here on.
      if (event.type === 'user-message') {
        postSwitchTurnReady.current = true;
        return;
      }

      if (event.type !== 'assistant-text' || !event.data?.model) return;
      // Skip events from the turn that was already in-flight when we switched
      if (!postSwitchTurnReady.current) return;

      const actualModel = event.data.model as string;
      const baseKey = (k: string) => k.replace(/\[.*\]/, '');
      const matches = actualModel.includes(baseKey(pendingModel));
      if (matches) {
        setPendingModel(null);
        consecutiveFailures.current = 0;
        // Preference already persisted optimistically in cycleModel
      } else {
        const actual = MODELS.find(m => actualModel.includes(baseKey(m)));
        // Revert this session's model and persisted preference to what Claude is actually using
        if (actual) {
          if (sessionId) setSessionModels((prev) => new Map(prev).set(sessionId, actual));
          (window.claude as any).model?.setPreference(actual);
        }
        const failures = consecutiveFailures.current + 1;
        consecutiveFailures.current = failures;
        setPendingModel(null);
        if (failures >= 2) {
          setToast("Model switch failed again. Ask Claude to diagnose with /model, or report a bug.");
        } else {
          setToast("Couldn't switch to " + pendingModel.charAt(0).toUpperCase() + pendingModel.slice(1));
        }
        setTimeout(() => setToast(null), 4000);
      }
    });

    // Fix: properly remove the IPC/WebSocket listener on cleanup so stale
    // closures don't accumulate and fire on future transcript events.
    return () => {
      if (handler) {
        (window.claude as any).off?.('transcript:event', handler);
      }
    };
  }, [pendingModel, sessionId]);

  // Passive drift reconciliation: silently align the session pill with what
  // Claude actually used, whenever the transcript reveals they disagree.
  //
  // The verify-model-switch effect above only runs during a user-initiated
  // Shift+Space / picker flip (pendingModel !== null). This effect catches the
  // cases that flow doesn't see:
  //   - user typed `/model sonnet` directly into the terminal view
  //   - Claude Code auto-downshifted on rate-limit
  //   - session resume picked up a different model than was selected
  //
  // Walks the timeline back to the most recent assistant turn with a known
  // model (set by TRANSCRIPT_ASSISTANT_TEXT in Task 2.4 and reconfirmed by
  // TRANSCRIPT_TURN_COMPLETE in Task 2.3), maps it to a ModelAlias, and if it
  // disagrees with sessionModels[sessionId], silently updates both the pill
  // state AND the persisted preference. No PTY writes — we're reflecting
  // reality, not trying to change the backend model.
  //
  // Gated on !pendingModel so this doesn't race with the verify effect during
  // a user-initiated switch (the in-flight turn still carries the old model
  // and would cause this effect to undo the user's intent prematurely).
  //
  // Tranche 1: the timeline walk moved into useActiveSessionModel (a cached
  // store selector). That preserves BOTH of this effect's original triggers —
  // a transcript event that reveals a new model for the active session
  // (activeSessionModel dep), AND a session switch (sessionId dep, so switching
  // INTO a session that drifted while backgrounded still reconciles its pill) —
  // without AppInner re-rendering on every dispatch the way the old
  // [chatStateMap] dep forced. See the plan's Task 9 option (c).
  const activeSessionModel = useActiveSessionModel(sessionId);
  useEffect(() => {
    if (!sessionId || pendingModel) return;
    if (!activeSessionModel) return;

    const currentAlias = sessionModels.get(sessionId);
    if (currentAlias && currentAlias !== activeSessionModel) {
      // Drift detected — reconcile silently. Also the self-heal path for a pill
      // stuck on the 'unknown' sentinel: the moment a real model shows up in
      // the transcript, this overwrites it. setPreference persists to disk
      // (so next session boots with the correct default); setSessionModels
      // updates the status-bar pill + Shift+Space cycle start point.
      (window.claude as any).model?.setPreference(activeSessionModel);
      setSessionModels((prev) => new Map(prev).set(sessionId, activeSessionModel));
    }
  }, [sessionId, activeSessionModel, sessionModels, pendingModel]);

  // Snapshot factory for /cost and /usage. Pulls live stats from statusData
  // and freezes them as a point-in-time snapshot. Returns null if stats haven't
  // arrived yet (status line hook runs after each command, so a brand-new session
  // may have no data for a few seconds).
  const getUsageSnapshot = useCallback(
    (sid: string) => {
      const stats = statusData.sessionStatsMap[sid];
      const ctx = statusData.contextMap[sid] ?? null;
      const usage = statusData.usage as { five_hour?: { utilization: number; resets_at: string }; seven_day?: { utilization: number; resets_at: string } } | null;
      if (!stats && ctx == null && !usage) return null;
      return {
        entryId: `usage-${sid}-${Date.now()}`,
        timestamp: Date.now(),
        costUsd: stats?.costUsd ?? null,
        inputTokens: stats?.inputTokens ?? null,
        outputTokens: stats?.outputTokens ?? null,
        cacheReadTokens: stats?.cacheReadTokens ?? null,
        cacheCreationTokens: stats?.cacheCreationTokens ?? null,
        contextTokens: stats?.contextTokens ?? null,
        contextPercent: ctx,
        duration: stats?.duration ?? null,
        apiDuration: stats?.apiDuration ?? null,
        linesAdded: stats?.linesAdded ?? null,
        linesRemoved: stats?.linesRemoved ?? null,
        fiveHourUtilization: usage?.five_hour?.utilization ?? null,
        fiveHourResetsAt: usage?.five_hour?.resets_at ?? null,
        sevenDayUtilization: usage?.seven_day?.utilization ?? null,
        sevenDayResetsAt: usage?.seven_day?.resets_at ?? null,
      };
    },
    [statusData],
  );

  const handleSelectCommand = useCallback(
    (entry: CommandEntry) => {
      // Defensive: disabled cards should never fire onClick in the UI, but if
      // something does route a CC-builtin here, no-op rather than sending
      // text that won't work in chat view.
      if (!entry.clickable) return;
      if (!sessionId) return;
      setDrawerOpen(false);
      setDrawerFilter(undefined);
      inputBarRef.current?.clear();

      if (entry.source === 'youcoded') {
        const currentView = viewModes.get(sessionId) || 'chat';
        const result = dispatchSlashCommand({
          raw: entry.name,
          sessionId,
          view: currentView,
          files: [],
          dispatch,
          timeline: [],
          callbacks: { onResumeCommand: () => setResumeRequested(true), getUsageSnapshot, onOpenPreferences: () => setPreferencesOpen(true), onToast: (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); }, getSessionState: (sid: string) => chatStateMapRef.current.get(sid), onOpenModelPicker: () => setModelPickerOpen(true) },
        });
        if (result.handled) {
          if (result.alsoSendToPty) {
            guardedPtySend(sessionId, result.alsoSendToPty);
          }
          return;
        }
        // Dispatcher declined (e.g. missing callback) — fall through to raw PTY send.
      }

      // Filesystem commands (and any unhandled YouCoded command) — send the
      // slash command to the PTY so Claude Code executes it. Also record the
      // optimistic user prompt so the chat timeline shows the action.
      // Send first, guarded (pending-prompt gate) — dispatching the bubble for
      // a refused send would leave a stale pending entry in the timeline.
      if (!guardedPtySend(sessionId, `${entry.name}\r`)) return;
      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: entry.name,
        timestamp: Date.now(),
      });
    },
    [sessionId, dispatch, viewModes, getUsageSnapshot, guardedPtySend],
  );

  const handleSelectSkill = useCallback(
    (skill: SkillEntry) => {
      if (skill.id === '_resume') {
        setDrawerOpen(false);
        setDrawerFilter(undefined);
        setResumeRequested(true);
        return;
      }
      if (!sessionId) return;
      setDrawerOpen(false);
      setDrawerFilter(undefined);
      inputBarRef.current?.clear();

      // If the skill's prompt is a slash command, route it through the dispatcher
      // so drawer-initiated /clear (etc.) behaves the same as typed /clear.
      // Non-slash prompts (natural language) fall through to the existing send path.
      const trimmedPrompt = skill.prompt.trim();
      if (trimmedPrompt.startsWith('/')) {
        const currentView = viewModes.get(sessionId) || 'chat';
        const result = dispatchSlashCommand({
          raw: skill.prompt,
          sessionId,
          view: currentView,
          files: [],
          dispatch,
          timeline: [],
          callbacks: { onResumeCommand: () => setResumeRequested(true), getUsageSnapshot, onOpenPreferences: () => setPreferencesOpen(true), onToast: (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); }, getSessionState: (sid: string) => chatStateMapRef.current.get(sid), onOpenModelPicker: () => setModelPickerOpen(true) },
        });
        if (result.handled) {
          if (result.alsoSendToPty) {
            guardedPtySend(sessionId, result.alsoSendToPty);
          }
          return;
        }
      }

      // Sanitize through the same one-source helper InputBar uses: skill
      // prompts can be multiline, and (a) raw newlines written to the PTY act
      // as premature Enter presses on short sends, (b) the optimistic bubble
      // must exactly match the sanitized text or the transcript confirm never
      // clears its pending flag (see outgoing-message.ts).
      const outgoing = buildOutgoingMessage(skill.prompt, []);
      if (!outgoing) return;
      // Send first, guarded (pending-prompt gate) — dispatching the bubble for
      // a refused send would leave a stale pending entry in the timeline.
      if (!guardedPtySend(sessionId, outgoing.ptyText + '\r')) return;
      dispatch({
        type: 'USER_PROMPT',
        sessionId,
        content: outgoing.content,
        timestamp: Date.now(),
      });
    },
    [sessionId, dispatch, viewModes, getUsageSnapshot, guardedPtySend],
  );

  const createSession = useCallback(async (cwd: string, dangerous: boolean, sessionModel?: string, provider?: 'claude' | 'native', launchInNewWindow?: boolean, binding?: { providerId: string; modelId: string }, preset?: string) => {
    // Use the explicitly chosen model; fall back to the current session's model.
    // realModelAlias guards against sending the literal 'unknown' sentinel to CC.
    const m = sessionModel || realModelAlias(currentModel);
    const info = await (window.claude.session.create as any)({
      name: 'New Session',
      cwd,
      skipPermissions: dangerous,
      // A Claude alias is meaningless for a native session (the harness uses
      // binding.modelId; SessionManager's native branch ignores `model`), so
      // omit it to keep the payload honest.
      model: provider === 'native' ? undefined : m,
      provider: provider || 'claude',
      // Native runtime only — the provider/model binding for the harness. The
      // main handler requires it for a fresh native session (session-manager
      // throws otherwise); undefined for claude sessions.
      binding: provider === 'native' ? binding : undefined,
      // Native runtime only — the harness preset (Assistant | Coder) the fresh
      // session is stamped with. Ignored for claude sessions.
      preset: provider === 'native' ? preset : undefined,
    });
    // I1 fix: deliver the RESOLVED harnessId to the live session pill. The
    // session:created event that seeds the sessions entry is emitted+sent
    // (process.nextTick) BEFORE the main handler finishes create/resume, so on a
    // resume it carries harnessId=undefined (session-manager can only seed it for
    // a fresh create; the resumed id is header-derived, known only after
    // nativeHost.resume awaits). The main handler re-stamps the resolved id onto
    // the SessionInfo it RETURNS — patch the entry from that invoke result here.
    if (info?.harnessId) {
      setSessions((prev) => prev.map((s) => (s.id === info.id ? { ...s, harnessId: info.harnessId } : s)));
    }
    // Launch-in-new-window: hand the freshly-created session off to a peer
    // window via the same ownership-transfer path used by drag-detach.
    if (launchInNewWindow && info?.id) {
      (window as any).claude?.detach?.openDetached?.({ sessionId: info.id });
    }
  }, [currentModel]);

  // Client-side removal for a session that is ALREADY dead in the main process
  // (Moved Gate Exit/Resume, where `session.destroy()` would no-op and emit no
  // session:destroyed event). Mirrors destroyedHandler's state cleanup MINUS the
  // death banner (SESSION_PROCESS_EXITED) — the session moved, it didn't die.
  const removeSessionLocally = useCallback((id: string) => {
    setSessions((prev) => {
      const remaining = prev.filter((s) => s.id !== id);
      setSessionId((curr) => (curr !== id ? curr : (remaining.length > 0 ? remaining[remaining.length - 1].id : null)));
      return remaining;
    });
    setViewModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setPermissionModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setNativePermissionModes((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setSessionModels((prev) => { const n = new Map(prev); n.delete(id); return n; });
    setInitializedSessions((prev) => { if (!prev.has(id)) return prev; const n = new Set(prev); n.delete(id); return n; });
    dispatch({ type: 'SESSION_REMOVE', sessionId: id });
    clearMoved(id);
  }, [dispatch, clearMoved]);

  const handleResumeSession = useCallback(async (claudeSessionId: string, projectSlug: string, projectPath: string, resumeModel?: string, resumeDangerous?: boolean, launchInNewWindow?: boolean, provider?: string) => {
    const cwd = projectPath;

    // Plan 2b Task 9 — conversation-lease takeover gate. Before resuming, ask the
    // hub whether this conversation is actively held on ANOTHER device. If so,
    // offer to take over here (the holder hands off), falling back to a
    // force-takeover if the holder doesn't respond. NEVER hard-blocks the resume:
    // any lease error just proceeds (spec §3 never-block).
    //
    // Self-device decision: the query result's `self` flag is computed in the
    // main process from the per-install deviceId (NOT the hostname label). We gate
    // the dialog on "held AND not self" so a lease left over from OUR OWN install
    // (e.g. after an unclean shutdown) resumes straight through instead of popping
    // a confusing "active on <your-own-hostname>" takeover dialog.
    try {
      const q = await window.claude.syncSpaces?.leaseQuery?.(claudeSessionId);
      if (q?.held && !q.self) {
        const device = q.device || 'another device';
        const confirmed = await askTakeover(device, 'confirm');
        if (!confirmed) return; // "Never mind" — abort the resume
        const r = await window.claude.syncSpaces?.leaseTakeover?.(claudeSessionId);
        if (r?.outcome === 'timeout') {
          const forced = await askTakeover(device, 'force');
          if (!forced) return; // "Never mind" — abort
          await window.claude.syncSpaces?.leaseForce?.(claudeSessionId);
        }
        // 'acquired' or 'error' -> fall through and resume (never-block).
      }
    } catch { /* never-block: a lease query/takeover failure must not stop the resume */ }

    // Native-harness resume: the model binding lives in the session's stored
    // header, so we send NO binding — SessionManager's native branch tolerates a
    // missing binding when resumeSessionId is set (it only throws for a FRESH
    // native session with no binding). The main-side create handler calls
    // nativeHost.resume(), which wires the session live; we then request a
    // transcript replay so the chat reducer hydrates from the persisted events
    // (getHistory returns native events for a live native id).
    if (provider === 'native') {
      const nativeSession = await (window.claude.session.create as any)({
        name: 'Resuming…',
        cwd,
        skipPermissions: false, // native sessions have no PTY permission flow
        provider: 'native',
        resumeSessionId: claudeSessionId,
      });
      if (!nativeSession?.id) return;
      // I1 fix (resume path): same invoke-result patch as createSession — the
      // session:created event seeded this entry with harnessId=undefined (resume
      // can't seed it synchronously), so the live pill would read "Assistant" for
      // a resumed Coder session. The returned SessionInfo carries the resolved id.
      if (nativeSession.harnessId) {
        setSessions((prev) => prev.map((s) => (s.id === nativeSession.id ? { ...s, harnessId: nativeSession.harnessId } : s)));
      }
      if (launchInNewWindow) {
        (window as any).claude?.detach?.openDetached?.({ sessionId: nativeSession.id });
      }
      // Hydrate the chat view from disk. Main streams every historical
      // TRANSCRIPT_EVENT back on the normal channel; uuid dedup absorbs overlap.
      (window as any).claude?.detach?.requestTranscriptReplay?.(nativeSession.id);
      return;
    }

    // Use explicitly chosen resume model; fall back to the current session's model.
    // realModelAlias guards against sending the literal 'unknown' sentinel to CC.
    const m = resumeModel || realModelAlias(currentModel);

    // Pass --resume flag so Claude Code boots directly into the resumed session
    const newSession = await (window.claude.session.create as any)({
      name: 'Resuming...',
      cwd,
      skipPermissions: resumeDangerous || false,
      resumeSessionId: claudeSessionId,
      model: m,
    });
    if (!newSession?.id) return;

    // Launch-in-new-window for resumed sessions — same peer-window spawn path.
    if (launchInNewWindow) {
      (window as any).claude?.detach?.openDetached?.({ sessionId: newSession.id });
    }

    setResumeInfo((prev) => new Map(prev).set(newSession.id, { claudeSessionId, projectSlug }));

    // Load recent history into chat view
    try {
      const messages = await (window as any).claude.session.loadHistory(claudeSessionId, projectSlug, 10, false);
      if (messages.length > 0) {
        dispatch({
          type: 'HISTORY_LOADED',
          sessionId: newSession.id,
          messages,
          hasMore: true,
        });
      }
    } catch (err) {
      console.error('Failed to load history:', err);
    }
  }, [dispatch, currentModel, askTakeover]);

  const currentViewMode = sessionId ? (viewModes.get(sessionId) || 'chat') : 'chat';

  // Mirror the active view mode onto <html data-view-mode="..."> so CSS can
  // react to it. Needed on Android to hide the wallpaper layer over the native
  // terminal — the React-side bg div sits on top of the native TerminalView
  // and opaque wallpapers were blocking the terminal text from showing through.
  useEffect(() => {
    document.documentElement.dataset.viewMode = currentViewMode;
  }, [currentViewMode]);

  const handleToggleView = useCallback(
    (mode: ViewMode) => {
      if (!sessionId) return;
      setViewModes((prev) => new Map(prev).set(sessionId, mode));
      // On Android, tell the native side to switch views
      if (getPlatform() === 'android') {
        (window as any).claude?.remote?.broadcastAction?.({ action: 'switch-view', mode });
      }
    },
    [sessionId],
  );

  // Ctrl+` toggles between chat and terminal view
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.key === '`') {
        e.preventDefault();
        handleToggleView(currentViewMode === 'chat' ? 'terminal' : 'chat');
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [handleToggleView, currentViewMode]);

  // ESC-passthrough: forward ESC to the active session's PTY when chat is
  // focused and no overlay consumed the event. Single \x1b byte — Claude Code
  // treats it as an interrupt. See
  // docs/superpowers/specs/2026-04-21-esc-chat-passthrough-design.md and
  // docs/PITFALLS.md -> "PTY Writes". Reactive state is read via a ref so the
  // listener isn't re-registered on every sessionId/viewMode change.
  const escPassthroughStateRef = useRef<{
    activeSessionId: string;
    viewMode: 'chat' | 'terminal';
    provider: 'claude' | 'native' | undefined;
  }>({ activeSessionId: '', viewMode: 'chat', provider: 'claude' });
  escPassthroughStateRef.current = {
    activeSessionId: sessionId ?? '',
    viewMode: currentViewMode,
    // Inlined (not currentSession, which is declared below) — this ref is
    // assigned during render before currentSession exists.
    provider: sessions.find((s) => s.id === sessionId)?.provider,
  };

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = escPassthroughStateRef.current;
      const forward = shouldForwardEscToPty({
        defaultPrevented: e.defaultPrevented,
        viewMode: s.viewMode,
        hasActiveSession: !!s.activeSessionId,
      });
      if (!forward) return;
      // Native sessions have no PTY — interrupt the in-process harness stream
      // directly. (native.interrupt is the provider-side equivalent of the ESC
      // byte; a raw \x1b would go nowhere.)
      if (s.provider === 'native') {
        window.claude.native.interrupt(s.activeSessionId);
        return;
      }
      // One byte to the PTY — Claude Code treats it as an interrupt.
      // Single-byte writes do NOT trigger Ink's 500ms paste-mode coalescing,
      // so no chunking or pacing is needed. See docs/PITFALLS.md -> "PTY Writes".
      window.claude.session.sendInput(s.activeSessionId, '\x1b');
    };
    // Bubble phase on purpose — EscCloseProvider owns capture phase, and we
    // need to read e.defaultPrevented AFTER capture-phase overlay handlers run.
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  // Ctrl+O toggles expand-all / collapse-all across every collapsible tool
  // card, tool group, and agent section in the chat view. The hook module
  // persists the current mode so child ToolCards that mount AFTER the
  // shortcut fires (e.g. inside a tool group that just opened) read the mode
  // via getInitialExpanded() and come up in the right state. Terminal view
  // ignores the shortcut so the keystroke passes to the PTY.
  const viewModeRef = useRef(currentViewMode);
  viewModeRef.current = currentViewMode;
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (e.shiftKey || e.altKey) return;
      if (e.key !== 'o' && e.key !== 'O') return;
      if (viewModeRef.current !== 'chat') return;
      e.preventDefault();
      if (isInExpandAllMode()) {
        broadcastCollapseAll();
      } else {
        broadcastExpandAll();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const currentSession = sessions.find((s) => s.id === sessionId);
  const canBypass = currentSession?.skipPermissions ?? false;
  // Native sessions: permission modes are a harness policy (Phase 2), not a
  // PTY shift+tab cycle — hide the badge + cycle affordance for them.
  const isNativeSession = currentSession?.provider === 'native';
  // A session with no map entry at all (a gap in the seeding paths above) reads
  // as 'unknown', not 'normal' — 'normal' would claim a specific, possibly wrong
  // permission posture instead of admitting YouCoded hasn't determined it yet.
  const currentPermissionMode: PermissionMode | 'unknown' = sessionId ? (permissionModes.get(sessionId) ?? 'unknown') : 'normal';
  // Native mode defaults to 'ask' only for the brief window before the async
  // getPermissionMode() call above resolves (mirrors NativeSessionHost's real
  // starting mode) — once it resolves, the map always holds either the real
  // mode or the explicit 'unknown' sentinel, never a guess.
  const currentNativeMode: NativePermissionMode | 'unknown' = sessionId ? (nativePermissionModes.get(sessionId) ?? 'ask') : 'ask';

  // Native permission chip: cycle ask → auto-edit → full-auto → ask via the
  // Task 12 IPC (NOT a PTY Shift+Tab — native sessions have no PTY). The IPC
  // returns the APPLIED mode, which is authoritative — state updates from the
  // return value, not the optimistic `next` (no screen-scrape correction path).
  const cycleNativePermission = useCallback(async () => {
    if (!sessionId) return;
    const cycle: NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
    // currentNativeMode may be 'unknown' — indexOf then legitimately returns -1,
    // which wraps to index 0 below, so cycling from an unknown state starts fresh.
    const idx = cycle.indexOf(currentNativeMode as NativePermissionMode);
    const next = cycle[(idx + 1) % cycle.length];
    try {
      const applied = await window.claude.native.setPermissionMode(sessionId, next);
      // Validate before storing: the normal path returns a bare mode string, but
      // the remote path converts a host throw into a resolved {ok:false,...}
      // object (remote-shim). Storing that would corrupt the chip's
      // PERMISSION_DISPLAY lookup — leave state unchanged on anything unexpected.
      const VALID: NativePermissionMode[] = ['ask', 'auto-edit', 'full-auto'];
      if (VALID.includes(applied as NativePermissionMode)) {
        setNativePermissionModes((prev) => new Map(prev).set(sessionId, applied as NativePermissionMode));
      } else {
        console.error('Native permission mode not applied:', applied);
      }
    } catch (err) {
      // A rejected invoke means an unknown-mode wiring bug in the host — leave
      // the chip on its current (unchanged) mode rather than lying about state.
      console.error('Failed to set native permission mode:', err);
    }
  }, [sessionId, currentNativeMode]);

  // Shift+Tab cycles permission mode in chat view
  // (In terminal view, the raw escape code reaches the PTY directly)
  const cyclePermissionRef = useRef<(() => void) | null>(null);
  const cyclePermission = useCallback(() => {
    if (!sessionId) return;
    // 'auto' is plan-gated by Anthropic — only included in the optimistic cycle
    // when the active session is on Opus 4.7 1M (the only model in our
    // ModelAlias union that has access). On other models, CC's Shift+Tab won't
    // surface auto, so showing it would create a click-but-nothing-happens
    // state. The PTY watcher above corrects mismatches within ~1 tick anyway.
    const canAuto = currentModel === 'opus[1m]';
    const cycle: PermissionMode[] = [
      'normal',
      'auto-accept',
      'plan',
      ...(canAuto ? ['auto' as PermissionMode] : []),
      ...(canBypass ? ['bypass' as PermissionMode] : []),
    ];
    // currentPermissionMode may be 'unknown' — indexOf then legitimately returns
    // -1, which wraps to index 0 below, so cycling from an unknown state starts fresh.
    const idx = cycle.indexOf(currentPermissionMode as PermissionMode);
    const next = cycle[(idx + 1) % cycle.length];
    setPermissionModes((prev) => new Map(prev).set(sessionId, next));
    // Send Shift+Tab to the PTY to cycle Claude Code's permission mode
    window.claude.session.sendInput(sessionId, '\x1b[Z');
  }, [sessionId, canBypass, currentPermissionMode, currentModel]);
  cyclePermissionRef.current = cyclePermission;

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.shiftKey && e.key === 'Tab') {
        e.preventDefault();
        cyclePermissionRef.current?.();
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, []);

  const trustGateActive = useTrustGateActive(sessionId);

  // Once trust gate activates, permanently mark the session as initialized
  // so the "Initializing" overlay doesn't reappear after trust is completed
  // (there's a gap between trust completion and the first hook event).
  useEffect(() => {
    if (trustGateActive && sessionId) {
      setInitializedSessions((prev) => {
        if (prev.has(sessionId)) return prev;
        const next = new Set(prev);
        next.add(sessionId);
        (window as any).claude?.remote?.broadcastAction({ type: '_SESSION_INITIALIZED', sessionId });
        return next;
      });
    }
  }, [trustGateActive, sessionId]);

  const sessionInitialized = sessionId ? initializedSessions.has(sessionId) : true;
  // Plan 2b Moved Gate: when the active session was taken over by another device,
  // its info lives here and we render <MovedGate> over the content instead of the
  // (now-dead) chat/terminal view.
  const movedGate = sessionId ? movedSessions.get(sessionId) : undefined;

  // Show a "something may be wrong" hint after 15s of waiting on initialization.
  // Resets whenever the active session changes or the session becomes initialized.
  const [initSlowWarning, setInitSlowWarning] = useState(false);
  useEffect(() => {
    if (sessionInitialized) { setInitSlowWarning(false); return; }
    setInitSlowWarning(false);
    const t = setTimeout(() => setInitSlowWarning(true), 15000);
    return () => clearTimeout(t);
  }, [sessionId, sessionInitialized]);

  // Terminal mode on touch/remote platforms — show minimal input with special keys
  const isTerminalTouch = currentViewMode === 'terminal' && getPlatform() !== 'electron';

  // Chrome geometry observers (--bottom/top-chrome-* CSS vars + Android layout
  // report). Extracted to useChromeMeasurements in tranche 1 — logic unchanged.
  // Called here (before the early returns below) so hook order stays stable.
  useChromeMeasurements(headerRef, bottomBarRef, sessionId, currentViewMode);

  // Still loading first-run check
  if (isFirstRun === null) {
    return <div className="flex-1 flex items-center justify-center bg-gray-950" />;
  }

  // First-run mode — show setup UI instead of normal app
  if (isFirstRun) {
    return (
      <div className="h-screen flex flex-col bg-gray-950">
        <FirstRunView onComplete={handleFirstRunComplete} />
      </div>
    );
  }

  return (
    // ArtifactProvider: exposes artifact state + dispatch to the entire AppInner
    // subtree. Sits inside all top-level providers (ChatProvider, ThemeProvider,
    // etc.) because artifact operations may eventually consume chat/theme context.
    <ArtifactProvider value={{ state: artifactState, dispatch: dispatchArtifact }}>
    <div className={`app-shell flex w-screen h-full text-fg ${getPlatform() === 'android' && currentViewMode === 'terminal' ? '' : 'bg-canvas'}`}>
      {/* Mount-only: listens for chat:export-snapshot from main, serializes
          ChatState, and sends the snapshot back for remote-browser hydration. */}
      <RemoteSnapshotExporter />
      {/* Main area — relative so bottom-float chrome can position against it.
          When a Phase-2 full-screen destination is active, hide the chat
          chrome entirely. Unmounting via `hidden` is cleaner than z-index
          games — chrome has backdrop-filter stacking contexts that trap
          sibling z-index values. */}
      <div
        className="flex-1 flex flex-col overflow-hidden relative"
        hidden={activeView === 'marketplace' || activeView === 'library'}
        // --right-pane-width drives BOTH the framed-shell drawer-pane width and
        // the chrome-glass cutout offset (both descend from here). The game pane
        // stays fixed at 400px; the artifact drawer's width is user-resizable
        // (youcoded#105) via --drawer-width on <html> — referencing the var here
        // (instead of a px literal) means mid-drag App re-renders rewrite the
        // SAME string and can't snap the width back while the user is dragging.
        style={{ ['--right-pane-width' as any]: gameState.panelOpen ? '400px' : 'var(--drawer-width, 480px)' }}
      >
        {sessions.length > 0 && sessionId && currentSession ? (
          <>
            {/* Chrome-glass: single backdrop-filter layer for the entire
                frame chrome. Replaces the per-element backdrop-filters on
                HeaderBar, frame-edges, frame-divider, drawer-pane, and the
                rounded-corner pseudos. Subpixel boundaries between those
                elements at non-100% zoom levels caused either tiny gaps
                (sharp wallpaper bleed through) or tiny overlaps (darker
                tone from double translucent-panel + double backdrop-filter).
                A single chrome-glass element clipped to the donut shape via
                clip-path: polygon() has only ONE backdrop-filter sampling the
                wallpaper directly, so the whole chrome reads as one
                continuous tone. */}
            <div className={`chrome-glass${(activeDrawerOpen || gameState.panelOpen) ? ' chrome-glass--drawer-open' : ''}`} />
            <div ref={headerRef} className="chrome-wrapper bg-canvas">
              <HeaderBar
                sessions={sessions}
                activeSessionId={sessionId}
                onSelectSession={(id: string) => {
                  setSessionId(id);
                  // Notify Android/remote bridge so the native terminal view switches too
                  (window as any).claude?.session?.switch?.(id);
                }}
                onCreateSession={createSession}
                onCloseSession={(id) => {
                  // Skip prompt if the user has checked "Don't show again".
                  // In that case destroy immediately without any flags — the
                  // user can still tag sessions from the resume menu later.
                  if (localStorage.getItem(CLOSE_PROMPT_SUPPRESS_KEY) === '1') {
                    try { window.claude.session.destroy(id); } catch {}
                  } else {
                    setClosePromptFor(id);
                  }
                }}
                onReorderSessions={(fromIndex: number, toIndex: number) => {
                  setSessions(prev => {
                    const next = [...prev];
                    const [moved] = next.splice(fromIndex, 1);
                    next.splice(toIndex, 0, moved);
                    return next;
                  });
                }}
                viewMode={currentViewMode}
                onToggleView={handleToggleView}
                gamePanelOpen={gameState.panelOpen}
                onToggleGamePanel={() => gameDispatch({ type: 'TOGGLE_PANEL' })}
                gameConnected={gameState.connected}
                challengePending={gameState.challengeFrom !== null}
                settingsOpen={settingsOpen}
                onToggleSettings={() => setSettingsOpen(prev => !prev)}
                settingsBadge={settingsBadge}
                settingsDangerBadge={settingsDangerBadge}
                sessionStatuses={sessionStatuses}
                onResumeSession={handleResumeSession}
                onOpenResumeBrowser={() => setResumeRequested(true)}
                defaultModel={sessionDefaults.model}
                defaultSkipPermissions={sessionDefaults.skipPermissions}
                defaultProjectFolder={sessionDefaults.projectFolder}
                windowDirectory={windowDirectory}
                myWindowId={myWindowId}
              />
            </div>
            <div
              className="flex-1 overflow-hidden relative"
            >
              {/* Tier 2 of android-terminal-data-parity: xterm.js is the sole
                  terminal renderer on every platform. The Android-only style
                  (backgroundColor transparent + pointerEvents none) and the
                  `getPlatform() !== 'android'` gate around <TerminalView /> are
                  gone — they existed so touches/visibility passed through the
                  WebView to the native Termux TerminalView underneath. xterm
                  now lives in the WebView, so the WebView itself is the
                  terminal surface. The native Compose TerminalView is still
                  rendering during this intermediate task; xterm's opaque
                  background covers it. Task 5 deletes the native renderer. */}
              {sessions.map((s) => (
                <React.Fragment key={s.id}>
                  <ErrorBoundary name="Chat">
                    <ChatView
                      sessionId={s.id}
                      visible={s.id === sessionId && (viewModes.get(s.id) || 'chat') === 'chat'}
                      resumeInfo={resumeInfo}
                      provider={s.provider}
                      cwd={s.cwd}
                      // Game pane lives in the active session's framed-shell
                      // right slot. Only the active session renders it (others
                      // get null) so there's a single GamePanel instance.
                      gamePane={s.id === sessionId && gameState.panelOpen ? (
                        <ErrorBoundary name="Game">
                          <GamePanel connection={gameConnection} incognito={lobby.incognito} onToggleIncognito={lobby.toggleIncognito} />
                        </ErrorBoundary>
                      ) : null}
                      // Provider-config error bubble → open Settings straight to
                      // the Model Providers section so the key can be fixed.
                      onOpenProviderSettings={() => { setProvidersAutoOpen(true); setSettingsOpen(true); }}
                    />
                  </ErrorBoundary>
                  <ErrorBoundary name="Terminal">
                    <TerminalView
                      sessionId={s.id}
                      visible={s.id === sessionId && (viewModes.get(s.id) || 'chat') === 'terminal'}
                    />
                  </ErrorBoundary>
                </React.Fragment>
              ))}
              {/* Initializing overlay — shown before Claude is ready, but only in chat view.
                 Terminal view must stay accessible during init so the user can interact there.
                 z-10: must stay below glassmorphism chrome (z-20) so header/bottom bars remain accessible */}
              {!sessionInitialized && sessionId && currentViewMode !== 'terminal' && !movedGate && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-canvas">
                  <ThemeMascot variant="idle" fallback={AppIcon} className="w-16 h-16 text-fg-dim mb-6 animate-pulse" />
                  <p className="text-sm text-fg-dim font-medium">Initializing session...</p>
                  {initSlowWarning && (
                    <div className="mt-4 text-xs text-fg-muted text-center max-w-xs flex flex-col gap-1">
                      <p>Something may be wrong.</p>
                      <p>Use the chat/terminal toggle to check terminal view for messages.</p>
                    </div>
                  )}
                </div>
              )}
              {trustGateActive && sessionId && <TrustGate sessionId={sessionId} />}
              {/* Plan 2b Moved Gate — covers the content area for a taken-over
                 session (the ChatView/TerminalView below are dead). z-10 like
                 TrustGate so the header strip stays reachable to switch away. */}
              {movedGate && sessionId && (
                <MovedGate
                  device={movedGate.device}
                  // Resume from a remote browser would run on the HOST, not here —
                  // hide it there to avoid the semantic oddity; local desktop always shows it.
                  canResume={!isRemoteMode()}
                  onExit={() => removeSessionLocally(sessionId)}
                  onResume={() => {
                    // Capture resume params BEFORE removeSessionLocally clears the entry.
                    const info = movedSessionsRef.current.get(sessionId);
                    // Drop the dead pill first so resume creates a fresh one (no duplicate).
                    removeSessionLocally(sessionId);
                    if (info?.claudeSessionId && info.projectSlug && info.projectPath) {
                      void handleResumeSession(info.claudeSessionId, info.projectSlug, info.projectPath);
                    } else {
                      // Main couldn't resolve the resume params (no cwd) — fall back
                      // to the Resume Browser so the user isn't stranded.
                      setResumeRequested(true);
                    }
                  }}
                />
              )}
              {currentViewMode === 'chat' && (
                <CommandDrawer
                  open={drawerOpen}
                  searchMode={drawerSearchMode}
                  externalFilter={drawerFilter}
                  onSelect={handleSelectSkill}
                  onSelectCommand={handleSelectCommand}
                  onClose={handleCloseDrawer}
                  onOpenManager={() => openMarketplace('installed')}
                  onOpenMarketplace={() => openMarketplace()}
                  onOpenLibrary={() => setActiveView('library')}
                  onOpenMarketplaceDetail={openMarketplaceDetail}
                />
              )}
              {isTerminalTouch && sessionId && (
                <TerminalScrollButtons sessionId={sessionId} />
              )}
            </div>
            {/* Always mounted so draft text survives chat↔terminal switches.
               inert disables focus/keyboard/paste when hidden so keystrokes
               reach xterm instead of the buried textarea. */}
              <div ref={bottomBarRef} className={`chrome-wrapper chrome-wrapper--bottom bg-canvas${currentViewMode === 'chat' ? ' bottom-float' : ''}`} {...(currentViewMode !== 'chat' && getPlatform() === 'electron' ? { inert: true, style: { position: 'absolute', width: 0, height: 0, overflow: 'hidden' } as React.CSSProperties } : {})}>
                {/* TerminalToolbar (Esc/Tab/Ctrl/arrows) now renders inside
                    ChatInputBar when minimal={isTerminalTouch}, slotted in
                    the QuickChips position so both modes share one container. */}
                <ChatInputBar ref={inputBarRef} sessionId={sessionId} view={currentViewMode} onOpenDrawer={handleOpenDrawer} onCloseDrawer={handleCloseDrawer} onDrawerSearch={setDrawerFilter} disabled={trustGateActive || !!movedGate || !sessionInitialized} minimal={isTerminalTouch} onResumeCommand={() => setResumeRequested(true)} getUsageSnapshot={getUsageSnapshot} onOpenPreferences={() => setPreferencesOpen(true)} onToast={(msg) => { setToast(msg); setTimeout(() => setToast(null), 3000); }} getSessionState={(sid) => chatStateMapRef.current.get(sid)} onOpenModelPicker={() => setModelPickerOpen(true)} initialInput={currentSession?.initialInput} provider={currentSession?.provider} />
                <StatusBar
                  statusData={{
                    usage: statusData.usage,
                    updateStatus: statusData.updateStatus,
                    announcement: statusData.announcement,
                    contextPercent: sessionId ? (statusData.contextMap[sessionId] ?? null) : null,
                    gitBranch: sessionId ? (statusData.gitBranchMap[sessionId] ?? null) : null,
                    sessionStats: sessionId ? (statusData.sessionStatsMap[sessionId] ?? null) : null,
                    syncStatus: statusData.syncStatus,
                    syncWarnings: statusData.syncWarnings,
                  }}
                  onOpenSync={() => {
                    // Open settings panel with sync popup auto-opened
                    setSyncAutoOpen(true);
                    setSettingsOpen(true);
                  }}
                  onRunSync={!trustGateActive && sessionId ? () => {
                    // Send first, guarded — a refused send must not leave a
                    // stale pending "/sync" bubble in the timeline.
                    if (!guardedPtySend(sessionId, '/sync\r')) return;
                    dispatch({ type: 'USER_PROMPT', sessionId, content: '/sync', timestamp: Date.now() });
                  } : undefined}
                  model={currentModel}
                  onCycleModel={cycleModel}
                  permissionMode={isNativeSession ? currentNativeMode : currentPermissionMode}
                  onCyclePermission={isNativeSession ? cycleNativePermission : cyclePermission}
                  fast={fastMode}
                  effort={effortLevel}
                  onOpenModelPicker={() => setModelPickerOpen(true)}
                  sessionId={sessionId}
                  onDispatch={(input: string) => {
                    if (!sessionId) return;
                    // Pass live timeline (drawer paths pass []) so future popup-dispatched commands
                    // that inspect history can read it without rewiring this wrapper.
                    const timeline = chatStateMapRef.current.get(sessionId)?.timeline ?? [];
                    const result = dispatchSlashCommand({
                      raw: input,
                      sessionId,
                      view: currentViewMode,
                      files: [],
                      dispatch,
                      timeline,
                      callbacks: {
                        onResumeCommand: () => setResumeRequested(true),
                        getUsageSnapshot,
                        onOpenPreferences: () => setPreferencesOpen(true),
                        onToast: (msg: string) => { setToast(msg); setTimeout(() => setToast(null), 3000); },
                        getSessionState: (sid: string) => chatStateMapRef.current.get(sid),
                        onOpenModelPicker: () => setModelPickerOpen(true),
                      },
                    });
                    // Forward alsoSendToPty so Claude Code itself runs the command. We deliberately skip the
                    // USER_PROMPT optimistic bubble that InputBar dispatches — for /compact and /clear, the
                    // COMPACTION_PENDING / CLEAR_TIMELINE reducer actions already update the timeline, so a
                    // USER_PROMPT bubble would render redundantly alongside them.
                    if (result.handled && result.alsoSendToPty) {
                      guardedPtySend(sessionId, result.alsoSendToPty);
                    }
                  }}
                  openTasksCounts={sessionId ? { running: openTasks.counts.running, pending: openTasks.counts.pending } : undefined}
                  onOpenOpenTasks={() => setOpenTasksPopupOpen(true)}
                />
              </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-3">
            <p className="text-xl text-fg-muted">No Active Session</p>
            {/* scene: the hero surface renders the theme's companions (sun,
                motes, sparkles) orbiting the mascot — big canvas, no clipping. */}
            <ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className="w-36 h-36 text-fg-dim" scene />
            {/* Welcome screen: New Session (expandable) + Resume Session */}
            <div className="flex flex-col items-center gap-2 mt-1 w-64">
              {welcomeFormOpen ? (
                /* Expanded new-session form with toggles */
                <div className="layer-surface w-full p-3 flex flex-col gap-2">
                  <div>
                    <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Project Folder</label>
                    {/* Match SessionStrip: the picker's "Manage projects…"
                        footer opens Project View (where adding lives). */}
                    <FolderSwitcher
                      value={welcomeCwd}
                      onChange={setWelcomeCwd}
                      onManageProjects={() => dispatchArtifact({ type: 'PROJECT_VIEW_OPENED' })}
                    />
                  </div>
                  {/* Runtime (Claude Code | YouCoded) + native provider/model
                      picker — same shared control as the SessionStrip form.
                      Self-hides when native.supported is false. */}
                  <RuntimeBindingFields
                    runtime={welcomeRuntime}
                    onRuntime={setWelcomeRuntime}
                    nb={welcomeNb}
                    preset={welcomePreset}
                    onPreset={setWelcomePreset}
                  />
                  {/* Claude model aliases — hidden for the native runtime, which
                      picks its model via the binding picker above. */}
                  {welcomeRuntime !== 'native' && (
                    <div>
                      <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Model</label>
                      <div className="flex gap-1">
                        {MODELS.map((m) => (
                          <button
                            key={m}
                            onClick={() => setWelcomeModel(m)}
                            className={`flex-1 px-1 py-1 rounded-sm text-[10px] transition-colors ${
                              welcomeModel === m
                                ? 'bg-accent text-on-accent font-medium'
                                : 'bg-inset text-fg-dim hover:bg-edge'
                            }`}
                          >
                            {WELCOME_MODEL_LABELS[m] || m}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] uppercase tracking-wider text-fg-muted">Skip Permissions</label>
                    <button
                      onClick={() => setWelcomeDangerous(!welcomeDangerous)}
                      className={`w-8 h-4.5 rounded-full relative transition-colors ${welcomeDangerous ? 'bg-[#DD4444]' : 'bg-inset'}`}
                    >
                      <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${welcomeDangerous ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
                    </button>
                  </div>
                  {welcomeDangerous && (
                    <p className="text-[10px] text-[#DD4444]">Claude will execute tools without asking for approval.</p>
                  )}
                  <div className="flex gap-2">
                    <button
                      onClick={() => setWelcomeFormOpen(false)}
                      className="px-3 py-1.5 text-sm rounded-md bg-inset text-fg-dim hover:bg-edge transition-colors"
                    >
                      Cancel
                    </button>
                    <button
                      onClick={() => {
                        // Native runtime carries a provider/model binding; persist
                        // the choice so it sticks. The disabled guard already blocks
                        // a missing binding, but bail defensively.
                        if (welcomeRuntime === 'native') {
                          if (!welcomeNb.effectiveBinding) return;
                          persistLastBinding(welcomeNb.effectiveBinding);
                        }
                        createSession(
                          welcomeCwd,
                          welcomeDangerous,
                          welcomeModel,
                          welcomeRuntime,
                          undefined, // welcome form has no launch-in-new-window toggle
                          welcomeRuntime === 'native' ? (welcomeNb.effectiveBinding ?? undefined) : undefined,
                          welcomeRuntime === 'native' ? welcomePreset : undefined,
                        );
                        setWelcomeFormOpen(false);
                        setWelcomeRuntime('claude');
                      }}
                      disabled={welcomeNb.nativeCreateBlocked}
                      className={`flex-1 text-sm font-medium rounded-md py-1.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
                        welcomeDangerous
                          ? 'bg-[#DD4444] hover:bg-[#E55555] text-white'
                          : 'bg-accent hover:bg-accent text-on-accent'
                      }`}
                    >
                      {welcomeDangerous ? 'Create (Dangerous)' : 'Create Session'}
                    </button>
                  </div>
                </div>
              ) : (
                /* Collapsed state: two side-by-side buttons */
                <>
                  <button
                    onClick={() => {
                      setWelcomeCwd(sessionDefaults.projectFolder || '');
                      setWelcomeDangerous(sessionDefaults.skipPermissions || false);
                      setWelcomeModel(sessionDefaults.model || 'sonnet');
                      // usePreset re-arms the heuristic itself on the welcomeFormOpen
                      // false→true edge — no manual touched reset needed here.
                      setWelcomeFormOpen(true);
                    }}
                    className="panel-glass w-full px-8 py-2 text-base font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors"
                  >
                    New Session
                  </button>
                  <button
                    onClick={() => setResumeRequested(true)}
                    className="panel-glass w-full px-6 py-2 rounded-lg bg-inset hover:bg-edge text-fg-dim hover:text-fg transition-colors flex items-center justify-center gap-1.5"
                  >
                    <svg className="w-4 h-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <span className="text-sm font-medium">Resume Session</span>
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* The game panel now renders inside the active session's framed-shell
          right slot (passed as ChatView's gamePane prop above), so it shares the
          artifact drawer's framed chrome instead of being a separate slide-out. */}
      <SettingsPanel
        open={settingsOpen}
        onClose={() => { setSettingsOpen(false); setSyncAutoOpen(false); setProvidersAutoOpen(false); }}
        onSendInput={(text) => {
          // Guarded: with a permission/question pending, the text would land on
          // CC's live Ink menu and the trailing \r would answer it.
          if (sessionId) guardedPtySend(sessionId, text + '\r');
        }}
        hasActiveSession={!!sessionId}
        onOpenThemeMarketplace={() => { setSettingsOpen(false); openMarketplace('themes'); }}
        onPublishTheme={(slug) => { setSettingsOpen(false); setPublishThemeSlug(slug); }}
        // Model Providers popup → Claude Code section → opens the /config prefs popup.
        onOpenClaudePreferences={() => { setSettingsOpen(false); setPreferencesOpen(true); }}
        syncAutoOpen={syncAutoOpen}
        onSyncAutoOpenHandled={() => setSyncAutoOpen(false)}
        providersAutoOpen={providersAutoOpen}
        onProvidersAutoOpenHandled={() => setProvidersAutoOpen(false)}
      />
      <ResumeBrowser
        open={resumeRequested}
        onClose={() => setResumeRequested(false)}
        onResume={handleResumeSession}
        defaultModel={sessionDefaults.model}
        defaultSkipPermissions={sessionDefaults.skipPermissions}
      />
      <CloseSessionPrompt
        open={closePromptFor !== null}
        sessionName={sessions.find((s) => s.id === closePromptFor)?.name}
        sessionId={closePromptFor}
        onCancel={() => setClosePromptFor(null)}
        onConfirm={(result) => {
          const id = closePromptFor;
          if (!id) return;
          // Reserved flags to set + the TAG DELTA (only what the user toggled off
          // the preloaded baseline) + the note if it changed — each fire-and-forget;
          // main resolves the desktop id to the Claude id. The .catch() swallows an
          // IPC rejection (remote timeout) so it can't become an unhandled rejection.
          for (const flag of result.flags) {
            try { Promise.resolve((window as any).claude.session.setFlag(id, flag, true)).catch(() => {}); } catch {}
          }
          for (const tagId of result.addTagIds) {
            try { Promise.resolve((window as any).claude.session.setTag(id, tagId, true)).catch(() => {}); } catch {}
          }
          for (const tagId of result.removeTagIds) {
            try { Promise.resolve((window as any).claude.session.setTag(id, tagId, false)).catch(() => {}); } catch {}
          }
          if (result.noteChanged) { try { Promise.resolve((window as any).claude.session.setNote(id, result.note)).catch(() => {}); } catch {} }
          try { window.claude.session.destroy(id); } catch {}
          setClosePromptFor(null);
        }}
      />
      <PreferencesPopup
        open={preferencesOpen}
        onClose={() => setPreferencesOpen(false)}
        // Advanced → switch to terminal view and forward /config to Claude Code's
        // native TUI. The user sees the full config menu rendered in xterm.
        onOpenAdvanced={() => {
          if (!sessionId) return;
          setViewModes((prev) => new Map(prev).set(sessionId, 'terminal'));
          // Small delay so the view switch happens before input lands.
          // pty-worker will auto-split "/config\r" into "/config" + 600ms + "\r"
          // to avoid Ink's paste timer swallowing Enter. Guarded: with a prompt
          // pending, "/config\r" would answer CC's live Ink menu instead.
          setTimeout(() => guardedPtySend(sessionId, '/config\r'), 50);
        }}
      />
      <ModelPickerPopup
        open={modelPickerOpen}
        onClose={() => setModelPickerOpen(false)}
        sessionId={sessionId}
        // The popup only knows real ModelAlias values (highlights the active
        // row) — 'unknown' has no row to highlight, so pass null, same as
        // "no session yet".
        currentModel={currentModel === 'unknown' ? null : currentModel}
        onSelectModel={(m) => {
          if (!sessionId) return;
          // Send first, guarded (pending-prompt gate) — refusing before the
          // optimistic state writes keeps the model pill truthful when the
          // command never reached CC. Mirrors cycleModel.
          if (!guardedPtySend(sessionId, `/model ${m}\r`)) return;
          setSessionModels((prev) => new Map(prev).set(sessionId, m));
          setPendingModel(m);
          postSwitchTurnReady.current = false;
          (window.claude as any).model?.setPreference(m);
        }}
        // /fast and /effort are PTY writes just like /model — route them
        // through the same pending-prompt gate so they can't answer a live Ink
        // menu (stray-Enter fix, youcoded#110). Returns false when refused so
        // the popup skips its optimistic state writes.
        sendPtyCommand={(text) => (sessionId ? guardedPtySend(sessionId, text) : false)}
        provider={currentSession?.provider}
        // Native model picker — the live bound modelId + a refresh callback so
        // the header reflects a mid-session swap (SessionInfo.model is the pill's
        // source; setBinding is in-memory, so we must update it here).
        currentModelId={currentSession?.provider === 'native' ? currentSession?.model : undefined}
        onNativeModelChanged={(modelId) => {
          if (!sessionId) return;
          setSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, model: modelId } : s)));
        }}
      />
      {/* Open Tasks popup — rendered at App root so it escapes any inner stacking context.
          Reads from the single `openTasks` useSessionTasks instance declared in AppInner. */}
      {sessionId && (
        <OpenTasksPopup
          open={openTasksPopupOpen}
          tasks={openTasks.tasks}
          onClose={() => setOpenTasksPopupOpen(false)}
          onMarkInactive={openTasks.markInactive}
          onUnhide={openTasks.unhide}
        />
      )}
      {/* Full-screen glass marketplace + library destinations. MarketplaceProvider
          is now app-wide (root provider tree) so ThemeScreen can also consume it.
          libraryInitialTab is lifted state set by the youcoded:open-library event
          (dispatched by ThemeScreen's "Browse all themes" button); Task 5.2 wires
          it to LibraryScreen's initialTab prop. */}
      {(activeView === 'marketplace' || activeView === 'library') && (
        activeView === 'marketplace' ? (
          <MarketplaceScreen
            onExit={() => { setActiveView('chat'); setMarketplaceInitialType(undefined); setMarketplaceInitialDetailId(undefined); }}
            onOpenLibrary={() => { setActiveView('library'); setMarketplaceInitialType(undefined); setMarketplaceInitialDetailId(undefined); }}
            onOpenShareSheet={(id) => setShareSkillId(id)}
            onOpenThemeShare={(slug) => setPublishThemeSlug(slug)}
            initialTypeChip={marketplaceInitialType}
            initialDetailId={marketplaceInitialDetailId}
            onDetailConsumed={clearMarketplaceInitialDetail}
          />
        ) : (
          <LibraryScreen
            onExit={() => { setActiveView('chat'); setLibraryInitialTab(undefined); }}
            onOpenMarketplace={() => setActiveView('marketplace')}
            onOpenShareSheet={(id) => setShareSkillId(id)}
            onOpenThemeShare={(slug) => setPublishThemeSlug(slug)}
            initialTab={libraryInitialTab}
          />
        )
      )}
      {publishThemeSlug && (
        <ThemeShareSheet themeSlug={publishThemeSlug} onClose={() => setPublishThemeSlug(null)} />
      )}
      {editorSkillId && (
        <SkillEditor skillId={editorSkillId} onClose={() => setEditorSkillId(null)} />
      )}
      {shareSkillId && (
        <ShareSheet skillId={shareSkillId} onClose={() => setShareSkillId(null)} />
      )}
      {toast && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-panel border border-edge text-sm text-fg shadow-lg">
          {toast}
        </div>
      )}
      {/* Plan 2b Task 9 — conversation-lease takeover confirm dialog. L2 popup via
          the shared Scrim/OverlayPanel primitives (theme-driven scrim/blur/shadow;
          PITFALLS → Overlays). Plain words, no status glyphs. 'confirm' asks to
          take a live session over; 'force' asks after the holder didn't respond. */}
      {takeoverPrompt && (
        <>
          <Scrim layer={2} onClick={() => resolveTakeover(false)} />
          <OverlayPanel
            layer={2}
            role="dialog"
            aria-modal
            aria-label="Take over conversation"
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[min(92vw,26rem)] p-5"
          >
            <p className="text-sm text-fg mb-4">
              {takeoverPrompt.phase === 'confirm'
                ? `This session is active on ${takeoverPrompt.device} — take over here?`
                : `${takeoverPrompt.device} isn't responding — take over anyway?`}
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg border border-edge text-sm text-fg-2 hover:bg-inset"
                onClick={() => resolveTakeover(false)}
              >
                Never mind
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg bg-accent text-on-accent text-sm hover:opacity-90"
                onClick={() => resolveTakeover(true)}
              >
                Take over
              </button>
            </div>
          </OverlayPanel>
        </>
      )}
      <ZoomOverlay
        zoomPercent={zoomPercent}
        visible={zoomVisible}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomReset={handleZoomReset}
      />
      {/* ProjectView — full-screen artifact browser across all projects.
          Renders null when projectViewOpen === false so no DOM overhead when closed.
          z-[8000]: sits below the SessionStrip dropdown (9000) but above all
          L1–L4 overlays, the same tier used by similar full-screen views. */}
      <ProjectView
        onNewConversation={(cwd) => { dispatchArtifact({ type: 'PROJECT_VIEW_CLOSED' }); createSession(cwd, false); }}
        onResumeConversation={(sid, slug, path) => { dispatchArtifact({ type: 'PROJECT_VIEW_CLOSED' }); handleResumeSession(sid, slug, path); }}
      />
    </div>
    </ArtifactProvider>
  );
}

// view is forwarded so InputBar's slash-command dispatcher can behave
// differently in chat vs terminal view (e.g. /config opens Preferences in
// chat view but passes through to Claude Code's TUI in terminal view).
// getUsageSnapshot lets /cost and /usage snapshot live stats from App state.
import type { UsageSnapshot } from './state/chat-types';
import type { SessionChatState } from './state/chat-types';
const ChatInputBar = React.forwardRef<InputBarHandle, { sessionId: string; view?: ViewMode; onOpenDrawer: (searchMode: boolean) => void; onCloseDrawer?: () => void; onDrawerSearch?: (query: string) => void; disabled?: boolean; minimal?: boolean; onResumeCommand?: () => void; getUsageSnapshot?: (sessionId: string) => UsageSnapshot | null; onOpenPreferences?: () => void; onToast?: (msg: string) => void; getSessionState?: (sessionId: string) => SessionChatState | undefined; onOpenModelPicker?: () => void; initialInput?: string; provider?: 'claude' | 'native' }>(
  function ChatInputBar({ sessionId, view, onOpenDrawer, onCloseDrawer, onDrawerSearch, disabled, minimal, onResumeCommand, getUsageSnapshot, onOpenPreferences, onToast, getSessionState, onOpenModelPicker, initialInput, provider }, ref) {
    return <InputBar ref={ref} sessionId={sessionId} view={view} onOpenDrawer={onOpenDrawer} onCloseDrawer={onCloseDrawer} onDrawerSearch={onDrawerSearch} disabled={disabled} minimal={minimal} onResumeCommand={onResumeCommand} getUsageSnapshot={getUsageSnapshot} onOpenPreferences={onOpenPreferences} onToast={onToast} getSessionState={getSessionState} onOpenModelPicker={onOpenModelPicker} initialInput={initialInput} provider={provider} />;
  },
);

// Dev-only commit profiler for the AppInner tranche-1 perf work. Accumulates
// React commit stats on window.__appInnerProfile so before/after numbers can
// be read via console or scripts/cdp-eval.mjs against the DEV instance.
// Statically dead code in production builds (DEV-gated), tree-shaken by Vite.
declare global { interface Window { __appInnerProfile?: { commits: number; totalMs: number; maxMs: number; since: number; reset: () => void } } }
function AppInnerProfiler({ children }: { children: React.ReactNode }) {
  // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
  if (!import.meta.env.DEV) return <>{children}</>;
  if (!window.__appInnerProfile) {
    window.__appInnerProfile = {
      commits: 0, totalMs: 0, maxMs: 0, since: Date.now(),
      reset() { this.commits = 0; this.totalMs = 0; this.maxMs = 0; this.since = Date.now(); },
    };
  }
  const onRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
    const p = window.__appInnerProfile!;
    p.commits += 1;
    p.totalMs += actualDuration;
    if (actualDuration > p.maxMs) p.maxMs = actualDuration;
  };
  return <React.Profiler id="AppInner" onRender={onRender}>{children}</React.Profiler>;
}

export default function App() {
  // Auto-show buddy on launch if the user previously enabled it. The effect
  // is called unconditionally (React rules-of-hooks) but no-ops inside
  // buddy windows themselves — only the main window should re-open the
  // buddy. Optional chaining guards against preload not being ready.
  useEffect(() => {
    if (buddyMode) return;
    if (localStorage.getItem('youcoded-buddy-enabled') === '1') {
      window.claude.buddy?.show?.();
    }
  }, []);

  // Dev-only ToolCard sandbox route. Gated on import.meta.env.DEV so the
  // entire branch (including the dynamic import() below) is statically
  // dead code in production builds and tree-shaken out by Vite. Follows
  // the same ?mode= query-param convention as buddy windows above.
  // Named-export unwrap: ToolSandbox is a named export, not default.
  // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
  if (import.meta.env.DEV && buddyMode === 'tool-sandbox') {
    return <ToolSandboxRoute />;
  }

  // Buddy windows render as isolated placeholders without main-app providers
  if (buddyMode === 'buddy-mascot') return <BuddyMascotApp />;
  if (buddyMode === 'buddy-chat') return <BuddyChatApp />;
  if (buddyMode === 'buddy-bar') return <BuddyBarApp />;

  // Main app wrapped in providers
  return (
    // Root boundary catches provider-level crashes that sub-tree boundaries can't.
    // Uses inline styles only — no theme tokens, no context — so it renders even
    // when ThemeProvider itself is the thing that crashed.
    <RootErrorBoundary>
      {/* EscCloseProvider owns capture-phase ESC routing — must wrap all
          overlay-bearing providers so every overlay is a descendant. Buddy
          windows (early-returned above) don't need it. */}
      <EscCloseProvider>
      <ThemeProvider>
        <ThemeBg />
        <ThemeEffects />
        {/* Fix: AccountProvider sits outside SkillProvider so marketplace-
            context can consume auth state without introducing a circular dependency.
            MarketplaceStatsProvider sits inside auth so it can co-exist with auth
            state, but outside SkillProvider/GameProvider/ChatProvider which may
            eventually consume live stats via useMarketplaceStats(). */}
        <AccountProvider>
          {/* Always-mounted, self-driven overlay: shows a one-time handle prompt
              right after sign-in (renders nothing when not applicable). Lives here
              so it can consume useAccount() regardless of the active view. */}
          <HandlePrompt />
          {/* WorkerHealthProvider wraps stats so the stats provider can report
              network results to the health indicator via the onNetworkResult prop. */}
          <WorkerHealthProvider>
            <StatsWithHealthBridge>
              <SkillProvider>
                <GameProvider>
                  <ChatProvider>
                    {/* MarketplaceProvider lifted to app root so ThemeScreen in
                        SettingsPanel (outside the library/marketplace view) can
                        consume useMarketplace() for the favorites star + filter. */}
                    <MarketplaceProvider>
                      <AppInnerProfiler>
                        <AppInner />
                      </AppInnerProfiler>
                    </MarketplaceProvider>
                  </ChatProvider>
                </GameProvider>
              </SkillProvider>
            </StatsWithHealthBridge>
          </WorkerHealthProvider>
        </AccountProvider>
      </ThemeProvider>
      </EscCloseProvider>
    </RootErrorBoundary>
  );
}
