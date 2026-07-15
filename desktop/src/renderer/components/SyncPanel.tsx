/**
 * SyncPanel.tsx — Sync Management UI for YouCoded.
 *
 * V2 redesign: Supports multiple named backend instances with per-instance
 * sync/storage mode. Replaces the old 3-card grid with a dynamic instance
 * list, add-backend flow, per-backend overflow menu, and manual push/pull.
 *
 * Follows the same pattern as RemoteButton in SettingsPanel:
 * compact section row → createPortal popup modal.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { SyncWarning } from '../../main/sync-state';
import { deriveSyncState, type SyncDisplayState } from '../state/sync-display-state';
import { createPortal } from 'react-dom';
import SettingsExplainer, { InfoIconButton, type ExplainerSection } from './SettingsExplainer';
import SyncSetupWizard from './SyncSetupWizard';
import { useScrollFade } from '../hooks/useScrollFade';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import ConnectGithubModal from './ConnectGithubModal';

// --- Explainer content (updated for V2 multi-instance model) ---

const SYNC_EXPLAINER: { intro: string; sections: ExplainerSection[] } = {
  intro:
    "YouCoded keeps your work safe in two layers. Cross-device sync is the main one: your conversations, projects, and files live in your own private GitHub, so they're backed up AND kept up to date on every device you use. Extra cloud backups (Google Drive, iCloud) are an optional second copy on top of that.",
  sections: [
    {
      heading: 'Cross-Device Backup & Sync (the main one)',
      paragraphs: [
        "Turn this on and YouCoded stores your conversations, project folders, and personal files in private GitHub repositories — one per space. That's your primary backup and the way your work follows you from computer to computer.",
        "It needs a GitHub connection (a one-time sign-in). Changes sync automatically in the background, usually within seconds.",
      ],
    },
    {
      heading: 'Spaces',
      bullets: [
        { term: 'Personal', text: 'Your conversations, memory, skills, and anything in your Personal folder — carried to every device.' },
        { term: 'Projects', text: 'Each folder you turn sync on for becomes its own space, kept in step across your devices.' },
        { term: 'Instant sync', text: '"Connected" means changes cross devices almost immediately. If it\'s reconnecting, changes still sync every couple of minutes.' },
      ],
    },
    {
      heading: 'Additional backups (optional)',
      paragraphs: [
        "You can add Google Drive or iCloud as a second, independent copy on top of GitHub — belt and suspenders. These don't replace GitHub; cross-device sync still needs it as the primary.",
      ],
      bullets: [
        { term: 'Google Drive', text: 'Keeps a copy in a Drive folder. You can connect multiple Google accounts, each backing up independently.' },
        { term: 'iCloud', text: 'Keeps a copy in your iCloud Drive. Works on macOS and Windows (install iCloud for Windows).' },
        { term: 'Auto-backup toggle', text: 'Green = backing up automatically after changes. Off = paused; use the row menu\'s "Upload now" to back up by hand.' },
      ],
    },
    {
      heading: 'What the buttons do',
      bullets: [
        { term: 'Sync now', text: 'Pushes and pulls your synced spaces right away instead of waiting for the next automatic cycle.' },
        { term: 'Back up now', text: 'Forces an immediate copy to your additional backups (Drive/iCloud).' },
        { term: 'Upload now', text: 'Per-backup: push your local data up to that backup right now.' },
        { term: '+ Add a backup', text: 'Connect an extra Drive or iCloud copy.' },
      ],
    },
    {
      heading: 'If something looks off',
      bullets: [
        { term: "Sync won't turn on", text: 'It needs GitHub. If you see a "GitHub CLI / not signed in" message, connect GitHub and try again.' },
        { term: '"No Internet Connection"', text: 'Check your WiFi or cellular and try again.' },
        { term: 'A conflict note appeared', text: 'Two devices edited the same file — YouCoded kept both, saving the other device\'s version as a "(from …)" copy next to yours.' },
        { term: 'Something seems stuck', text: 'Open Sync Log and look for ERROR or WARN lines.' },
      ],
    },
  ],
};

// --- Types (mirror sync-state.ts V2 model) ---

interface BackendInstanceStatus {
  id: string;
  type: 'drive' | 'github' | 'icloud';
  label: string;
  syncEnabled: boolean;
  config: Record<string, string>;
  connected: boolean;
  lastPushEpoch: number | null;
  lastError: string | null;
}

interface SyncStatus {
  backends: BackendInstanceStatus[];
  lastSyncEpoch: number | null;
  backupMeta: { last_backup: string; platform: string; toolkit_version: string } | null;
  // Fix: was string[] — now matches getSyncStatus() which returns SyncWarning[].
  warnings: SyncWarning[];
  syncInProgress: boolean;
  syncingBackendId: string | null;
  syncedCategories: string[];
}

// --- Helpers ---

function timeAgo(epoch: number): string {
  const seconds = Math.floor(Date.now() / 1000 - epoch);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// Relative time from a MILLISECOND epoch (the device registry stores lastSeen in
// ms, unlike the sync backends above which use seconds). Plain words on purpose —
// the "Your devices" list is spec'd as plain text with no status glyphs.
function relativeMs(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return 'unknown';
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// Map process.platform to a plain, human word. Empty string (unknown platform)
// falls through to '' so the caller can omit it rather than print a raw code.
function platformLabel(p: string): string {
  switch (p) {
    case 'win32': return 'Windows';
    case 'darwin': return 'macOS';
    case 'linux': return 'Linux';
    default: return p || '';
  }
}

// Map the derived sync display state to a status-dot tailwind class.
// All three helpers keep the dot, label, and badge in lock-step — the old
// time-only derivation could read "Synced 3m ago" while the popup showed
// red warnings; routing everything through deriveSyncState prevents that.
function dotColorForState(state: SyncDisplayState): string {
  switch (state.kind) {
    case 'unconfigured': return 'bg-fg-muted/40';
    case 'syncing':      return 'bg-blue-400 animate-pulse';
    case 'failing':      return 'bg-red-500';
    case 'attention':    return 'bg-green-500';
    case 'synced':       return 'bg-green-500';
    case 'stale':        return 'bg-yellow-500';
    // Exhaustiveness: if a new SyncDisplayState kind is added, this assignment
    // fails at compile time — forces us to handle it here instead of silently
    // returning undefined at runtime.
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function primaryLabelForState(state: SyncDisplayState, loading: boolean): string {
  if (loading) return 'Loading...';
  switch (state.kind) {
    case 'unconfigured': return 'Not configured';
    case 'syncing':      return 'Syncing...';
    case 'failing':      return 'Sync Failing';
    case 'attention':    return state.lastSyncEpoch ? `Last synced ${timeAgo(state.lastSyncEpoch)}` : 'Never synced';
    case 'synced':       return `Last synced ${timeAgo(state.lastSyncEpoch)}`;
    case 'stale':        return state.lastSyncEpoch ? `Last synced ${timeAgo(state.lastSyncEpoch)}` : 'Never synced';
    // Exhaustiveness: same guarantee as dotColorForState — adding a new
    // SyncDisplayState kind without updating this switch is a TS error.
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function badgeForState(state: SyncDisplayState): React.ReactNode {
  if (state.kind === 'failing') {
    return (
      <span className="px-1.5 py-0.5 rounded-full bg-[#DD4444]/15 text-[#DD4444] text-[9px] font-medium shrink-0">
        {state.warningCount}
      </span>
    );
  }
  if (state.kind === 'attention') {
    return (
      <span className="px-1.5 py-0.5 rounded-full bg-[#FF9800]/15 text-[#FF9800] text-[9px] font-medium shrink-0">
        {state.warningCount}
      </span>
    );
  }
  // Every other current kind has no badge — enumerate them explicitly so a
  // new variant can't silently fall through to "no badge" without review.
  if (
    state.kind === 'unconfigured' ||
    state.kind === 'syncing' ||
    state.kind === 'synced' ||
    state.kind === 'stale'
  ) {
    return null;
  }
  // Exhaustiveness: if we reach here, SyncDisplayState grew a kind we forgot.
  // The `never` assignment fails at compile time — forces an update above.
  const _exhaustive: never = state;
  return _exhaustive;
}

const BACKEND_LABELS: Record<string, string> = {
  drive: 'Google Drive',
  github: 'GitHub',
  icloud: 'iCloud',
};

// Backend type icon + tint color for the circle background
const BACKEND_STYLE: Record<string, { icon: string; tint: string }> = {
  drive: { icon: '\u2601', tint: 'bg-blue-500/10 text-blue-400' },
  github: { icon: '\u2302', tint: 'bg-purple-500/10 text-purple-400' },
  icloud: { icon: '\u2B21', tint: 'bg-sky-500/10 text-sky-400' },
};

const CATEGORY_LABELS: Record<string, string> = {
  memory: 'Memory',
  conversations: 'Conversations',
  encyclopedia: 'Encyclopedia',
  skills: 'Skills',
  'system-config': 'System Config',
  plans: 'Plans',
  specs: 'Specs',
};

// Hover descriptions — shown via title attribute on each inline category label
const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  memory: 'Your Claude memory files and preferences',
  conversations: 'Chat history and conversation logs',
  encyclopedia: 'Your personal encyclopedia entries',
  skills: 'Custom skills you\'ve created or installed',
  'system-config': 'App settings and preferences (not passwords or API keys)',
  plans: 'Implementation plans and design documents',
  specs: 'Technical specifications and reference docs',
};

// --- Config display fields per backend type (read-only in edit form) ---
const BACKEND_CONFIG_DISPLAY: Record<string, { key: string; label: string }[]> = {
  drive: [
    { key: 'DRIVE_ROOT', label: 'Drive Folder' },
    { key: 'rcloneRemote', label: 'Connected via' },
  ],
  github: [
    { key: 'PERSONAL_SYNC_REPO', label: 'Repository' },
  ],
  icloud: [
    { key: 'ICLOUD_PATH', label: 'iCloud Path' },
  ],
};

// --- Main exported component ---

interface SyncSectionProps {
  autoOpen?: boolean;
  onAutoOpenHandled?: () => void;
}

export default function SyncSection({ autoOpen, onAutoOpenHandled }: SyncSectionProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const popupRef = useRef<HTMLDivElement>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await (window as any).claude.sync.getStatus();
      setStatus(s);
    } catch {}
    setLoading(false);
  }, []);

  // Defer initial fetch until after SettingsPanel slide-in animation
  useEffect(() => {
    const timer = setTimeout(() => { loadStatus(); }, 350);
    return () => clearTimeout(timer);
  }, [loadStatus]);

  // Keep the compact row fresh: patch sync fields from the 10s status:data push
  // so "Last synced X ago" doesn't freeze on the value captured at mount.
  // (Full status still comes from getSyncStatus — status:data only has the
  // live-updating fields: lastSyncEpoch, syncInProgress, backupMeta.)
  useEffect(() => {
    const handler = (window as any).claude?.on?.statusData?.((data: any) => {
      if (!data) return;
      setStatus(prev => {
        if (!prev) return prev;
        return {
          ...prev,
          lastSyncEpoch: data.lastSyncEpoch ?? prev.lastSyncEpoch,
          syncInProgress: data.syncInProgress ?? prev.syncInProgress,
          backupMeta: data.backupMeta ?? prev.backupMeta,
        };
      });
    });
    return () => {
      if (handler) (window as any).claude?.off?.('status:data', handler);
    };
  }, []);

  useEffect(() => {
    if (autoOpen && !open) {
      setOpen(true);
      onAutoOpenHandled?.();
    }
  }, [autoOpen, open, onAutoOpenHandled]);

  // Backend counts kept for the secondary "X synced / Y paused" caption.
  // Defensive ?. on inner fields: a malformed status payload without
  // `backends`/`warnings` must degrade to zero counts, not crash the panel.
  const syncCount = status?.backends?.filter(b => b.syncEnabled).length ?? 0;
  const storageCount = status?.backends?.filter(b => !b.syncEnabled).length ?? 0;

  // Single derivation: compact row dot + label + badge all flow from this state.
  // Severity-aware so the row can never read "Synced" while warnings are active.
  const display: SyncDisplayState = deriveSyncState({
    hasBackends: (status?.backends?.length ?? 0) > 0,
    syncInProgress: status?.syncInProgress ?? false,
    lastSyncEpoch: status?.lastSyncEpoch ?? null,
    warnings: status?.warnings ?? [],
  });

  // Gate dot color on `loading` to keep it in sync with the "Loading..." label.
  // Without this gate, once `status` arrived the dot could flip to a real
  // color during the brief render window before `setLoading(false)` fires,
  // while `primaryLabelForState` was still returning "Loading...".
  const dotColor = loading ? 'bg-fg-muted/40' : dotColorForState(display);
  const primaryLabel = primaryLabelForState(display, loading);
  const badge = badgeForState(display);

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Backup &amp; Sync</h3>

      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          <div className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">{primaryLabel}</span>
          {(syncCount + storageCount) > 0 && display.kind !== 'failing' && (
            <span className="text-[10px] text-fg-muted ml-2">
              {syncCount > 0 ? `${syncCount} synced` : ''}
              {syncCount > 0 && storageCount > 0 ? ' \u00B7 ' : ''}
              {storageCount > 0 ? `${storageCount} paused` : ''}
            </span>
          )}
        </div>
        {badge}
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && createPortal(
        <SyncPopup
          popupRef={popupRef}
          initialStatus={status}
          onClose={() => setOpen(false)}
          onRefresh={loadStatus}
        />,
        document.body
      )}
    </section>
  );
}

// --- Popup modal ---

interface SyncPopupProps {
  popupRef: React.RefObject<HTMLDivElement | null>;
  initialStatus: SyncStatus | null;
  onClose: () => void;
  onRefresh: () => void;
}

function SyncPopup({ popupRef, initialStatus, onClose, onRefresh }: SyncPopupProps) {
  // Always mounted when open (parent uses {open && <SyncPopup>}) — so open=true is correct here.
  useEscClose(true, onClose);
  const [status, setStatus] = useState<SyncStatus | null>(initialStatus);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(!initialStatus);
  const [syncing, setSyncing] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  // View stack: 'main' | 'add-type' | 'add-config' | 'edit'
  const [view, setView] = useState<'main' | 'add-type' | 'add-config' | 'edit'>('main');
  const [addType, setAddType] = useState<'drive' | 'github' | 'icloud' | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // Overflow menu state
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const mainScrollRef = useScrollFade<HTMLDivElement>();
  const logScrollRef = useScrollFade<HTMLDivElement>();
  // Per-backend action feedback
  const [actionFeedback, setActionFeedback] = useState<Record<string, string>>({});
  // Confirmation dialog state
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  // Cross-device sync spaces (spec 2026-07-03) — separate from the backend backups
  // above. Status refetches whenever the engine emits an event so the list and
  // per-space connected/local state stay live.
  const [spacesStatus, setSpacesStatus] = useState<any>(null);
  // Local error from the enable toggle itself (a rejected invoke — e.g. bridge
  // timeout on Android, which has no syncspaces handlers yet). Rendered in the
  // same red note slot as engine error events below.
  const [spacesError, setSpacesError] = useState<string | null>(null);
  // First enable provisions GitHub repos and can take seconds — without a
  // visible pending state the checkbox reads as "didn't take" to a non-developer.
  const [enabling, setEnabling] = useState(false);
  // GitHub connection state (device-flow modal). Sync's primary channel needs a
  // GitHub sign-in; we surface a "Connect GitHub…" affordance whenever the
  // structured github:status reports not-authed (NOT by parsing space-manager's
  // error strings — those are a pinned UI contract we display verbatim).
  const [githubStatus, setGithubStatus] = useState<{ installed: boolean; authed: boolean; login?: string } | null>(null);
  const [showConnectGithub, setShowConnectGithub] = useState(false);
  // When an enable attempt fails on a GitHub problem, remember it so a
  // successful connect can re-kick enable automatically ("everything appears"
  // without a second click).
  const wasMidEnableRef = useRef(false);
  // Latest handleSpacesEnable, so handleGithubConnected can re-invoke it without
  // a declaration-order / stale-closure problem (the callback is defined below).
  const handleSpacesEnableRef = useRef<((enabled: boolean) => Promise<void>) | null>(null);

  const claude = (window as any).claude;

  useEffect(() => {
    (async () => {
      try {
        const [s, log] = await Promise.all([
          claude.sync.getStatus(),
          claude.sync.getLog(30),
        ]);
        setStatus(s);
        setLogLines(log);
      } catch {}
      setLoading(false);
    })();
  }, []);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await claude.sync.getStatus();
      setStatus(s);
      onRefresh();
    } catch {}
  }, [claude, onRefresh]);

  // While the popup is open, patch live-updating fields from the 10s status:data
  // push AND refetch full status when the global marker advances so per-backend
  // lastPushEpoch values stay in sync with the compact header.
  // Ref-tracked epoch avoids scheduling refreshStatus from inside a setState
  // updater (which is a React anti-pattern and was unreliable).
  const lastSeenEpochRef = useRef<number | null>(initialStatus?.lastSyncEpoch ?? null);
  useEffect(() => {
    const handler = (window as any).claude?.on?.statusData?.((data: any) => {
      if (!data) return;
      const epoch = typeof data.lastSyncEpoch === 'number' ? data.lastSyncEpoch : null;
      const advanced = epoch !== null && epoch !== lastSeenEpochRef.current;
      if (advanced) {
        lastSeenEpochRef.current = epoch;
        // Fire-and-forget — refetches full status including per-backend markers
        refreshStatus();
      } else {
        // Same cycle: just patch the cheap fields so timeAgo() re-renders tick forward
        setStatus(prev =>
          prev
            ? {
                ...prev,
                lastSyncEpoch: epoch ?? prev.lastSyncEpoch,
                syncInProgress: data.syncInProgress ?? prev.syncInProgress,
                backupMeta: data.backupMeta ?? prev.backupMeta,
              }
            : prev,
        );
      }
    });
    return () => {
      if (handler) (window as any).claude?.off?.('status:data', handler);
    };
  }, [refreshStatus]);

  // Force sync all sync-enabled backends
  const handleForceSync = useCallback(async () => {
    setSyncing(true);
    try {
      await claude.sync.force();
      await refreshStatus();
      const log = await claude.sync.getLog(30);
      setLogLines(log);
    } catch {}
    setSyncing(false);
  }, [claude, refreshStatus]);

  const handleDismiss = useCallback(async (code: string) => {
    try {
      await claude.sync.dismissWarning(code);
      // Fix: filter by w.code now that warnings are SyncWarning objects, not strings.
      setStatus(prev => prev ? { ...prev, warnings: prev.warnings.filter(w => w.code !== code) } : prev);
    } catch {}
  }, [claude]);

  // Per-backend actions
  const handlePushBackend = useCallback(async (id: string) => {
    setActionFeedback(prev => ({ ...prev, [id]: 'uploading' }));
    try {
      const result = await claude.sync.pushBackend(id);
      setActionFeedback(prev => ({ ...prev, [id]: result.success ? 'uploaded' : 'error' }));
      await refreshStatus();
    } catch {
      setActionFeedback(prev => ({ ...prev, [id]: 'error' }));
    }
    setTimeout(() => setActionFeedback(prev => { const n = { ...prev }; delete n[id]; return n; }), 2000);
  }, [claude, refreshStatus]);

  // handlePullBackend ("Download now") was removed in sync-legacy-demolition —
  // the pull path is gone. Only the "Upload now" backup action remains.

  const handleToggleSync = useCallback(async (id: string, syncEnabled: boolean) => {
    try {
      await claude.sync.updateBackend(id, { syncEnabled });
      await refreshStatus();
    } catch {}
  }, [claude, refreshStatus]);

  const handleRemoveBackend = useCallback(async (id: string) => {
    try {
      await claude.sync.removeBackend(id);
      await refreshStatus();
    } catch {}
    setMenuOpenId(null);
  }, [claude, refreshStatus]);

  // Wizard preselect: when a warning fix-action opens the wizard for a specific backend,
  // we stash the backend id+type here so SyncSetupWizard jumps straight to the right flow.
  const [wizardPreselect, setWizardPreselect] = useState<{ id: string; type: 'drive' | 'github' | 'icloud' } | undefined>();

  const handleFixAction = useCallback(async (w: SyncWarning) => {
    const action = w.fixAction;
    if (!action) return;
    switch (action.kind) {
      case 'open-sync-setup': {
        const backendId = action.payload?.backendId;
        if (backendId) {
          const backend = status?.backends.find(b => b.id === backendId);
          if (backend) {
            setWizardPreselect({ id: backend.id, type: backend.type });
          }
        }
        setView('add-config');
        break;
      }
      case 'open-external':
        await (window as any).claude.shell.openExternal(action.payload.url);
        break;
      case 'retry': {
        setActionFeedback(prev => ({ ...prev, [action.payload.backendId]: 'uploading' }));
        try {
          await claude.sync.pushBackend(action.payload.backendId);
          setActionFeedback(prev => ({ ...prev, [action.payload.backendId]: 'uploaded' }));
        } catch {
          setActionFeedback(prev => ({ ...prev, [action.payload.backendId]: 'error' }));
        }
        await refreshStatus();
        break;
      }
      case 'dismiss':
        await handleDismiss(w.code);
        break;
    }
  }, [status, claude, refreshStatus, handleDismiss]);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!menuOpenId) return;
    const handler = () => setMenuOpenId(null);
    const timer = setTimeout(() => document.addEventListener('click', handler), 0);
    return () => { clearTimeout(timer); document.removeEventListener('click', handler); };
  }, [menuOpenId]);

  // Load synced-spaces status now, and re-load on every engine event so the
  // section reflects sync activity (conflicts, connect/disconnect) live.
  // catch {} matches the component's other fetches: a rejected invoke (e.g.
  // 30s bridge timeout on Android, which has no syncspaces handlers yet) must
  // not become an unhandled promise rejection — the section just stays empty.
  const refreshSpacesStatus = useCallback(async () => {
    try { setSpacesStatus(await (window as any).claude.syncSpaces.status()); } catch {}
  }, []);
  useEffect(() => {
    void refreshSpacesStatus();
    const off = (window as any).claude.syncSpaces.onEvent?.(() => { void refreshSpacesStatus(); });
    return () => { off?.(); };
  }, [refreshSpacesStatus]);

  // GitHub connection status. Method-exists guard so an older shim / Android
  // (no handler) degrades to null (unknown → no affordance) instead of throwing.
  const refreshGithubStatus = useCallback(async () => {
    const fn = (window as any).claude?.github?.status;
    if (typeof fn !== 'function') { setGithubStatus(null); return; }
    try { setGithubStatus(await fn()); } catch { setGithubStatus(null); }
  }, []);
  useEffect(() => { void refreshGithubStatus(); }, [refreshGithubStatus]);

  // Called by the modal after a successful connect: refresh both GitHub and
  // sync status, and if the user was mid-enable (an enable failed on a GitHub
  // problem), re-run enable so sync lights up without a second click.
  const handleGithubConnected = useCallback(async () => {
    await refreshGithubStatus();
    if (wasMidEnableRef.current) {
      wasMidEnableRef.current = false;
      await handleSpacesEnableRef.current?.(true);
    }
  }, [refreshGithubStatus]);

  // Enable/disable toggle. try/catch: on rejection, surface the message in the
  // red note slot and re-fetch status so the checkbox reflects reality instead
  // of silently staying out of sync with the engine.
  const handleSpacesEnable = useCallback(async (enabled: boolean) => {
    setEnabling(true);
    try {
      setSpacesStatus(await claude.syncSpaces.enable(enabled));
      setSpacesError(null);
      wasMidEnableRef.current = false;
    } catch (err: any) {
      setSpacesError(String(err?.message ?? err));
      // Remember an enable-turn-on that failed so a subsequent GitHub connect
      // can re-kick it automatically. (Enable also emits a provisioning error
      // event when gh is missing / not signed in — same recovery target.)
      if (enabled) wasMidEnableRef.current = true;
      await refreshSpacesStatus();
      // A failed enable is very often a GitHub problem — refresh github:status
      // so the "Connect GitHub…" affordance next to the error note is accurate.
      await refreshGithubStatus();
    }
    setEnabling(false);
  }, [claude, refreshSpacesStatus, refreshGithubStatus]);
  useEffect(() => { handleSpacesEnableRef.current = handleSpacesEnable; }, [handleSpacesEnable]);

  // Recent sync events for DISPLAY only. `hub-status` entries drive the
  // "Instant sync" status line below (that's their surface); `projects-changed`
  // is a pure list-refresh signal (2026-07-13) with no user-facing notice.
  // Filtering both out keeps the conflict/error notices clean. The raw events
  // stay in spacesStatus.recentEvents — only the display is filtered.
  const visibleSpaceEvents = ((spacesStatus?.recentEvents ?? []) as any[])
    .filter(e => e.type !== 'hub-status' && e.type !== 'projects-changed');

  if (loading) {
    // Overlay layer L2 — theme-driven via Scrim/OverlayPanel (matches SettingsPanel popups).
    return (
      <>
        <Scrim layer={2} onClick={onClose} />
        <OverlayPanel
          layer={2}
          className="fixed overflow-hidden"
          style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(520px, 90vw)', height: 'min(640px, 85vh)' }}
        >
          <div className="flex items-center justify-center h-full text-fg-muted text-sm">Loading...</div>
        </OverlayPanel>
      </>
    );
  }

  return (
    // Overlay layer L2 — theme-driven via Scrim/OverlayPanel (matches SettingsPanel popups).
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        ref={popupRef}
        layer={2}
        className="fixed overflow-hidden"
        style={{
          top: '50%', left: '50%', transform: 'translate(-50%, -50%)',
          width: 'min(520px, 90vw)', height: 'min(640px, 85vh)',
        }}
      >
        {showInfo ? (
          <SettingsExplainer
            title="Backup & Sync"
            intro={SYNC_EXPLAINER.intro}
            sections={SYNC_EXPLAINER.sections}
            onBack={() => setShowInfo(false)}
            onClose={onClose}
          />
        ) : (view === 'add-type' || view === 'add-config') ? (
          // Guided setup wizard handles type selection, prereq check, OAuth, and config
          <SyncSetupWizard
            initialType={addType ?? undefined}
            existingBackends={(status?.backends ?? []).map(b => ({ type: b.type, config: b.config }))}
            onComplete={async (instance) => {
              try {
                await claude.sync.addBackend(instance);
                // Trigger first sync immediately
                await claude.sync.force();
                await refreshStatus();
              } catch {}
            }}
            onClose={() => { setView('main'); setAddType(null); setWizardPreselect(undefined); }}
            preselectedBackendId={wizardPreselect?.id}
            preselectedBackendType={wizardPreselect?.type}
          />
        ) : view === 'edit' && editingId ? (
          <EditBackendForm
            backend={status?.backends.find(b => b.id === editingId) ?? null}
            onSave={async (updates) => {
              try {
                await claude.sync.updateBackend(editingId, updates);
                await refreshStatus();
              } catch {}
              setView('main');
              setEditingId(null);
            }}
            onBack={() => { setView('main'); setEditingId(null); }}
            onClose={onClose}
          />
        ) : (
        <div className="flex flex-col h-full">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
            <h2 className="text-sm font-bold text-fg">Backup &amp; Sync</h2>
            <div className="flex items-center gap-1">
              <InfoIconButton onClick={() => setShowInfo(true)} />
              <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-sm hover:bg-inset">
                {'\u2715'}
              </button>
            </div>
          </div>

          {/* Scrollable content — padding on inner wrapper so sticky fades sit flush. */}
          <div ref={mainScrollRef} className="scroll-fade flex-1">
            <div className="px-4 py-4 space-y-6">

            {/* ============================================================
                PRIMARY — Cross-Device Backup & Sync (GitHub). Spec 2026-07-03.
                One private GitHub repo per space is BOTH the cross-device sync
                channel and a versioned cloud backup, so it's the headline system
                and leads the panel; the Drive/iCloud backups below are optional
                secondary failsafes.
                FUTURE (spec §11 / Phase 2c): GitHub is removed as a *separate
                backup backend* and the extra-backup layer becomes a daily
                Drive/iCloud job. Today the two engines still run side by side —
                this copy is written to stay correct through that change. Note for
                dogfood: the GitHub side does not yet carry memory/encyclopedia/
                skills (2c wires those into the Personal space), so the Drive
                backup is still load-bearing until then — don't turn it off. */}
            <section>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="text-sm font-semibold text-fg">Cross-Device Backup &amp; Sync</h3>
                  <p className="text-[11px] text-fg-muted mt-1 leading-relaxed">
                    Your conversations, projects, and files are backed up to your private
                    GitHub and kept in sync on every device you use. Requires a GitHub connection.
                  </p>
                </div>
                <div className="flex items-center gap-2 shrink-0 pt-0.5">
                  {/* Plain-word pending state — first enable provisions repos and takes seconds. */}
                  {enabling && <span className="text-[10px] text-fg-muted">Setting up…</span>}
                  {/* Green switch = on, matching the per-backup toggles below. */}
                  <button
                    role="switch"
                    aria-checked={!!spacesStatus?.enabled}
                    disabled={enabling}
                    onClick={() => void handleSpacesEnable(!spacesStatus?.enabled)}
                    className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${spacesStatus?.enabled ? 'bg-green-600' : 'bg-inset'} ${enabling ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
                    title={spacesStatus?.enabled ? 'Cross-device sync on — click to turn off' : 'Cross-device sync off — click to turn on'}
                  >
                    <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all"
                      style={{ left: spacesStatus?.enabled ? '18px' : '2px' }} />
                  </button>
                </div>
              </div>

              {/* GitHub connection line. Shown whenever we know the status:
                  a plain "connected as <login>" when authed (no status glyph),
                  or a "Connect GitHub…" affordance when not. Gates on the
                  structured github:status, never on the error strings. */}
              {githubStatus && (
                githubStatus.authed ? (
                  <p className="text-xs text-fg-muted mt-2">
                    GitHub connected{githubStatus.login ? <> as <span className="text-fg-2">{githubStatus.login}</span></> : ''}
                  </p>
                ) : (
                  <button
                    onClick={() => setShowConnectGithub(true)}
                    className="text-xs mt-2 text-accent hover:underline"
                  >
                    Connect GitHub…
                  </button>
                )
              )}

              {spacesStatus?.enabled && (
                <ul className="mt-3 space-y-1">
                  {(spacesStatus.spaces?.map((s: any) => (
                    <li key={s.id} className="text-xs text-fg-2 flex items-center justify-between">
                      <span>{s.id === 'personal' ? 'Personal' : s.id.replace('project:', '')}</span>
                      <span className="text-[10px] text-fg-muted">{s.remote ? 'connected' : 'local only'}</span>
                    </li>
                  )) ?? [])}
                </ul>
              )}

              {/* Instant sync (SyncHub, Plan 1b) — plain words, no status glyphs. */}
              {spacesStatus?.enabled && spacesStatus?.syncHub && spacesStatus.syncHub !== 'off' && (
                <p className="text-xs text-fg-muted mt-2">
                  {spacesStatus.syncHub === 'connected'
                    ? 'Instant sync: connected'
                    : 'Instant sync: reconnecting — changes still sync every couple of minutes'}
                </p>
              )}

              {spacesStatus?.enabled && visibleSpaceEvents.some((e: any) => e.type === 'conflict') && (
                <p className="text-xs text-amber-600 mt-2">
                  Some files had conflicting edits — the other device's copy was kept alongside yours
                  (look for "(from …)" files).
                </p>
              )}

              {/* Informational notice (e.g. the large-history warning, spec §7).
                  NON-alarming muted styling — deliberately NOT the red error note
                  below: a 'notice' means sync still works, so it must not read as
                  "sync is broken". */}
              {spacesStatus?.enabled && (() => {
                const notice = [...visibleSpaceEvents].reverse().find((e: any) => e.type === 'notice');
                return notice ? <p className="text-xs text-fg-muted mt-2">{notice.message}</p> : null;
              })()}

              {/* Error slot stays OUTSIDE the enabled gate: a failed enable attempt
                  (e.g. gh not installed) sets spacesError / emits an engine error while
                  enabled is still false, and space-manager's friendly messages are
                  contractually shown verbatim. */}
              {(() => {
                const engineError = [...visibleSpaceEvents].reverse().find((e: any) => e.type === 'error');
                const msg = spacesError ?? engineError?.message;
                if (!msg) return null;
                // Keep the raw message verbatim (space-manager's friendly strings
                // are a pinned UI contract). The "Connect GitHub…" button is an
                // ADDITIVE affordance, gated on the structured not-authed state —
                // NOT on parsing the error text.
                return (
                  <div className="mt-2 space-y-1">
                    <p className="text-xs text-red-500">{msg}</p>
                    {githubStatus && !githubStatus.authed && (
                      <button
                        onClick={() => setShowConnectGithub(true)}
                        className="text-xs text-accent hover:underline"
                      >
                        Connect GitHub…
                      </button>
                    )}
                  </div>
                );
              })()}

              {spacesStatus?.enabled && (
                /* .catch: void doesn't swallow rejections — route a failed invoke
                   (bridge timeout) into the red note slot instead of an unhandled rejection. */
                <button
                  onClick={() => void (window as any).claude.syncSpaces.syncNow().catch((err: any) => setSpacesError(String(err?.message ?? err)))}
                  className="text-xs mt-2 underline text-fg-muted"
                >
                  Sync now
                </button>
              )}

              {/* Your devices (Plan 2b spec §10a) — the synced device registry.
                  Plain text only (no status dots/glyphs — user preference); the
                  current machine is marked "(this device)" and each name is an
                  inline-editable nickname. Gated on sync being on: the registry
                  lives inside the Personal space, so there's nothing to list until
                  sync has a personal root. */}
              <YourDevices enabled={!!spacesStatus?.enabled} />
            </section>

            {/* Divider between the primary GitHub system and the optional extras. */}
            <div className="border-t border-edge-dim" />

            {/* ============================================================
                SECONDARY — Additional cloud backups (Drive/iCloud), optional.
                Belt-and-suspenders copies on top of the GitHub primary. */}
            <div>
              <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-1">Additional backups · optional</h3>
              <p className="text-[11px] text-fg-muted mb-3 leading-relaxed">
                A second copy on top of GitHub — belt and suspenders. GitHub stays your
                primary; these don't replace it.
              </p>

              {status?.backends && status.backends.length > 0 ? (
                <div className="space-y-2">
                  {(() => {
                    // Fix: warnings are now SyncWarning objects, not strings — check by .code.
                    const isOffline = status.warnings.some(w => w.code === 'OFFLINE');
                    return status.backends.map(b => {
                  // Pending = sync-enabled backend that can't currently push (offline or errored)
                  const isPending = b.syncEnabled && (b.lastError != null || isOffline);
                  return (
                    <div
                      key={b.id}
                      className={`rounded-lg border px-3 py-2.5 flex items-center gap-3 ${
                        b.lastError ? 'border-red-500/20 bg-red-500/5' :
                        b.syncEnabled && b.connected ? 'border-green-500/20 bg-green-500/5' :
                        'border-edge bg-inset/30'
                      }`}
                    >
                      {/* Type icon */}
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-sm shrink-0 ${BACKEND_STYLE[b.type]?.tint ?? ''}`}>
                        {BACKEND_STYLE[b.type]?.icon ?? '?'}
                      </div>

                      {/* Name + detail */}
                      <div className="flex-1 min-w-0">
                        <div className="text-xs text-fg font-medium truncate">{b.label}</div>
                        <div className="text-[10px] text-fg-faint truncate">
                          {b.lastError ? b.lastError :
                           b.lastPushEpoch ? `Backed up ${timeAgo(b.lastPushEpoch)}` :
                           !b.syncEnabled ? 'Auto-backup paused' :
                           'Never backed up'}
                        </div>
                        {/* Pending changes badge — only when sync is on but blocked */}
                        {isPending && !actionFeedback[b.id] && (
                          <span className="text-[9px] font-medium text-amber-400">Changes pending upload</span>
                        )}
                        {/* Action feedback badge */}
                        {actionFeedback[b.id] && (
                          <span className={`text-[9px] font-medium ${
                            actionFeedback[b.id] === 'error' ? 'text-red-400' :
                            actionFeedback[b.id]?.includes('ing') ? 'text-blue-400' :
                            'text-green-400'
                          }`}>
                            {actionFeedback[b.id] === 'uploading' ? 'Uploading...' :
                             actionFeedback[b.id] === 'uploaded' ? 'Uploaded!' :
                             'Error'}
                          </span>
                        )}
                      </div>

                      {/* Status dot — same severity logic as the panel-wide row, scoped to this backend.
                          Action-feedback "uploading" overlays the helper-derived color. */}
                      {(() => {
                        const scopedDisplay = deriveSyncState({
                          hasBackends: true,
                          // syncInProgress is global; per-backend "syncing" comes from per-backend action feedback below.
                          syncInProgress: false,
                          lastSyncEpoch: b.lastPushEpoch,
                          warnings: status.warnings,
                          scope: { backendId: b.id },
                        });
                        const inFlight = actionFeedback[b.id]?.includes('ing');
                        const baseClass = dotColorForState(scopedDisplay);
                        // When the backend isn't connected/sync-enabled at all, dim the dot regardless of warnings.
                        const offline = !b.syncEnabled || !b.connected;
                        const dotClass = inFlight
                          ? 'bg-blue-400 animate-pulse'
                          : offline && scopedDisplay.kind !== 'failing'
                            ? 'bg-fg-muted/40'
                            : baseClass;
                        return <div className={`w-2 h-2 rounded-full shrink-0 ${dotClass}`} />;
                      })()}

                      {/* Sync toggle — green when auto-sync, gray when storage-only */}
                      <button
                        onClick={() => handleToggleSync(b.id, !b.syncEnabled)}
                        className={`relative w-8 h-4 rounded-full transition-colors shrink-0 ${
                          b.syncEnabled ? 'bg-green-600' : 'bg-inset'
                        }`}
                        title={b.syncEnabled ? 'Auto-backup on \u2014 click to pause' : 'Auto-backup paused \u2014 click to resume'}
                      >
                        <div className="absolute top-0.5 w-3 h-3 rounded-full bg-white shadow-sm transition-all"
                          style={{ left: b.syncEnabled ? '18px' : '2px' }} />
                      </button>

                      {/* Overflow menu (three-dot) */}
                      <div className="relative shrink-0">
                        <button
                          onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === b.id ? null : b.id); }}
                          className="w-6 h-6 flex items-center justify-center rounded hover:bg-inset text-fg-muted hover:text-fg-2 text-xs"
                        >
                          {'\u00B7\u00B7\u00B7'}
                        </button>
                        {menuOpenId === b.id && (
                          /* Overflow menu — .layer-surface for theme-consistent look + glass. */
                          <div className="layer-surface absolute right-0 top-7 w-40 py-1"
                            style={{ zIndex: 10 }}
                            onClick={(e) => e.stopPropagation()}>
                            <MenuButton onClick={() => { handlePushBackend(b.id); setMenuOpenId(null); }}>Upload now</MenuButton>
                            <MenuButton onClick={() => { claude.sync.openFolder(b.id); setMenuOpenId(null); }}>Open folder</MenuButton>
                            <MenuButton onClick={() => { setEditingId(b.id); setView('edit'); setMenuOpenId(null); }}>Edit settings</MenuButton>
                            <div className="border-t border-edge-dim my-1" />
                            <MenuButton danger onClick={() => { setConfirmRemoveId(b.id); setMenuOpenId(null); }}>Remove</MenuButton>
                          </div>
                        )}
                      </div>
                    </div>
                  ); }); })()}
                </div>
              ) : (
                <div className="text-center py-6">
                  <div className="text-fg-muted text-sm mb-1">No extra backups yet</div>
                  <div className="text-fg-faint text-[11px] mb-3">GitHub already backs you up — add Drive or iCloud for a second copy.</div>
                </div>
              )}

              {/* Add backend button */}
              <button
                onClick={() => setView('add-type')}
                className="w-full mt-2 border border-dashed border-edge-dim rounded-lg py-3 text-center text-[11px] text-fg-muted hover:text-fg-2 hover:border-edge hover:bg-inset/30 transition-colors"
              >
                + Add a backup
              </button>
            </div>

            {/* Back up now — forces an immediate copy to the additional backups
                (sync.force drives the legacy Drive/iCloud/GitHub-backup engine).
                Only meaningful when at least one extra backup is configured, so it's
                gated on backends existing. The cross-device "Sync now" is up in the
                primary section — these are two different actions, hence two verbs. */}
            {(status?.backends?.length ?? 0) > 0 && (
              <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-inset/50">
                <div>
                  <div className="text-xs text-fg font-medium">
                    {status?.syncInProgress || syncing
                      ? 'Backing up…'
                      : status?.lastSyncEpoch
                        ? `Last backed up ${timeAgo(status.lastSyncEpoch)}`
                        : 'Not backed up yet'}
                  </div>
                </div>
                <button
                  onClick={handleForceSync}
                  disabled={syncing}
                  className={`px-3 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
                    syncing
                      ? 'bg-blue-500/20 text-blue-300 cursor-wait'
                      : 'bg-blue-600 hover:bg-blue-500 text-white cursor-pointer'
                  }`}
                >
                  {syncing ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3 h-3 border-2 border-blue-300/30 border-t-blue-300 rounded-full animate-spin" />
                      Backing up
                    </span>
                  ) : 'Back up now'}
                </button>
              </div>
            )}

            {/* 3. Warnings — typed SyncWarning objects with title/body/fix-action/stderr */}
            {status?.warnings && status.warnings.length > 0 && (
              <div>
                <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-2">Warnings</h3>
                <div className="space-y-2">
                  {status.warnings.map((w) => (
                    <div
                      key={`${w.code}:${w.backendId ?? ''}`}
                      className={`rounded-lg border px-3 py-2 ${
                        w.level === 'danger'
                          ? 'border-red-500/30 bg-red-500/5'
                          : 'border-amber-500/30 bg-amber-500/5'
                      }`}
                    >
                      <div className="text-xs font-medium text-fg">{w.title}</div>
                      <div className="text-[11px] text-fg-muted mt-0.5">{w.body}</div>
                      {/* Collapsible stderr for UNKNOWN-code warnings where raw output helps diagnose */}
                      {w.code === 'UNKNOWN' && w.stderr && (
                        <details className="mt-1">
                          <summary className="text-[10px] text-fg-faint cursor-pointer">
                            Show error details
                          </summary>
                          <pre className="mt-1 p-2 bg-inset rounded text-[10px] whitespace-pre-wrap font-mono">
                            {w.stderr}
                          </pre>
                        </details>
                      )}
                      <div className="flex gap-2 mt-2">
                        {w.fixAction && (
                          <button
                            onClick={() => handleFixAction(w)}
                            className="text-[11px] px-2 py-0.5 rounded bg-accent text-on-accent hover:brightness-110"
                          >
                            {w.fixAction.label}
                          </button>
                        )}
                        {w.dismissible && (
                          <button
                            onClick={() => handleDismiss(w.code)}
                            className="text-[11px] px-2 py-0.5 rounded border border-edge-dim text-fg-muted hover:bg-inset"
                          >
                            Dismiss
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* 4. Synced Data Categories — read-only inline list.
                Tiles used to look like buttons (border + cursor-help) but did nothing.
                Now passive text with per-item hover tooltips on the default cursor. */}
            {status && status.syncedCategories.length > 0 && (
              <div>
                <span className="text-[10px] font-medium text-fg-muted tracking-wider uppercase">Includes </span>
                <span className="text-[11px] text-fg-dim">
                  {status.syncedCategories.flatMap((cat, i) => {
                    const label = (
                      <span key={cat} title={CATEGORY_DESCRIPTIONS[cat] || ''}>
                        {CATEGORY_LABELS[cat] || cat}
                      </span>
                    );
                    return i === 0 ? [label] : [<span key={`sep-${cat}`} aria-hidden="true"> {'·'} </span>, label];
                  })}
                </span>
              </div>
            )}

            {/* 5. Sync Log (collapsible) */}
            <div>
              <button
                onClick={async () => {
                  setShowLog(!showLog);
                  if (!showLog) {
                    try { const log = await claude.sync.getLog(30); setLogLines(log); } catch {}
                  }
                }}
                className="flex items-center gap-1.5 text-[10px] font-medium text-fg-muted tracking-wider uppercase hover:text-fg-2 transition-colors"
              >
                <svg className={`w-3 h-3 transition-transform ${showLog ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                Sync Log
              </button>

              {showLog && (
                <div className="mt-2">
                  {logLines.length === 0 ? (
                    <div className="text-[11px] text-fg-faint px-2 py-3">No sync log entries yet.</div>
                  ) : (
                    <div ref={logScrollRef} className="scroll-fade max-h-48 rounded-lg bg-inset/40 border border-edge-dim">
                      <pre className="text-[10px] text-fg-dim font-mono px-2 py-2 whitespace-pre-wrap break-all leading-relaxed">
                        {logLines.map((line, i) => {
                          try {
                            const entry = JSON.parse(line);
                            const levelColor = entry.level === 'ERROR' ? 'text-[#DD4444]'
                              : entry.level === 'WARN' ? 'text-[#FF9800]'
                              : 'text-fg-dim';
                            return (
                              <div key={i} className="py-0.5">
                                <span className="text-fg-faint">{entry.ts?.slice(11) || ''} </span>
                                <span className={levelColor}>[{entry.level}]</span>{' '}
                                <span className="text-fg-dim">{entry.msg}</span>
                              </div>
                            );
                          } catch {
                            return <div key={i} className="py-0.5">{line}</div>;
                          }
                        })}
                      </pre>
                    </div>
                  )}
                  <button
                    onClick={async () => { try { setLogLines(await claude.sync.getLog(30)); } catch {} }}
                    className="mt-1.5 text-[10px] text-fg-muted hover:text-fg-2 transition-colors"
                  >
                    Refresh
                  </button>
                </div>
              )}
            </div>

            {/* Empty state before the first sync status arrives. Copy fix: this
                used to say "Install the YouCoded toolkit" — the toolkit is
                deprecated and the app owns sync natively now. */}
            {!status && !loading && (
              <div className="text-center py-6">
                <div className="text-fg-muted text-sm mb-1">No Sync Data</div>
                <div className="text-fg-faint text-[11px]">Sync hasn't run yet. Configure a backup destination to get started.</div>
              </div>
            )}
            </div>
          </div>
        </div>
        )}
      </OverlayPanel>

      {/* Connect-GitHub device-flow modal. Own L2 overlay so it sits above the
          sync popup. onConnected refreshes github status + re-kicks a failed
          enable; every close path aborts main's poll inside the modal. */}
      {showConnectGithub && (
        <ConnectGithubModal
          onClose={() => setShowConnectGithub(false)}
          onConnected={() => { void handleGithubConnected(); }}
        />
      )}

      {/* Confirmation dialog: Remove backend */}
      {confirmRemoveId && (() => {
        const target = status?.backends.find(b => b.id === confirmRemoveId);
        return target ? (
          <ConfirmDialog
            title="Remove backup?"
            message={<>Remove <strong>{target.label}</strong>? This disconnects this backup destination. Your backed-up data in {BACKEND_LABELS[target.type]} won't be deleted &mdash; you can reconnect later.</>}
            confirmLabel="Remove"
            confirmColor="red"
            onConfirm={() => { handleRemoveBackend(confirmRemoveId); setConfirmRemoveId(null); }}
            onCancel={() => setConfirmRemoveId(null)}
          />
        ) : null;
      })()}

      {/* The "Download from backup" confirmation dialog was removed in
          sync-legacy-demolition — there is no pull/restore path anymore. */}
    </>
  );
}

// --- Confirmation dialog (reusable) ---
// L3 destructive confirmation — uses OverlayPanel destructive variant for theme-driven danger border.

function ConfirmDialog({
  title, message, confirmLabel, confirmColor, onConfirm, onCancel,
}: {
  title: string;
  message: React.ReactNode;
  confirmLabel: string;
  confirmColor: 'red' | 'blue';
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const borderColor = confirmColor === 'red' ? 'border-red-600/30' : 'border-blue-600/30';
  const headerBg = confirmColor === 'red' ? 'bg-red-600/10' : 'bg-blue-600/10';
  const headerText = confirmColor === 'red' ? 'text-[#DD4444]' : 'text-blue-400';
  const btnBg = confirmColor === 'red'
    ? 'bg-red-600/70 hover:bg-red-600/90 text-white'
    : 'bg-blue-600 hover:bg-blue-500 text-white';

  return createPortal(
    // Overlay layer L3 — destructive confirmations use OverlayPanel destructive variant.
    <>
      <Scrim layer={3} onClick={onCancel} />
      <OverlayPanel
        layer={3}
        destructive={confirmColor === 'red'}
        className="fixed overflow-hidden"
        style={{ top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: 'min(360px, 85vw)' }}
      >
        <div className={`px-4 py-3 border-b ${borderColor} ${headerBg}`}>
          <h3 className={`text-xs font-bold ${headerText}`}>{title}</h3>
        </div>
        <div className="px-4 py-3 space-y-3">
          <p className="text-[11px] text-fg-dim leading-relaxed">{message}</p>
          <div className="flex gap-2 pt-1">
            <button
              onClick={onCancel}
              className="flex-1 px-3 py-1.5 text-[11px] font-medium rounded-md bg-inset hover:bg-edge text-fg-muted transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirm}
              className={`flex-1 px-3 py-1.5 text-[11px] font-medium rounded-md transition-colors ${btnBg}`}
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}

// --- "Your devices" list (Plan 2b spec §10a) ---
// Shows every device in the synced device registry: friendly (inline-editable)
// name, "last seen <relative>", and a plain "(this device)" suffix for the
// current machine. Deliberately PLAIN TEXT — no status dots or ●◐○ glyphs
// (the section is spec'd plain, and the owner dislikes status glyphs).

interface DeviceRow {
  schemaVersion: number;
  id: string;
  name: string;
  platform: string;
  lastSeen: number;
  updatedAt: number;
  self: boolean; // marks THIS machine (matched by deviceId in the main handler)
}

function YourDevices({ enabled }: { enabled: boolean }) {
  // null = not loaded yet; [] = loaded-but-empty (sync off / no personal root).
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const load = useCallback(async () => {
    // Method-exists guard: on remote / older Android without the handler the
    // invoke is absent, so degrade to an empty list instead of throwing.
    const fn = window.claude?.syncSpaces?.listDevices;
    if (typeof fn !== 'function') { setDevices([]); return; }
    try { setDevices(await fn()); } catch { setDevices([]); }
  }, []);

  // Load on mount and whenever sync flips on — the first enable provisions the
  // Personal space that backs the registry, so the list can go empty → populated.
  useEffect(() => { void load(); }, [load, enabled]);

  const commitRename = useCallback(async (id: string) => {
    const name = draft.trim();
    setEditingId(null);
    // Reject empty/whitespace (the store no-ops on empty anyway) and skip a
    // no-op rename so we don't fire a pointless invoke + refetch.
    if (!name) return;
    const current = devices?.find(d => d.id === id);
    if (current && current.name === name) return;
    const fn = window.claude?.syncSpaces?.renameDevice;
    if (typeof fn !== 'function') return;
    try { await fn(id, name); } catch {}
    // Re-fetch so the merged/synced name (fold-on-read authoritative) is shown.
    await load();
  }, [draft, devices, load]);

  if (!enabled) return null;

  return (
    <div className="mt-3">
      <h4 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-1.5">Your devices</h4>
      {devices !== null && devices.length === 0 ? (
        <p className="text-[11px] text-fg-muted">No devices yet — they appear here once sync has run.</p>
      ) : (
        <ul className="space-y-1">
          {(devices ?? []).map(d => {
            const plat = platformLabel(d.platform);
            const activity = d.self ? 'active now' : `last seen ${relativeMs(d.lastSeen)}`;
            const right = plat ? `${plat} · ${activity}` : activity;
            return (
              <li key={d.id} className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex items-center gap-1.5">
                  {editingId === d.id ? (
                    <input
                      value={draft}
                      autoFocus
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename(d.id);
                        if (e.key === 'Escape') setEditingId(null); // cancel — no rename
                      }}
                      onBlur={() => void commitRename(d.id)}
                      className="bg-inset text-fg text-xs rounded px-2 py-1 border border-edge-dim focus:border-accent outline-none min-w-0"
                    />
                  ) : (
                    // Click the name to edit — it's just a nickname, so no confirm gate.
                    <button
                      type="button"
                      onClick={() => { setEditingId(d.id); setDraft(d.name); }}
                      className="text-xs text-fg-2 hover:text-fg truncate text-left"
                      title="Click to rename this device"
                    >
                      {d.name}
                    </button>
                  )}
                  {d.self && <span className="text-[10px] text-fg-muted shrink-0">(this device)</span>}
                </div>
                <span className="text-[10px] text-fg-muted shrink-0">{right}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// --- Overflow menu button ---

function MenuButton({ children, onClick, danger }: { children: React.ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-1.5 text-[11px] transition-colors ${
        danger ? 'text-red-400 hover:bg-red-500/10' : 'text-fg hover:bg-inset'
      }`}
    >
      {children}
    </button>
  );
}

// --- Sub-view header (shared by add/edit flows) ---

function SubViewHeader({ title, onBack, onClose }: { title: string; onBack: () => void; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
      <div className="flex items-center gap-2">
        <button onClick={onBack} className="text-fg-muted hover:text-fg-2 w-6 h-6 flex items-center justify-center rounded hover:bg-inset">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <h2 className="text-sm font-bold text-fg">{title}</h2>
      </div>
      <button onClick={onClose} className="text-fg-muted hover:text-fg-2 text-lg leading-none w-8 h-8 flex items-center justify-center rounded-sm hover:bg-inset">
        {'\u2715'}
      </button>
    </div>
  );
}

// (AddBackendTypePicker and AddBackendConfigForm removed — replaced by SyncSetupWizard)

// --- Edit backend settings ---

function EditBackendForm({
  backend, onSave, onBack, onClose,
}: {
  backend: BackendInstanceStatus | null;
  onSave: (updates: { label?: string }) => void;
  onBack: () => void;
  onClose: () => void;
}) {
  const [label, setLabel] = useState(backend?.label ?? '');
  const [saving, setSaving] = useState(false);
  const actionsScrollRef = useScrollFade<HTMLDivElement>();

  if (!backend) return null;

  const displayFields = BACKEND_CONFIG_DISPLAY[backend.type] || [];

  const handleSave = async () => {
    setSaving(true);
    // Only the label is editable — config changes require remove + re-add
    await onSave({ label: label.trim() });
    setSaving(false);
  };

  return (
    <div className="flex flex-col h-full">
      <SubViewHeader title={`Edit ${backend.label}`} onBack={onBack} onClose={onClose} />
      <div ref={actionsScrollRef} className="scroll-fade flex-1">
        <div className="px-4 py-4 space-y-4">
        <div>
          <label className="block text-[10px] text-fg-muted mb-1">Name</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className="w-full px-2 py-1.5 rounded-md bg-inset border border-edge-dim text-xs text-fg focus:border-accent focus:outline-none"
          />
        </div>

        {/* Config fields are read-only — prevents users from breaking rclone remotes or repo URLs */}
        {displayFields.map(field => (
          <div key={field.key}>
            <div className="text-[10px] text-fg-muted mb-1">{field.label}</div>
            <div className="px-2 py-1.5 rounded-md bg-inset/30 border border-edge-dim text-xs text-fg-dim">
              {backend.config[field.key] || '(not set)'}
            </div>
          </div>
        ))}
        <div className="text-[10px] text-fg-faint">
          To change these settings, remove this backup and add a new one.
        </div>

        <button
          onClick={handleSave}
          disabled={!label.trim() || saving}
          className={`px-4 py-1.5 rounded-md text-[11px] font-medium transition-colors ${
            saving ? 'bg-accent/20 text-accent/60 cursor-wait' : 'bg-accent hover:bg-accent/80 text-on-accent cursor-pointer'
          }`}
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        </div>
      </div>
    </div>
  );
}
