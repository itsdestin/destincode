import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { MODELS, type ModelAlias } from './StatusBar';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { Button, Toggle, LoadingState, EmptyState } from './ui';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';
import { SkipPermissionsInfoTooltip } from './SkipPermissionsInfoTooltip';
import {
  applyFilters,
  sortSessions,
  groupSessions,
  getAvailableProjects,
  type FilterState,
  type FlagName,
} from './resume-browser-filters';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { TagPicker } from './tags/TagPicker';
import { TagChip } from './tags/TagChip';
import { NoteEditor } from './tags/NoteEditor';
import NativeModelSelect from './NativeModelSelect';
import type { ModelBinding } from '../../shared/provider-types';

const MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus',
  haiku: 'Haiku',
  fable: 'Fable',
};

function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const kb = Math.round(bytes / 1024);
  if (kb < 1024) return `${kb}KB`;
  return `${(kb / 1024).toFixed(1)}MB`;
}

// Shared trigger-button shape for the filter row beneath the search bar.
// Inactive pills look like the search input frame; active pills tint with the
// accent so the user can see at a glance which pills have departed from
// default state — narrowing filters (Projects, Tags) AND a non-default sort
// direction (Sort). Don't "tighten" the predicate to only narrowing — Sort
// would lose its visual cue.
function FilterPill({
  active,
  onClick,
  children,
  hasPopup,
  expanded,
  buttonRef,
}: {
  active: boolean;
  // Receives the MouseEvent so dropdown-owning callers can stopPropagation()
  // — the Projects + Tags pills (Tasks 4 + 5) rely on this to keep their
  // outside-click handler from immediately re-closing the dropdown.
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
  // Optional: when the pill opens a dropdown, callers pass these so screen
  // readers announce both "active filter" (aria-pressed) AND dropdown state.
  // expanded is only read when hasPopup is true; React strips both attrs
  // entirely when hasPopup is falsy (Sort pill).
  hasPopup?: boolean;
  expanded?: boolean;
  // Optional: dropdown-owning callers pass a ref so they can measure the
  // trigger's bounding rect for portal positioning. Sort doesn't need it.
  buttonRef?: React.Ref<HTMLButtonElement>;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      // aria-pressed conveys the toggle state to assistive tech. Mirrors the
      // Show Complete toggle's pattern further down in this file.
      aria-pressed={active}
      aria-haspopup={hasPopup ? 'listbox' : undefined}
      aria-expanded={hasPopup ? !!expanded : undefined}
      className={`px-2.5 py-1 rounded-full text-[11px] flex items-center gap-1.5 transition-colors duration-75 ${
        active
          ? 'bg-accent/10 border border-accent/40 text-fg'
          : 'bg-inset border border-edge-dim text-fg-muted hover:text-fg'
      }`}
    >
      {children}
    </button>
  );
}

// Compute fixed-position coords for a portaled dropdown anchored just below a
// trigger button. Clamps the left coordinate so a wide dropdown near the right
// edge of the viewport shifts left rather than overflowing off-screen. Pure;
// callers invoke it synchronously inside the click handler so the dropdown can
// render in the same React commit as `openPill` flipping (no two-render lag).
function measureDropdown(
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  dropdownWidthPx: number,
): { top: number; left: number } | null {
  const el = triggerRef.current;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  // Clamp so the dropdown's right edge stays at least 8px inside the viewport.
  // If the trigger sits too far right, the dropdown shifts left.
  const maxLeft = Math.max(8, window.innerWidth - dropdownWidthPx - 8);
  return {
    top: rect.bottom + 4,
    left: Math.min(rect.left, maxLeft),
  };
}

// While a dropdown is open, re-measure the trigger on window resize / scroll
// so the dropdown stays anchored as the viewport changes. The initial position
// is captured synchronously in the pill's click handler — this hook only
// handles updates after open, not the open itself.
function useDropdownReposition(
  isOpen: boolean,
  triggerRef: React.RefObject<HTMLButtonElement | null>,
  dropdownWidthPx: number,
  setPosition: React.Dispatch<React.SetStateAction<{ top: number; left: number } | null>>,
): void {
  useEffect(() => {
    if (!isOpen) return;
    const remeasure = () => {
      const next = measureDropdown(triggerRef, dropdownWidthPx);
      if (next) setPosition(next);
    };
    window.addEventListener('resize', remeasure);
    // Capture-phase scroll listener catches scroll on any ancestor, not just
    // window — needed if a scrollable parent moves the trigger.
    window.addEventListener('scroll', remeasure, true);
    return () => {
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
  }, [isOpen, triggerRef, dropdownWidthPx, setPosition]);
}

// FlagName is imported from resume-browser-filters.ts (single source of truth).
// Kept in sync with SESSION_FLAG_NAMES in shared/types.ts; that module is
// CommonJS so we don't import it directly. FLAG_ORDER fixes the reserved-flag
// toggle ordering in the UI (Priority first, then Complete). The old
// informational flag is retired; custom tags are handled separately now.
const FLAG_ORDER: FlagName[] = ['priority', 'complete'];
const FLAG_LABEL: Record<FlagName, string> = {
  priority: 'Priority',
  complete: 'Complete',
};

interface PastSession {
  sessionId: string;
  name: string;
  projectSlug: string;
  projectPath: string;
  lastModified: number;
  size: number;
  // Reserved flags — multiple allowed. `complete` hides unless Show Complete
  // is on; `priority` pins the session to the top of its project group.
  flags?: Partial<Record<FlagName, boolean>>;
  tags?: string[];   // applied custom-tag ids
  note?: string;
  // Which runtime owns this session: `'claude'` = a Claude Code transcript;
  // `'native'` = a YouCoded native-harness session (gets a "YouCoded" badge and
  // skips the CC-only resume options — model / skip-perms). Typed `string`
  // because Conversation-Store rows (Phase 2a) populate it from a stored string.
  provider?: string;
  // Native runtime only: the stored harness preset id ('assistant' | 'coder' |
  // legacy 'chat'). Drives the preset label next to the YouCoded badge.
  harnessId?: string;
  // Conversation Store (Phase 2a) fields, present on store-fed rows only.
  device?: string;   // last device that ran a turn
  // True when the conversation's project folder is not on THIS device (synced
  // in from elsewhere). Resume is disabled — there's no cwd to resume into.
  missingProject?: boolean;
  // True when the folder IS here but the transcript hasn't been materialized
  // into ~/.claude/projects yet (sync in flight). Resume is disabled too —
  // distinct flag so the note can say so accurately.
  notSyncedYet?: boolean;
  // Task 6: portable reference to the model this conversation last ran a turn
  // with (Conversation Store, Task 4/5). Pre-fills the native resume selector
  // below when it matches a model available on THIS device.
  lastUsedModel?: import('../../shared/types').PortableModelRef;
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Returns whether a resume actually launched (App's handleResumeSession does).
  // handleConfirmResume awaits it and closes the browser ONLY on success — a create
  // that never acked keeps the browser open (App toasts the reason) so the user can
  // retry, instead of closing over a silent failure (Task 6 review ack-gap). `void`
  // return kept in the union for any non-awaiting wiring (defaults to "close").
  onResume: (sessionId: string, projectSlug: string, projectPath: string, model: string, dangerous: boolean, launchInNewWindow?: boolean, provider?: string, nativeBinding?: ModelBinding) => void | boolean | Promise<void | boolean>;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
}

export default function ResumeBrowser({ open, onClose, onResume, defaultModel, defaultSkipPermissions }: Props) {
  // Live tag registry — drives the Tag Picker, chips, and custom-tag filter.
  const registry = useTagRegistry();
  const [sessions, setSessions] = useState<PastSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useScrollFade<HTMLDivElement>();
  // Wraps the filter pill row so outside-click can close the active dropdown.
  const filterRowRef = useRef<HTMLDivElement>(null);
  // Trigger refs for portal positioning + dropdown refs so the outside-click
  // handler can recognize clicks inside the portaled dropdown body (which is
  // no longer a child of filterRowRef).
  const projectsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const tagsTriggerRef = useRef<HTMLButtonElement | null>(null);
  const projectsDropdownRef = useRef<HTMLDivElement | null>(null);
  const tagsDropdownRef = useRef<HTMLDivElement | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [resumeModel, setResumeModel] = useState<string>(defaultModel || 'sonnet');
  const [resumeDangerous, setResumeDangerous] = useState(defaultSkipPermissions || false);
  // Task 6 — native resume ALWAYS offers the provider-scoped model selector
  // (Destin's ruling: never auto-launch a binding). null until the user picks
  // a row OR NativeModelSelect auto-selects a prefill match; the Resume button
  // stays disabled for a native row until this is set. Reset whenever a
  // (possibly different) row expands/collapses — a fresh NativeModelSelect
  // mount per expansion is what actually resets ITS internal state; this just
  // keeps the Resume-button gate and the value threaded through onResume in
  // sync with that same lifecycle.
  const [nativeResumeBinding, setNativeResumeBinding] = useState<ModelBinding | null>(null);
  // Launch the resumed session in a new peer window (multi-window only).
  const [resumeLaunchInNewWindow, setResumeLaunchInNewWindow] = useState(false);
  // Sesion id currently resuming — keeps its Resume button busy + the browser open
  // until the create acks (Task 6 review ack-gap). Closes only on a launched resume.
  const [resumingId, setResumingId] = useState<string | null>(null);
  const detachAvailable = typeof (window as any).claude?.detach?.openDetached === 'function';
  // Show Complete: when off, sessions marked complete are hidden (default).
  // Persists across opens via localStorage so Destin doesn't re-toggle each time.
  const [showComplete, setShowComplete] = useState<boolean>(() => {
    try { return localStorage.getItem('youcoded-resume-show-complete') === '1'; }
    catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem('youcoded-resume-show-complete', showComplete ? '1' : '0'); } catch {}
  }, [showComplete]);

  // Sessions the user flagged Complete during the current open. They stay
  // visible until the menu is closed and reopened, so the row doesn't vanish
  // mid-interaction when Show Complete is off. Reset on every open.
  const [stickyComplete, setStickyComplete] = useState<Set<string>>(new Set());

  // New filter state — all reset on each open (no localStorage). Default values
  // (empty Sets, sortDir='desc') produce identical behaviour to the prior
  // hard-coded filter pipeline.
  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(new Set());
  const [selectedTagIds, setSelectedTagIds] = useState<Set<string>>(new Set());
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Tracks which filter pill's dropdown is currently open. null = both closed.
  // Single state instead of two booleans so the dropdowns are mutually exclusive.
  const [openPill, setOpenPill] = useState<'projects' | 'tags' | null>(null);

  // Fetch sessions when opened
  useEffect(() => {
    if (open) {
      setSearch('');
      setExpandedId(null);
      setResumeModel(defaultModel || 'sonnet');
      setResumeDangerous(defaultSkipPermissions || false);
      setNativeResumeBinding(null);
      // Reset the sticky-visible set each open — previously kept rows drop out.
      setStickyComplete(new Set());
      // Reset filter pills each open — current spec: no persistence.
      setSelectedProjects(new Set());
      setSelectedTagIds(new Set());
      setSortDir('desc');
      setLoading(true);
      (window as any).claude.session.browse()
        .then((list: PastSession[]) => setSessions(list))
        .catch(() => setSessions([]))
        .finally(() => setLoading(false));
      const t = setTimeout(() => searchRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Layered ESC: close an open filter dropdown first, then collapse the
  // expanded row, then close the browser. Each ESC press peels one layer.
  const handleEscClose = useCallback(() => {
    if (openPill) setOpenPill(null);
    else if (expandedId) setExpandedId(null);
    else onClose();
  }, [openPill, expandedId, onClose]);
  useEscClose(open, handleEscClose);

  // Close the active filter dropdown on outside click. Recognizes clicks
  // inside the trigger row AND the portaled dropdowns (which live in
  // document.body, outside filterRowRef).
  useEffect(() => {
    if (!openPill) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (filterRowRef.current?.contains(target)) return;
      if (projectsDropdownRef.current?.contains(target)) return;
      if (tagsDropdownRef.current?.contains(target)) return;
      setOpenPill(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [openPill]);

  const filtered = useMemo(() => {
    // Filter pipeline lives in resume-browser-filters.ts so it can be unit tested.
    // Order: Show Complete + sticky → project → tag → search.
    const state: FilterState = {
      search,
      showComplete,
      stickyComplete,
      selectedProjects,
      selectedTagIds,
      tagLabelById: Object.fromEntries(registry.tags.map((t) => [t.id, t.label])),
    };
    return applyFilters(sessions, state);
  }, [sessions, search, showComplete, stickyComplete, selectedProjects, selectedTagIds, registry.tags]);

  // Group by project path ONLY when the user has narrowed via the Projects
  // pill — the default view is pure chronological (each row carries its own
  // project label instead). Within-group sort is priority-pinned + lastModified
  // by sortDir; between-group order also follows sortDir. Search always stays
  // flat so results read as one ranked list.
  const grouped = useMemo(() => {
    if (search.trim() || selectedProjects.size === 0) return null;
    return groupSessions(filtered, sortDir);
  }, [filtered, search, selectedProjects, sortDir]);

  // Flat list (default + search modes) — priority-pinned, lastModified by sortDir.
  const flatSorted = useMemo(() => {
    return sortSessions(filtered, sortDir);
  }, [filtered, sortDir]);

  // Distinct projects with counts — what the Projects pill dropdown displays.
  // Derived from the unfiltered session list so the dropdown always shows
  // every known project, even when the user has narrowed the visible list.
  const availableProjects = useMemo(() => getAvailableProjects(sessions), [sessions]);

  // Trigger label for the Projects pill: 0 selected → "Projects",
  // 1 → label, 2-3 → comma-joined labels, 4+ → "Projects (N)".
  const projectsLabel = useMemo(() => {
    if (selectedProjects.size === 0) return 'Projects';
    const selectedList = availableProjects.filter((p) => selectedProjects.has(p.path));
    if (selectedList.length === 1) return selectedList[0].label;
    if (selectedList.length <= 3) return selectedList.map((p) => p.label).join(', ');
    return `Projects (${selectedList.length})`;
  }, [selectedProjects, availableProjects]);

  // Portal-anchored dropdown positions. Dropdown widths match the className
  // (Projects: w-64 = 256px, Tags: w-52 = 208px). Keep these in sync if the
  // className width changes.
  // The position is captured synchronously inside each pill's onClick handler
  // (not via useLayoutEffect) so the dropdown can render in the same React
  // commit as `openPill` flipping — eliminates the two-render lag the prior
  // implementation had between pill click and dropdown appearing.
  const [projectsDropdownPos, setProjectsDropdownPos] = useState<{ top: number; left: number } | null>(null);
  const [tagsDropdownPos, setTagsDropdownPos] = useState<{ top: number; left: number } | null>(null);
  // Reposition while open (resize / scroll updates only — not the initial
  // measurement, which is sync in the click handler).
  useDropdownReposition(openPill === 'projects', projectsTriggerRef, 256, setProjectsDropdownPos);
  useDropdownReposition(openPill === 'tags', tagsTriggerRef, 208, setTagsDropdownPos);

  // Clear stale position state when the dropdown closes via outside-click or
  // ESC (the click handlers do this themselves, but those external paths
  // don't). Saves a tiny amount of memory and prevents a stale position from
  // briefly flashing if the same pill reopens before useDropdownReposition
  // has a chance to update.
  useEffect(() => {
    if (openPill !== 'projects' && projectsDropdownPos !== null) setProjectsDropdownPos(null);
    if (openPill !== 'tags' && tagsDropdownPos !== null) setTagsDropdownPos(null);
  }, [openPill, projectsDropdownPos, tagsDropdownPos]);

  // Optimistically flip a flag in local state, then persist via IPC. On failure
  // we revert. A meta-changed push from other tabs/devices also refreshes the
  // list — see the subscription effect below.
  const toggleFlag = async (sessionId: string, flag: FlagName, next: boolean) => {
    const apply = (val: boolean) => setSessions((prev) => prev.map((s) =>
      s.sessionId === sessionId ? { ...s, flags: { ...(s.flags || {}), [flag]: val } } : s,
    ));
    apply(next);
    // Pin just-flagged-Complete rows visible for the remainder of this open.
    const pinned = flag === 'complete' && next && !showComplete;
    if (pinned) {
      setStickyComplete((prev) => {
        const ns = new Set(prev);
        ns.add(sessionId);
        return ns;
      });
    }
    // Reverting has to undo the STICKY PIN too, not just the flag — otherwise a
    // refused write leaves the row pinned as if Complete had been applied.
    const revert = () => {
      apply(!next);
      if (pinned) setStickyComplete((prev) => {
        const ns = new Set(prev);
        ns.delete(sessionId);
        return ns;
      });
    };
    try {
      const res: any = await (window as any).claude.session.setFlag(sessionId, flag, next);
      if (res && res.ok === false) revert();
    } catch {
      revert();
    }
  };

  // Apply/remove a custom tag on a past session (optimistic + persist).
  // Mirrors toggleFlag's revert-on-ok:false — without it a refused write (native
  // session) left the tag showing until the next browse, which read as "saved".
  const toggleTag = async (sessionId: string, tagId: string, next: boolean) => {
    const apply = (val: boolean) => setSessions((prev) => prev.map((s) =>
      s.sessionId === sessionId
        ? { ...s, tags: val ? [...new Set([...(s.tags ?? []), tagId])] : (s.tags ?? []).filter((t) => t !== tagId) }
        : s));
    apply(next);
    try {
      const res: any = await (window as any).claude.session.setTag(sessionId, tagId, next);
      if (res && res.ok === false) apply(!next);
    } catch (e) { apply(!next); console.error('resume: setTag failed', e); }
  };

  const saveNote = async (sessionId: string, note: string) => {
    const prev = sessions.find((s) => s.sessionId === sessionId)?.note ?? '';
    const apply = (text: string) => setSessions((list) =>
      list.map((s) => s.sessionId === sessionId ? { ...s, note: text } : s));
    apply(note);
    try {
      const res: any = await (window as any).claude.session.setNote(sessionId, note);
      if (res && res.ok === false) apply(prev);
    } catch (e) { apply(prev); console.error('resume: setNote failed', e); }
  };

  // Listen for cross-tab / cross-device meta changes while the browser is open.
  useEffect(() => {
    if (!open) return;
    const sub = (window as any).claude?.on?.sessionMetaChanged;
    if (!sub) return;
    const off = sub((sid: string, meta: { flag?: string; value?: boolean; note?: string }) => {
      setSessions((prev) => prev.map((s) => {
        if (s.sessionId !== sid) return s;
        let next = s;
        if (meta.flag && meta.flag.startsWith('tag:')) {
          const id = meta.flag.slice(4);
          const tags = meta.value ? [...new Set([...(s.tags ?? []), id])] : (s.tags ?? []).filter((t) => t !== id);
          next = { ...next, tags };
        } else if (meta.flag === 'priority' || meta.flag === 'complete') {
          next = { ...next, flags: { ...(next.flags || {}), [meta.flag]: !!meta.value } };
        }
        if (typeof meta.note === 'string') next = { ...next, note: meta.note };
        return next;
      }));
    });
    // Both preload and remote-shim return an unsubscribe fn for this channel,
    // so calling off() actually removes the listener (no per-open leak).
    return () => {
      try { if (typeof off === 'function') off(); } catch {}
    };
  }, [open]);

  const handleSelectSession = (sessionId: string) => {
    if (expandedId === sessionId) {
      setExpandedId(null);
    } else {
      setExpandedId(sessionId);
      setResumeModel(defaultModel || 'sonnet');
      setResumeDangerous(defaultSkipPermissions || false);
      setResumeLaunchInNewWindow(false);
      setNativeResumeBinding(null);
    }
  };

  const handleConfirmResume = async (s: PastSession) => {
    // Native sessions: the CC-only model / skip-permissions choices are
    // irrelevant (no PTY, no /model or /effort), so pass the current (default)
    // values but tag the row's provider so App takes the native path, PLUS the
    // binding the user just picked (or the prefill auto-selected) in the
    // NativeModelSelect below — the Resume button is disabled until this is
    // set (see the (s.provider === 'native' && !nativeResumeBinding) guard on
    // the button), so it is always present here for a native row.
    //
    // Task 6 review ack-gap: await the resume and close the browser ONLY when it
    // actually launched. A create that never acked returns false — keep the
    // browser open (App has toasted the honest reason) so the user can retry or
    // pick another row, rather than closing over a silent failure.
    setResumingId(s.sessionId);
    const result = await onResume(s.sessionId, s.projectSlug, s.projectPath, resumeModel, resumeDangerous, resumeLaunchInNewWindow, s.provider, nativeResumeBinding ?? undefined);
    setResumingId(null);
    if (result !== false) onClose(); // undefined (non-awaiting wiring) or true → close
  };

  if (!open) return null;

  const renderExpandedOptions = (s: PastSession) => {
  return (
    <div className="px-4 pb-2">
      <div className="rounded-lg bg-inset/50 border border-edge-dim p-3 flex flex-col gap-2">
        {/* Model + Skip Permissions are Claude-Code-only. A native session
            resumes with the model binding stored in its header (there's nothing
            to choose here) and has no PTY permission flow, so both are hidden
            for native rows. */}
        {s.provider !== 'native' ? (
          <>
            {/* Model selector */}
            <div>
              <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Model</label>
              <div className="flex gap-1">
                {MODELS.map((m) => (
                  <button
                    key={m}
                    onClick={() => setResumeModel(m)}
                    className={`flex-1 px-1 py-1 rounded-sm text-[10px] transition-colors ${
                      resumeModel === m
                        ? 'bg-accent text-on-accent font-medium'
                        : 'bg-inset text-fg-dim hover:bg-edge'
                    }`}
                  >
                    {MODEL_LABELS[m] || m}
                  </button>
                ))}
              </div>
            </div>

            {/* Skip Permissions */}
            <div className="flex items-center justify-between">
              <label className="text-[10px] uppercase tracking-wider text-fg-muted inline-flex items-center">
                Skip Permissions
                <SkipPermissionsInfoTooltip />
              </label>
              {/* Shared Toggle (change 15). Its "danger" tone replaces the raw
                  #DD4444 hex this used to hard-code, so themes can restyle it.
                  aria-label added because the adjacent <label> was never
                  associated with the control — screen readers announced nothing. */}
              <Toggle
                checked={resumeDangerous}
                onChange={setResumeDangerous}
                tone="danger"
                aria-label="Skip Permissions"
              />
            </div>
            {/* Warning text was a raw text-[#DD4444] hex. Change 17 moves it onto
                the same token as the toggle beside it, so a community theme
                restyling its red doesn't leave the two out of sync. */}
            {resumeDangerous && (
              <p className="text-[10px] text-destructive-fg">Claude will execute tools without asking for approval.</p>
            )}
          </>
        ) : (
          <div>
            <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Model</label>
            {/* Task 6 — native resume ALWAYS offers this selector (never
                auto-launches a binding). Prefilled from the conversation's
                synced lastUsedModel when it matches a model available on
                THIS device; no local match leaves it un-prefilled — never an
                error, never a substitute. onSelect both handles a manual pick
                AND the (only-once, first-load) prefill auto-select. */}
            <div onClick={(e) => e.stopPropagation()}>
              <NativeModelSelect
                prefill={s.lastUsedModel}
                onSelect={(binding) => setNativeResumeBinding(binding)}
              />
            </div>
          </div>
        )}

        {/* Launch in new window — hidden on remote/Android (single-window) */}
        {detachAvailable && (
          <div className="flex items-center justify-between">
            <label className="text-[10px] uppercase tracking-wider text-fg-muted">Launch in New Window</label>
            {/* Shared Toggle (change 15) — same accent on-state as before. */}
            <Toggle
              checked={resumeLaunchInNewWindow}
              onChange={setResumeLaunchInNewWindow}
              aria-label="Launch in New Window"
            />
          </div>
        )}

        {/* Flags / tags / note are Conversation Store-backed. Task 5 (2026-07-2x)
            unlocked native sessions here too — they're real store records now
            (Task 4), so there's no more "unsupported" branch to hide this
            block behind. A write that somehow gets refused (store down, etc.)
            is still caught by the revert in toggleFlag/toggleTag/saveNote. */}
        <>
          {/* Reserved flags — Priority pins to top; Complete hides from the menu. */}
          <div>
            <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Flags</label>
            <div className="flex gap-1">
              {FLAG_ORDER.map((flag) => {
                const active = !!s.flags?.[flag];
                return (
                  <button
                    key={flag}
                    onClick={(e) => { e.stopPropagation(); toggleFlag(s.sessionId, flag, !active); }}
                    className={`flex-1 px-1 py-1 rounded-sm text-[10px] transition-colors ${
                      active ? 'bg-accent text-on-accent font-medium' : 'bg-inset text-fg-dim hover:bg-edge'
                    }`}
                    aria-pressed={active}
                  >
                    {FLAG_LABEL[flag]}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Custom tags — stopPropagation so interacting doesn't collapse the row. */}
          <div onClick={(e) => e.stopPropagation()}>
            <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Tags</label>
            <TagPicker
              appliedIds={new Set(s.tags ?? [])}
              onToggle={(tagId, next) => toggleTag(s.sessionId, tagId, next)}
              registry={registry}
            />
          </div>

          {/* Note — stopPropagation so editing doesn't collapse the row. */}
          <div onClick={(e) => e.stopPropagation()}>
            <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Note</label>
            <NoteEditor value={s.note ?? ''} onSave={(text) => saveNote(s.sessionId, text)} />
          </div>
        </>

        {/* Resume button. The dangerous (skip-permissions) styling is CC-only —
            native sessions have no PTY permission flow, so it never applies. */}
        {(() => {
          const dangerous = s.provider !== 'native' && resumeDangerous;
          // Task 6 — Resume stays disabled for a native row until a model
          // binding exists (manual pick or a prefill auto-select). Never lets
          // resume proceed with no binding to launch — that would be exactly
          // the auto-launch Destin's ruling forbids.
          const nativeNeedsPick = s.provider === 'native' && !nativeResumeBinding;
          const busy = resumingId === s.sessionId; // create in flight — keep the button busy (ack-gap)
          return (
            /* Filled danger for skip-permissions — same call as SessionStrip's
               Create button (spec §11, change 62). See the longer note there. */
            <Button
              variant={dangerous ? 'danger' : 'primary'}
              size="lg"
              onClick={() => handleConfirmResume(s)}
              disabled={nativeNeedsPick || busy}
              className="w-full py-1.5"
            >
              {busy ? 'Resuming…' : dangerous ? 'Resume (Dangerous)' : 'Resume Session'}
            </Button>
          );
        })()}
      </div>
    </div>
  );
  };

  const renderSessionRow = (s: PastSession, showPath?: boolean) => (
    <div key={s.sessionId}>
      <button
        // Resume is disabled for conversations whose project folder isn't on
        // this device (synced in from elsewhere) OR whose transcript hasn't
        // synced here yet — either way there's nothing to resume into, so the
        // row shows a plain-words note instead of expanding.
        onClick={() => { if (!s.missingProject && !s.notSyncedYet) handleSelectSession(s.sessionId); }}
        aria-disabled={s.missingProject || s.notSyncedYet || undefined}
        className={`w-full text-left px-4 py-2 flex items-center gap-3 transition-colors ${
          s.missingProject || s.notSyncedYet
            ? 'text-fg-dim cursor-default'
            : expandedId === s.sessionId
              ? 'bg-inset text-fg'
              : 'text-fg-dim hover:bg-inset hover:text-fg'
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate flex items-center gap-1.5">
            {/* Runtime badge — native (YouCoded harness) sessions only. Plain
                word, no glyph; distinguishes them from Claude Code transcripts. */}
            {s.provider === 'native' && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded bg-inset text-fg-muted shrink-0"
                title="YouCoded native session"
              >YouCoded</span>
            )}
            {/* Preset label — which harness personality this native session runs
                as. Legacy 'chat' (and any unknown id) falls back to Assistant. */}
            {s.provider === 'native' && (
              <span
                className="text-[9px] px-1.5 py-0.5 rounded bg-inset text-fg-muted shrink-0"
                title="YouCoded native session"
              >{s.harnessId === 'coder' ? 'Coder' : 'Assistant'}</span>
            )}
            <span className="truncate">{s.name}</span>
          </div>
          {/* Reserved-flag indicators + custom-tag chips, AFTER the name. */}
          {(s.flags?.priority || s.flags?.complete || (s.tags && s.tags.length > 0) || s.note) && (
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              {s.flags?.priority && <span className="text-[9px] text-accent" title="Priority">Priority</span>}
              {s.flags?.complete && <span className="text-[9px] text-fg-muted" title="Complete">Complete</span>}
              {(s.tags ?? []).map((id) => {
                const t = registry.byId.get(id);
                return t ? <TagChip key={id} tag={t} /> : null;
              })}
              {s.note && <span className="text-[9px] text-fg-muted" title={s.note}>📝 note</span>}
            </div>
          )}
          {/* Second line: in flat (chronological) mode each row carries its
              project label since there's no group header; size rides along so
              no info is lost vs. the grouped view. Grouped rows keep size only
              — the group header already names the project. */}
          {s.missingProject || s.notSyncedYet ? (
            // Plain words, no glyphs (house rule). The conversation is visible
            // everywhere; resume needs the project folder AND its transcript
            // present on this device — the two notes say which one is missing.
            <div className="text-[10px] text-fg-muted truncate">
              {s.notSyncedYet ? 'Not synced to this device yet' : 'Project folder not on this device'}
            </div>
          ) : (
            <div className="text-[10px] text-fg-muted truncate">
              {showPath
                ? `${s.projectPath.replace(/\\/g, '/').split('/').pop()} · ${formatSize(s.size)}`
                : formatSize(s.size)}
            </div>
          )}
        </div>
        <span className="text-[10px] text-fg-muted shrink-0">
          {formatRelativeTime(s.lastModified)}
        </span>
      </button>
      {expandedId === s.sessionId && renderExpandedOptions(s)}
    </div>
  );

  return (
    <>
      {/* L1 drawer-style modal — theme-driven via Scrim/OverlayPanel. */}
      <Scrim layer={1} onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <OverlayPanel
          layer={1}
          className="w-full max-w-md max-h-[70vh] flex flex-col pointer-events-auto"
          style={{ position: 'relative', zIndex: 'auto' }}
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="px-4 pt-4 pb-3 border-b border-edge">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-sm font-bold text-fg">Resume Session</h2>
              {/* Show Complete — same toggle pattern as Skip Permissions
                  in SessionStrip, but accent-colored to signal "on" rather than "danger". */}
              <div className="flex items-center gap-2">
                <label className="text-[10px] uppercase tracking-wider text-fg-muted">Show Complete</label>
                {/* Shared Toggle (change 15). role="switch" + aria-checked comes
                    from the primitive, which is strictly better than the
                    aria-pressed this used to carry. */}
                <Toggle
                  checked={showComplete}
                  onChange={setShowComplete}
                  aria-label="Show Complete"
                />
              </div>
            </div>
            <div className="flex items-center gap-2 bg-inset rounded-lg px-3 py-2 border border-edge-dim">
              <svg className="w-4 h-4 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <circle cx="11" cy="11" r="7" />
                <path d="M21 21l-4.35-4.35" strokeLinecap="round" />
              </svg>
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search sessions..."
                className="flex-1 bg-transparent text-sm text-fg placeholder-fg-muted outline-none"
              />
            </div>
            <div ref={filterRowRef} className="flex items-center gap-1.5 mt-2 relative">
              {/* Projects: multi-select dropdown over distinct projectPaths in the loaded sessions.
                  Dropdown is portaled to document.body so it escapes the OverlayPanel's
                  overflow:hidden clipping (lets it overlap the panel edge). */}
              <FilterPill
                buttonRef={projectsTriggerRef}
                active={selectedProjects.size > 0}
                hasPopup
                expanded={openPill === 'projects'}
                onClick={(e) => {
                  e.stopPropagation();
                  // Measure synchronously so the dropdown renders with its final
                  // position in the same commit as openPill flipping. Avoids the
                  // two-render lag the prior useLayoutEffect approach had.
                  if (openPill === 'projects') {
                    setOpenPill(null);
                    setProjectsDropdownPos(null);
                  } else {
                    setProjectsDropdownPos(measureDropdown(projectsTriggerRef, 256));
                    setOpenPill('projects');
                  }
                }}
              >
                <span>{projectsLabel}</span>
                <span className="text-fg-faint text-[9px]">▾</span>
              </FilterPill>
              {openPill === 'projects' && projectsDropdownPos && createPortal(
                <div
                  ref={projectsDropdownRef}
                  className="layer-surface w-64 max-w-[calc(100vw-1rem)] overflow-hidden"
                  style={{
                    position: 'fixed',
                    top: projectsDropdownPos.top,
                    left: projectsDropdownPos.left,
                    zIndex: 60,
                  }}
                >
                  {/* "Clear" — text-only affordance that empties selectedProjects (which the data
                      model treats as "filter inactive"). No checkbox visual so it doesn't read as
                      a master "select every project" toggle. Muted small-caps style separates it
                      from the checkbox rows below. Always visible; clicks no-op when already cleared. */}
                  <button
                    type="button"
                    onClick={() => setSelectedProjects(new Set())}
                    className="w-full text-left px-2.5 py-1.5 text-[11px] uppercase tracking-wider text-fg-muted hover:text-fg hover:bg-inset transition-colors"
                  >
                    Clear
                  </button>
                  <div className="max-h-56 overflow-y-auto border-t border-edge-dim">
                    {availableProjects.map((p) => {
                      const checked = selectedProjects.has(p.path);
                      return (
                        <button
                          key={p.path}
                          type="button"
                          onClick={() => {
                            setSelectedProjects((prev) => {
                              const next = new Set(prev);
                              if (next.has(p.path)) next.delete(p.path);
                              else next.add(p.path);
                              return next;
                            });
                          }}
                          className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 hover:bg-inset transition-colors text-fg-2"
                        >
                          <span className={`w-3 h-3 shrink-0 rounded-sm border ${checked ? 'bg-accent border-accent' : 'border-edge'}`} />
                          <span className="flex-1 truncate" title={p.path}>{p.label}</span>
                          <span className="text-[10px] text-fg-muted shrink-0">{p.count}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>,
                document.body,
              )}

              {/* Tags: multi-select dropdown over the user's custom tags. Portaled
                  to escape the OverlayPanel's overflow:hidden clipping. */}
              <FilterPill
                buttonRef={tagsTriggerRef}
                active={selectedTagIds.size > 0}
                hasPopup
                expanded={openPill === 'tags'}
                onClick={(e) => {
                  e.stopPropagation();
                  if (openPill === 'tags') { setOpenPill(null); setTagsDropdownPos(null); }
                  else { setTagsDropdownPos(measureDropdown(tagsTriggerRef, 208)); setOpenPill('tags'); }
                }}
              >
                <span>{selectedTagIds.size === 0 ? 'Tags' : `${selectedTagIds.size} tag${selectedTagIds.size > 1 ? 's' : ''}`}</span>
                <span className="text-fg-faint text-[9px]">▾</span>
              </FilterPill>
              {openPill === 'tags' && tagsDropdownPos && createPortal(
                <div
                  ref={tagsDropdownRef}
                  className="layer-surface w-52 max-w-[calc(100vw-1rem)] max-h-64 overflow-y-auto"
                  style={{ position: 'fixed', top: tagsDropdownPos.top, left: tagsDropdownPos.left, zIndex: 60 }}
                >
                  {registry.tags.filter((t) => !t.archived).length === 0 && (
                    <div className="px-2.5 py-1.5 text-xs text-fg-muted">No tags yet.</div>
                  )}
                  {registry.tags.filter((t) => !t.archived).map((t) => {
                    const checked = selectedTagIds.has(t.id);
                    return (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => setSelectedTagIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(t.id)) next.delete(t.id); else next.add(t.id);
                          return next;
                        })}
                        className="w-full text-left px-2.5 py-1.5 text-xs flex items-center gap-2 hover:bg-inset transition-colors text-fg-2"
                      >
                        <span className={`w-3 h-3 shrink-0 rounded-sm border ${checked ? 'bg-accent border-accent' : 'border-edge'}`} />
                        <TagChip tag={t} />
                      </button>
                    );
                  })}
                </div>,
                document.body,
              )}

              {/* Sort toggle — flips lastModified direction. Priority-pin still wins. */}
              <FilterPill active={sortDir !== 'desc'} onClick={() => setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'))}>
                {sortDir === 'desc' ? 'Most recent ↓' : 'Oldest first ↑'}
              </FilterPill>
            </div>
          </div>

          {/* Session list */}
          {/* No flex-1: OverlayPanel only has max-h (indefinite height), which breaks
              flex-grow in Chromium. Using default flex: 0 1 auto lets flex-shrink
              clamp this div when content exceeds max-h so overflow-y: auto engages
              and the scroll-fade hook sees a real scroll. */}
          {/* Padding lives on an inner wrapper so the scroll-fade element itself has
              no padding. Sticky fade pseudos then sit flush with the scroll-fade's
              outer edge, and the `overflow: hidden` on .layer-surface clips them to
              the OverlayPanel's rounded corners. */}
          <div ref={listRef} className="scroll-fade">
            <div className="py-2">
              {loading ? (
                <LoadingState what="sessions" />
              ) : filtered.length === 0 ? (
                <EmptyState
                  message={search.trim() ? 'No matching sessions' : 'No previous sessions found'}
                  action={search.trim() ? { label: 'Clear search', onClick: () => setSearch('') } : undefined}
                />
              ) : grouped ? (
                // Grouped by project — only when the Projects filter is active
                [...grouped.entries()].map(([projectPath, items]) => (
                  <div key={projectPath} className="mb-2">
                    <div className="px-4 py-1">
                      <span className="text-[10px] uppercase tracking-wider text-fg-muted">
                        {projectPath.replace(/\\/g, '/').split('/').pop() || projectPath}
                      </span>
                    </div>
                    {items.map((s) => renderSessionRow(s))}
                  </div>
                ))
              ) : (
                // Flat chronological list (default view + search results),
                // priority-pinned; each row shows its own project label.
                flatSorted.map((s) => renderSessionRow(s, true))
              )}
            </div>
          </div>
        </OverlayPanel>
      </div>
    </>
  );
}
