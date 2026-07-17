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
import type { PastSession } from '../../shared/types';
import SettingsRow from './SettingsRow';
import { latestUnresolvedError, type SyncStatusData } from './sync-dot-state';

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

// Module-level cache of the last session.browse() result. WHY: the popup
// re-fetches conversations every time it opens, so the Conversations count
// pill flashed "0" for a beat before the real number arrived. Seeding the
// popup's state from the last-known list shows the previous count instantly
// while the fresh fetch updates it in place. Module scope is the lightest
// fix — Devices/Projects don't flash because their fetches are fast local
// reads, so only this slower browse() call needs a cache.
let conversationsCache: PastSession[] | null = null;

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

  const counts = (syncCount + storageCount) > 0 && display.kind !== 'failing'
    ? [syncCount > 0 ? `${syncCount} synced` : '', storageCount > 0 ? `${storageCount} paused` : ''].filter(Boolean).join(' \u00B7 ')
    : '';

  return (
    <>
      <SettingsRow
        icon={<div className={`w-2.5 h-2.5 rounded-full ${dotColor}`} />}
        title="Backup & Sync"
        subtitle={counts ? `${primaryLabel} \u00B7 ${counts}` : primaryLabel}
        rightAccessory={badge}
        onClick={() => setOpen(true)}
      />

      {open && createPortal(
        <SyncPopup
          popupRef={popupRef}
          initialStatus={status}
          onClose={() => setOpen(false)}
          onRefresh={loadStatus}
        />,
        document.body
      )}
    </>
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
  // Count-tabs (Devices/Projects/Conversations) — which pill's list shows below the header.
  const [countTab, setCountTab] = useState<'dev' | 'proj' | 'conv'>('dev');
  // Devices in the synced registry — lifted out of the old YourDevices component so
  // the "Devices" count tab and its list share ONE fetch. null = not loaded yet.
  const [devices, setDevices] = useState<DeviceRow[] | null>(null);
  // Past conversations across all projects — only used for the Conversations count +
  // list. There's no dedicated count IPC, so we reuse session.browse(). Seeded from
  // the module-level cache so reopening the popup shows the last-known count
  // immediately instead of flashing 0. null = never loaded in this app run.
  const [conversations, setConversations] = useState<PastSession[] | null>(conversationsCache);
  // Local "a syncNow() is in flight" flag — drives the blue "Syncing…" header while the
  // box's Sync now / Try again runs (spacesStatus carries no live in-progress signal).
  const [spacesSyncing, setSpacesSyncing] = useState(false);
  // Local "additional backups master intent". The derived master-on is
  // backends.some(syncEnabled), which can NEVER be true with zero backends — so this
  // lets the master toggle reveal the inline Drive/iCloud picker on an empty list
  // without persisting anything. Reset whenever the master is turned back off.
  const [additionalIntent, setAdditionalIntent] = useState(false);
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

  // Device registry fetch (lifted from YourDevices). Method-exists guard so remote /
  // older Android without the handler degrades to an empty list instead of throwing.
  const loadDevices = useCallback(async () => {
    const fn = (window as any).claude?.syncSpaces?.listDevices;
    if (typeof fn !== 'function') { setDevices([]); return; }
    try { setDevices(await fn()); } catch { setDevices([]); }
  }, []);
  const handleRenameDevice = useCallback(async (id: string, name: string) => {
    const fn = (window as any).claude?.syncSpaces?.renameDevice;
    if (typeof fn !== 'function') return;
    try { await fn(id, name); } catch {}
    await loadDevices(); // re-fetch so the fold-on-read authoritative name is shown
  }, [loadDevices]);
  // Load devices on mount and whenever sync flips on — the first enable provisions the
  // Personal space that backs the registry, so the list can go empty -> populated.
  useEffect(() => { void loadDevices(); }, [loadDevices, spacesStatus?.enabled]);

  // Conversations for the count tab. session.browse() can be a touch slow, so this is
  // fire-and-forget and non-blocking; [] on failure keeps the count at zero.
  useEffect(() => {
    (async () => {
      try {
        const list = await claude.session?.browse?.();
        const fresh = Array.isArray(list) ? list : [];
        // Keep the module cache current so the NEXT popup open starts from this value.
        conversationsCache = fresh;
        setConversations(fresh);
      } catch {
        // On failure keep the last-known list (a slightly stale count beats
        // flashing back to 0); [] only when nothing was ever loaded.
        setConversations(conversationsCache ?? []);
      }
    })();
  }, [claude]);

  // Wrap syncNow() so the header shows the blue "Syncing…" state while it runs. .catch
  // routes a rejected invoke into the same red note slot as before; .finally clears the
  // flag whether it resolved or failed. Used by the box's "Sync now" and "Try again".
  const runSpacesSyncNow = useCallback(() => {
    setSpacesSyncing(true);
    // Clear the PREVIOUS attempt's error before retrying. Without this, the
    // "Try again" button could never turn the header green again: a failure set
    // spacesError and nothing ever cleared it, so a succeeding retry still read
    // as "Couldn't sync". A retry that fails again re-sets it in the catch.
    setSpacesError(null);
    void (window as any).claude.syncSpaces.syncNow()
      .catch((err: any) => setSpacesError(String(err?.message ?? err)))
      .finally(() => setSpacesSyncing(false));
  }, []);

  // Additional-backups master toggle. WHY: there is no dedicated "additional backups
  // enabled" flag yet (deferred follow-up) — the master state is DERIVED from whether
  // ANY backend has syncEnabled. So the toggle maps to: OFF -> pause every active
  // backend, ON -> resume every paused backend. Non-destructive (never removes a
  // backend). With zero backends, turning ON just reveals the inline picker
  // (additionalIntent) — actually adding a backend is what persists anything.
  const handleAdditionalToggle = useCallback(async () => {
    const list = status?.backends ?? [];
    const on = list.some(b => b.syncEnabled) || additionalIntent;
    if (on) {
      // Turn OFF: pause all currently-active backends and drop the picker intent.
      for (const b of list) if (b.syncEnabled) await claude.sync.updateBackend(b.id, { syncEnabled: false });
      setAdditionalIntent(false);
      await refreshStatus();
    } else if (list.length === 0) {
      // Turn ON with nothing connected: reveal the inline Drive/iCloud picker.
      setAdditionalIntent(true);
    } else {
      // Turn ON with paused backends: resume them all.
      for (const b of list) if (!b.syncEnabled) await claude.sync.updateBackend(b.id, { syncEnabled: true });
      await refreshStatus();
    }
  }, [status, additionalIntent, claude, refreshStatus]);

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
                PRIMARY — Cross-Device Backup & Sync box (redesign 2026-07-15).
                One bordered "sync box": a unified status header (dot · title · sub ·
                toggle), then — only when enabled & healthy — Devices/Projects/
                Conversations count tabs with a switchable list, plus the conflict /
                large-history notices and a "Sync now" link. Every state reuses the
                SAME header anatomy so the box never reads as a different widget.
                (Replaces the old primary section, the secondary backups block, and
                the standalone "Back up now" row.) */}
            {(() => {
              // An error only counts while it's UNRESOLVED — i.e. no later
              // 'synced' for that same space. The old scan took the newest error
              // in the never-cleared last-50 buffer, so a single transient
              // watcher hiccup kept this header red for ~100 minutes while syncs
              // succeeded behind it. Ordering + per-space scoping live in the
              // pure helper the project dots already use (sync-dot-state.ts).
              const engineError = latestUnresolvedError(spacesStatus as unknown as SyncStatusData | null);
              const errorMsg = spacesError ?? engineError?.message;
              const enabled = !!spacesStatus?.enabled;
              const githubUnauthed = !!(githubStatus && !githubStatus.authed);
              const login = githubStatus?.login;

              // Resolve the single header state from the existing signals.
              type HK = 'setup' | 'off' | 'waiting-github' | 'error' | 'syncing' | 'synced';
              let hk: HK;
              if (enabling) hk = 'setup';
              else if (!enabled) hk = (errorMsg && githubUnauthed) ? 'waiting-github' : 'off';
              else if (errorMsg) hk = 'error';
              else if (spacesSyncing) hk = 'syncing';
              else hk = 'synced';

              const dot =
                hk === 'setup' ? 'bg-blue-400 animate-pulse' :
                hk === 'off' ? 'bg-fg-muted/40' :
                hk === 'waiting-github' ? 'bg-[#FF9800]' :
                hk === 'error' ? 'bg-red-500' :
                hk === 'syncing' ? 'bg-blue-400 animate-pulse' :
                'bg-green-500';

              const title =
                hk === 'setup' ? 'Setting up…' :
                hk === 'off' ? 'Backup & sync is off' :
                hk === 'waiting-github' ? 'Waiting on GitHub' :
                hk === 'error' ? "Couldn't sync" :
                hk === 'syncing' ? 'Syncing…' :
                'All synced';

              // Instant-sync phrase (reuses the syncHub logic) + relative last-sync.
              // lastSyncEpoch is the app-wide sync marker (seconds) — the only relative
              // time we have — so it's shown only when present ("if available").
              const instant =
                spacesStatus?.syncHub === 'connected' ? 'instant sync on' :
                (spacesStatus?.syncHub && spacesStatus.syncHub !== 'off') ? 'reconnecting' : null;
              const lastRel = status?.lastSyncEpoch ? timeAgo(status.lastSyncEpoch) : null;
              const syncedSub = ['GitHub', login, instant, lastRel].filter(Boolean).join(' · ');
              const syncingSub = ['GitHub', login].filter(Boolean).join(' · ');

              // space-manager's error string is a pinned UI contract — shown verbatim.
              const sub =
                hk === 'setup' ? 'Creating your private repositories — a few seconds.' :
                hk === 'off' ? 'Turn on to back up and sync across your devices' :
                hk === 'waiting-github' ? 'Connect your account to start syncing' :
                hk === 'error' ? (errorMsg as string) :
                hk === 'syncing' ? syncingSub :
                syncedSub;
              const subWarn = hk === 'error';

              // Not-enabled + error + GitHub-authed collapses to the plain 'off'
              // header (only error + UNauthed gets 'waiting-github'), which used to
              // hide the failure entirely — e.g. an enable attempt that failed for a
              // non-GitHub reason looked like nothing happened. Surface the error as
              // its own red line under the off sub, mirroring how the enabled+error
              // state shows errorMsg in red. (Error strings are shown verbatim —
              // same pinned-contract rule as the 'error' sub above.)
              const offError = hk === 'off' && errorMsg ? (errorMsg as string) : null;

              // Toggle reflects the real enabled state (or the pending enable) so its
              // click always flips the correct direction. Disabled only while setting up.
              const toggleOn = enabling || enabled;

              // Count tabs only when enabled & healthy (not off/setup/error/waiting).
              const showTabs = hk === 'synced' || hk === 'syncing';
              const devCount = devices?.length ?? 0;
              const projCount = ((spacesStatus?.spaces ?? []) as any[]).filter(s => s.kind === 'project').length;
              const convCount = conversations?.length ?? 0;
              const tabDefs = [
                { key: 'dev' as const, count: devCount, word: devCount === 1 ? 'Device' : 'Devices' },
                { key: 'proj' as const, count: projCount, word: projCount === 1 ? 'Project' : 'Projects' },
                { key: 'conv' as const, count: convCount, word: convCount === 1 ? 'Conversation' : 'Conversations' },
              ];

              // CTA row — tucked directly under the sub (aligned past the dot, no divider).
              const cta =
                hk === 'waiting-github' ? (
                  <button onClick={() => setShowConnectGithub(true)} className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent text-on-accent hover:brightness-110">
                    Connect GitHub…
                  </button>
                ) : hk === 'error' ? (
                  <>
                    {/* Try again reuses syncNow() with the existing .catch error routing. */}
                    <button onClick={runSpacesSyncNow} className="px-2.5 py-1 rounded-md text-[11px] font-medium bg-accent text-on-accent hover:brightness-110">
                      Try again
                    </button>
                    {githubUnauthed && (
                      <button onClick={() => setShowConnectGithub(true)} className="px-2.5 py-1 rounded-md text-[11px] font-medium border border-edge-dim text-fg-2 hover:bg-inset">
                        Connect GitHub…
                      </button>
                    )}
                  </>
                ) : null;

              const conflict = enabled && visibleSpaceEvents.some((e: any) => e.type === 'conflict');
              const notice = enabled ? [...visibleSpaceEvents].reverse().find((e: any) => e.type === 'notice') : null;

              return (
                <div className="rounded-lg border border-edge bg-well overflow-hidden">
                  {/* Unified header: dot · title/sub · toggle. Identical anatomy every state. */}
                  <div className="px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex items-start gap-2.5">
                        <div className={`w-2 h-2 rounded-full mt-1.5 shrink-0 ${dot}`} />
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-fg">{title}</div>
                          <div className={`text-[11px] mt-0.5 leading-relaxed ${subWarn ? 'text-red-500' : 'text-fg-muted'}`}>{sub}</div>
                          {/* Off-but-errored: keep the normal off sub AND show why the last attempt failed. */}
                          {offError && <div className="text-[11px] mt-0.5 leading-relaxed text-red-500">{offError}</div>}
                        </div>
                      </div>
                      {/* Enable toggle — reuses the 36×20 green switch markup. */}
                      <button
                        role="switch"
                        aria-checked={toggleOn}
                        disabled={enabling}
                        onClick={() => void handleSpacesEnable(!enabled)}
                        className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 ${toggleOn ? 'bg-green-600' : 'bg-inset'} ${enabling ? 'opacity-50 cursor-wait' : 'cursor-pointer'}`}
                        title={enabled ? 'Cross-device sync on — click to turn off' : 'Cross-device sync off — click to turn on'}
                      >
                        <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all" style={{ left: toggleOn ? '18px' : '2px' }} />
                      </button>
                    </div>
                    {/* Action tucked under the reason — same box, no divider. */}
                    {cta && <div className="mt-2 flex items-center gap-2 pl-[18px]">{cta}</div>}
                  </div>

                  {/* Count tabs + switchable list (only when enabled & healthy). */}
                  {showTabs && (
                    <>
                      <div
                        role="tablist"
                        aria-label="Synced content"
                        className="flex gap-2 px-3 pb-3"
                        onKeyDown={(e) => {
                          // Left/Right arrow roving between the three pills.
                          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                          e.preventDefault();
                          const order = ['dev', 'proj', 'conv'] as const;
                          const i = order.indexOf(countTab);
                          const ni = e.key === 'ArrowRight' ? (i + 1) % 3 : (i + 2) % 3;
                          setCountTab(order[ni]);
                          (e.currentTarget.children[ni] as HTMLElement)?.focus();
                        }}
                      >
                        {tabDefs.map(t => {
                          const active = countTab === t.key;
                          return (
                            <button
                              key={t.key}
                              role="tab"
                              aria-selected={active}
                              tabIndex={active ? 0 : -1}
                              onClick={() => setCountTab(t.key)}
                              className={`inline-flex items-baseline gap-1.5 rounded-full px-3 py-1 text-[11px] transition-colors ${active ? 'bg-accent text-on-accent border border-accent' : 'bg-inset border border-edge-dim text-fg-dim hover:text-fg-2'}`}
                            >
                              <span className="font-bold text-xs">{t.count}</span> {t.word}
                            </button>
                          );
                        })}
                      </div>
                      <div role="tabpanel" className="border-t border-edge-dim px-3 py-2.5">
                        {countTab === 'dev' && <DevicesTab devices={devices} onRename={handleRenameDevice} />}
                        {countTab === 'proj' && (() => {
                          const projects = ((spacesStatus?.spaces ?? []) as any[]).filter(s => s.kind === 'project');
                          if (projects.length === 0) return <p className="text-[11px] text-fg-muted">Turn on sync for a project folder to add it here.</p>;
                          return (
                            <ul className="space-y-1">
                              {projects.map((s: any) => (
                                <li key={s.id} className="flex items-center justify-between gap-2">
                                  <span className="text-xs text-fg-2 truncate">{s.displayName || s.id.replace('project:', '')}</span>
                                  <span className="text-[10px] text-fg-muted shrink-0">{s.remote ? 'connected' : 'local only'}</span>
                                </li>
                              ))}
                            </ul>
                          );
                        })()}
                        {countTab === 'conv' && (() => {
                          // Most-recent first; show up to 4 with a "+ N more" muted tail.
                          const sorted = [...(conversations ?? [])].sort((a, b) => b.lastModified - a.lastModified);
                          if (sorted.length === 0) return <p className="text-[11px] text-fg-muted">No conversations yet.</p>;
                          const shown = sorted.slice(0, 4);
                          return (
                            <>
                              <ul className="space-y-1">
                                {shown.map(c => (
                                  <li key={c.sessionId} className="flex items-center justify-between gap-2">
                                    <span className="text-xs text-fg-2 truncate">{c.name}</span>
                                    <span className="text-[10px] text-fg-muted shrink-0">{relativeMs(c.lastModified)}</span>
                                  </li>
                                ))}
                              </ul>
                              {sorted.length > shown.length && (
                                <p className="text-[10px] text-fg-muted mt-1.5">+ {sorted.length - shown.length} more, all backed up</p>
                              )}
                            </>
                          );
                        })()}
                      </div>
                    </>
                  )}

                  {/* Conflict / large-history notice / Sync now — only when enabled & not errored. */}
                  {enabled && !errorMsg && (
                    <div className="border-t border-edge-dim px-3 py-2.5 space-y-2">
                      {conflict && (
                        <p className="text-xs text-amber-600">
                          Some files had conflicting edits — the other device's copy was kept alongside yours
                          (look for "(from …)" files).
                        </p>
                      )}
                      {notice && <p className="text-xs text-fg-muted">{notice.message}</p>}
                      {/* .catch (inside runSpacesSyncNow) routes a failed invoke into the red note slot. */}
                      <button onClick={runSpacesSyncNow} className="text-xs underline text-fg-muted hover:text-fg-2">Sync now</button>
                    </div>
                  )}
                </div>
              );
            })()}

            {/* ============================================================
                SECONDARY — Additional backups (Drive/iCloud), optional. One box with
                the master toggle ALWAYS in the header. OFF+empty -> collapsed hint;
                OFF+backends -> paused rows kept visible (never hidden/lost); ON ->
                backend rows (status light + cog menu) and/or the inline picker.
                Redesign 2026-07-15 — replaces the per-row toggles + kebab. */}
            {(() => {
              const list = status?.backends ?? [];
              const masterOn = list.some(b => b.syncEnabled) || additionalIntent;
              const pausedCount = list.filter(b => !b.syncEnabled).length;
              const anyActive = list.some(b => b.syncEnabled);
              const isOffline = (status?.warnings ?? []).some(w => w.code === 'OFFLINE');

              const sub =
                masterOn && list.length === 0 ? 'Pick where the second copy goes' :
                masterOn ? 'A second copy on top of GitHub — it stays primary.' :
                list.length > 0 ? `${pausedCount} destination${pausedCount === 1 ? '' : 's'} paused` :
                'A second copy on top of GitHub — Drive or iCloud';

              return (
                <div className="rounded-lg border border-dashed border-edge px-3 py-3">
                  {/* Header: title + optional pill + master toggle (always present). */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-fg">Additional backups</span>
                        <span className="text-[9px] font-medium text-fg-muted tracking-wider uppercase px-1.5 py-0.5 rounded-full bg-inset">optional</span>
                      </div>
                      <p className="text-[11px] text-fg-muted mt-1 leading-relaxed">{sub}</p>
                    </div>
                    {/* Master toggle: pause-all / resume-all / reveal picker (handleAdditionalToggle). */}
                    <button
                      role="switch"
                      aria-checked={masterOn}
                      onClick={() => void handleAdditionalToggle()}
                      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 mt-0.5 cursor-pointer ${masterOn ? 'bg-green-600' : 'bg-inset'}`}
                      title={masterOn ? 'Additional backups on — click to pause all' : 'Additional backups off — click to turn on'}
                    >
                      <div className="absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-all" style={{ left: masterOn ? '18px' : '2px' }} />
                    </button>
                  </div>

                  {/* Backend rows — shown whenever any exist (kept visible even when paused,
                      so turning the master off doesn't hide/lose destinations). */}
                  {list.length > 0 && (
                    <div className="mt-3 space-y-2">
                      {list.map(b => {
                        // Pending = sync-enabled backend that can't currently push (offline or errored).
                        const isPending = b.syncEnabled && (b.lastError != null || isOffline);
                        const inFlight = actionFeedback[b.id]?.includes('ing');
                        // Status light: blue in-flight / red error / green healthy / gray paused-or-disconnected.
                        const lightClass = inFlight ? 'bg-blue-400 animate-pulse'
                          : b.lastError ? 'bg-red-500 ring-2 ring-red-500/25'
                          : (b.syncEnabled && b.connected) ? 'bg-green-500 ring-2 ring-green-500/25'
                          : 'bg-fg-muted/40';
                        return (
                          <div
                            key={b.id}
                            className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 ${
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
                              {isPending && !actionFeedback[b.id] && (
                                <span className="text-[9px] font-medium text-amber-400">Changes pending upload</span>
                              )}
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
                            {/* Status light (state at a glance) — controls moved into the cog menu. */}
                            <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${lightClass}`} />
                            {/* Cog menu (replaces the old ⋯ kebab + per-row on/off toggle). */}
                            <div className="relative shrink-0">
                              <button
                                onClick={(e) => { e.stopPropagation(); setMenuOpenId(menuOpenId === b.id ? null : b.id); }}
                                className="w-6 h-6 flex items-center justify-center rounded hover:bg-inset text-fg-muted"
                                title="Manage"
                              >
                                {/* App settings gear (same SVG as HeaderBar). */}
                                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                              </button>
                              {menuOpenId === b.id && (
                                /* Overflow menu — .layer-surface for theme-consistent look + glass. */
                                <div className="layer-surface absolute right-0 top-7 w-44 py-1" style={{ zIndex: 10 }} onClick={(e) => e.stopPropagation()}>
                                  <MenuButton onClick={() => { handlePushBackend(b.id); setMenuOpenId(null); }}>Upload now</MenuButton>
                                  <MenuButton onClick={() => { claude.sync.openFolder(b.id); setMenuOpenId(null); }}>Open folder</MenuButton>
                                  <MenuButton onClick={() => { handleToggleSync(b.id, !b.syncEnabled); setMenuOpenId(null); }}>
                                    {b.syncEnabled ? 'Pause auto-backup' : 'Resume auto-backup'}
                                  </MenuButton>
                                  <MenuButton onClick={() => { setEditingId(b.id); setView('edit'); setMenuOpenId(null); }}>Edit settings…</MenuButton>
                                  <div className="border-t border-edge-dim my-1" />
                                  <MenuButton danger onClick={() => { setConfirmRemoveId(b.id); setMenuOpenId(null); }}>Remove</MenuButton>
                                </div>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Inline picker — master on but nothing connected yet. Opens the wizard
                      straight into per-type config (initialType skips the type picker). */}
                  {masterOn && list.length === 0 && (
                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => { setAddType('drive'); setView('add-config'); }}
                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-edge bg-well hover:bg-inset text-xs text-fg-2 transition-colors"
                      >
                        <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] bg-blue-500/10 text-blue-400">{'☁'}</span>
                        Google Drive
                      </button>
                      <button
                        onClick={() => { setAddType('icloud'); setView('add-config'); }}
                        className="flex-1 flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg border border-edge bg-well hover:bg-inset text-xs text-fg-2 transition-colors"
                      >
                        <span className="w-5 h-5 rounded-full flex items-center justify-center text-[11px] bg-sky-500/10 text-sky-400">{'⬡'}</span>
                        iCloud
                      </button>
                    </div>
                  )}

                  {/* Add-a-backup + compact "Back up all now" (replaces the standalone Back
                      up now row; keeps handleForceSync's syncing state + label behavior). */}
                  {list.length > 0 && (
                    <div className="mt-2 space-y-2">
                      <button
                        onClick={() => setView('add-type')}
                        className="w-full border border-dashed border-edge-dim rounded-lg py-2.5 text-center text-[11px] text-fg-muted hover:text-fg-2 hover:border-edge hover:bg-inset/30 transition-colors"
                      >
                        ＋ Add a backup
                      </button>
                      {anyActive && (
                        <button
                          onClick={handleForceSync}
                          disabled={syncing}
                          className="text-[11px] underline text-fg-muted hover:text-fg-2 disabled:opacity-50 disabled:cursor-wait"
                        >
                          {syncing || status?.syncInProgress ? 'Backing up…' : 'Back up all now'}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })()}

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

// --- DeviceRow + Devices count-tab (Plan 2b spec §10a) ---
// The synced device registry, rendered as the "Devices" tab body inside the sync
// box. PLAIN TEXT only — no status dots/glyphs (spec'd plain; owner dislikes
// glyphs). The current machine is marked "(this device)" and each name is an
// inline-editable nickname. Fetching + rename now live in SyncPopup (so the
// "Devices" count and this list share one source); this component keeps only the
// local editing draft state.

interface DeviceRow {
  schemaVersion: number;
  id: string;
  name: string;
  platform: string;
  lastSeen: number;
  updatedAt: number;
  self: boolean; // marks THIS machine (matched by deviceId in the main handler)
}

function DevicesTab({ devices, onRename }: { devices: DeviceRow[] | null; onRename: (id: string, name: string) => void }) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  // Commit a rename: reject empty/whitespace and skip a no-op rename so we don't
  // fire a pointless invoke + refetch. The parent (SyncPopup) owns the IPC call.
  const commitRename = useCallback((id: string) => {
    const name = draft.trim();
    setEditingId(null);
    if (!name) return;
    const current = devices?.find(d => d.id === id);
    if (current && current.name === name) return;
    onRename(id, name);
  }, [draft, devices, onRename]);

  // null = not loaded yet; [] = loaded-but-empty (sync off / no personal root).
  if (devices !== null && devices.length === 0) {
    return <p className="text-[11px] text-fg-muted">No devices yet — they appear here once sync has run.</p>;
  }

  return (
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
                    if (e.key === 'Enter') commitRename(d.id);
                    if (e.key === 'Escape') setEditingId(null); // cancel — no rename
                  }}
                  onBlur={() => commitRename(d.id)}
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
