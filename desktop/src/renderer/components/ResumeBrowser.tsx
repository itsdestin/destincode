import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel, CONTENT_Z } from './overlays/Overlay';
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
import { TagManagerPopup } from './tags/TagManagerPopup';
import { TagChip } from './tags/TagChip';
import { PRIORITY_TAG, PRIORITY_HINT } from './tags/built-in-tags';
import { NoteEditor } from './tags/NoteEditor';
import ModelPicker, { type ModelChoice } from './model/ModelPicker';
import type { ModelBinding } from '../../shared/provider-types';

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
      className={`px-2.5 py-1 rounded-full text-2xs flex items-center gap-1.5 transition-colors duration-75 ${
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
  return measureAnchored(triggerRef.current, dropdownWidthPx);
}

// Same math against an element rather than a ref. The per-card Organize button
// is created in a list loop, so there is no stable ref to hand measureDropdown —
// its click handler measures its own currentTarget through this instead.
function measureAnchored(
  el: HTMLElement | null,
  dropdownWidthPx: number,
): { top: number; left: number } | null {
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

// FlagName is imported from resume-browser-filters.ts (single source of truth),
// kept in sync with SESSION_FLAG_NAMES in shared/types.ts (that module is
// CommonJS so we don't import it directly).
//
// The FLAG_ORDER / FLAG_LABEL pair that used to live here is gone: neither
// reserved flag renders as a generic "flag" any more. Priority is a built-in
// TAG (built-in-tags.ts) and Complete is the card's hide icon, so each carries
// its own label at its own call site and a shared ordered list had nothing to
// order.

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
  // a row OR ModelPicker auto-selects a prefill match; the Resume button
  // stays disabled for a native row until this is set. Reset whenever a
  // (possibly different) row expands/collapses — a fresh ModelPicker
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

  // Which card's Organize popover is open (session id), plus its anchor position.
  //
  // WHY A POPOVER: flags, tags and the note used to sit in the expanded row,
  // below the launch controls — so one open card stacked seven form fields and
  // the Resume button ended up at the bottom of a form. They are a different
  // JOB from resuming (organizing a conversation you are NOT about to open), so
  // they moved out here. Side effect worth having: you can now tag or complete a
  // conversation WITHOUT expanding it, including rows that can't be resumed on
  // this device at all.
  const [organizeId, setOrganizeId] = useState<string | null>(null);
  const [organizePos, setOrganizePos] = useState<{ top: number; left: number } | null>(null);
  const organizeTriggerRef = useRef<HTMLButtonElement | null>(null);
  const organizePopRef = useRef<HTMLDivElement>(null);
  // The tag registry editor (rename/recolor/archive/delete). Opened from the
  // "Manage tags…" footer in either the Organize popover's TagPicker or the
  // Tags filter dropdown, so there is ONE destination for tag management.
  const [tagManagerOpen, setTagManagerOpen] = useState(false);

  // Fetch sessions when opened
  useEffect(() => {
    if (open) {
      setSearch('');
      setExpandedId(null);
      setResumeModel(defaultModel || 'sonnet');
      setResumeDangerous(defaultSkipPermissions || false);
      setNativeResumeBinding(null);
      setOrganizeId(null);
      setTagManagerOpen(false);
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

  // Layered ESC: close the tag manager, then an open Organize popover, then an
  // open filter dropdown, then collapse the expanded row, then close the
  // browser. Each ESC press peels one layer.
  const handleEscClose = useCallback(() => {
    if (tagManagerOpen) setTagManagerOpen(false);
    else if (organizeId) setOrganizeId(null);
    else if (openPill) setOpenPill(null);
    else if (expandedId) setExpandedId(null);
    else onClose();
  }, [tagManagerOpen, organizeId, openPill, expandedId, onClose]);
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

  // Same outside-click close for the Organize popover. It is portaled to
  // document.body, so the card's own subtree can't see it — the popover ref is
  // checked explicitly (the portal trap that already bit the model picker and
  // the folder switcher). The trigger is checked too so a second click on the
  // "⋯" toggles rather than close-then-reopen.
  useEffect(() => {
    if (!organizeId) return;
    const handler = (e: Event) => {
      const target = e.target as Node;
      if (organizePopRef.current?.contains(target)) return;
      if (organizeTriggerRef.current?.contains(target)) return;
      setOrganizeId(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [organizeId]);

  // Keep the popover anchored while the list scrolls under it (w-64 = 256px).
  useDropdownReposition(!!organizeId, organizeTriggerRef, 256, setOrganizePos);

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

  // Bridge the unified <ModelPicker> onto the two pieces of resume state that
  // already existed: `resumeModel` (a Claude alias) and `nativeResumeBinding`.
  // Which one a row uses is decided by its own provider, so the picker is
  // scoped and only one can ever be in play.
  const resumeChoice = (s: PastSession): ModelChoice | null => {
    if (s.provider === 'native') {
      return nativeResumeBinding
        ? { runtime: 'native', providerId: nativeResumeBinding.providerId, modelId: nativeResumeBinding.modelId }
        : null;
    }
    return resumeModel ? { runtime: 'claude', alias: resumeModel } : null;
  };

  const applyResumeChoice = (s: PastSession, c: ModelChoice) => {
    if (c.runtime === 'native') setNativeResumeBinding({ providerId: c.providerId, modelId: c.modelId });
    else setResumeModel(c.alias);
  };

  const handleConfirmResume = async (s: PastSession) => {
    // Native sessions: the CC-only model / skip-permissions choices are
    // irrelevant (no PTY, no /model or /effort), so pass the current (default)
    // values but tag the row's provider so App takes the native path, PLUS the
    // binding the user just picked (or the prefill auto-selected) in the
    // ModelPicker below — the Resume button is disabled until this is
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

  // The expanded panel is now INSIDE the card (see renderSessionRow), so it
  // drops its own border/fill and separates with a rule instead. The old
  // `bg-inset/50` also had to go: the protection cascade that keeps nested
  // surfaces opaque inside an overlay is `.layer-surface .bg-inset`
  // (globals.css:951), and an opacity modifier emits `bg-inset/50` — a
  // different class the cascade does not match, so it would have gone
  // translucent on wallpaper themes.
  // Tags and note. There is no separate "Flags" section any more: Priority is
  // listed as a built-in TAG (it reads as a label you apply, because that is
  // what it is to the user — see built-in-tags.ts), and Complete moved out of
  // this popover entirely onto the card's hide icon, since marking something
  // done is a one-click action that shouldn't cost opening a menu.
  const renderOrganizeControls = (s: PastSession) => (
    <>
      <div onClick={(e) => e.stopPropagation()}>
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Tags</label>
        <TagPicker
          appliedIds={new Set(s.tags ?? [])}
          onToggle={(tagId, next) => toggleTag(s.sessionId, tagId, next)}
          registry={registry}
          onManageTags={() => { setOrganizeId(null); setTagManagerOpen(true); }}
          builtIns={[{
            tag: PRIORITY_TAG,
            hint: PRIORITY_HINT,
            applied: !!s.flags?.priority,
            // Stored as a flag, not a registry tag — the sort reads one known
            // key rather than scanning a user-editable list.
            onToggle: (next) => toggleFlag(s.sessionId, 'priority', next),
          }]}
        />
      </div>

      <div className="border-t border-edge-dim pt-2" onClick={(e) => e.stopPropagation()}>
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Note</label>
        <NoteEditor value={s.note ?? ''} onSave={(text) => saveNote(s.sessionId, text)} />
      </div>
    </>
  );

  // The expanded panel answers ONE question: how do I relaunch this? Model,
  // the two launch toggles, Resume. Flags/tags/note used to be stacked in here
  // too, which is what made an open card a seven-field form with its primary
  // action at the bottom.
  const renderExpandedOptions = (s: PastSession) => {
  return (
    <div className="border-t border-edge-dim">
      <div className="p-3 flex flex-col gap-2">
        {/* ONE model control for both runtimes. Was two: a Claude alias button
            row here and a separate native picker below, which is the duplication this
            picker exists to end. The list is SCOPED to the row's own runtime —
            a resume cannot move a conversation across runtimes, so offering the
            other side would be a pick that cannot be honoured. */}
        <div onClick={(e) => e.stopPropagation()}>
          <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Model</label>
          <ModelPicker
            value={resumeChoice(s)}
            onSelect={(c) => applyResumeChoice(s, c)}
            includeClaude={s.provider !== 'native'}
            includeNative={s.provider === 'native'}
            prefill={s.lastUsedModel}
            onManageModels={() => window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'))}
          />
        </div>

        {/* Skip Permissions is Claude-Code-only — a native session has no PTY
            permission flow. */}
        {s.provider !== 'native' && (
          <>
            {/* Skip Permissions */}
            <div className="flex items-center justify-between">
              <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase inline-flex items-center">
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
              <p className="text-3xs text-destructive-fg">Claude will execute tools without asking for approval.</p>
            )}
          </>
        )}

        {/* Launch in new window — hidden on remote/Android (single-window) */}
        {detachAvailable && (
          <div className="flex items-center justify-between">
            <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Launch in New Window</label>
            {/* Shared Toggle (change 15) — same accent on-state as before. */}
            <Toggle
              checked={resumeLaunchInNewWindow}
              onChange={setResumeLaunchInNewWindow}
              aria-label="Launch in New Window"
            />
          </div>
        )}

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

  const renderSessionRow = (s: PastSession, showPath?: boolean) => {
    const isExpanded = expandedId === s.sessionId;
    // Unresumable rows are inert: no card hover, no expand. See the note on the
    // click handler below for the two reasons a row lands here.
    const inert = !!(s.missingProject || s.notSyncedYet);
    // px-4 matches the search bar and the project group headers above, so the
    // card's outer edge lines up with the rest of the panel.
    return (
    <div key={s.sessionId} className="px-4 pb-2">
      {/* Expandable card. The surface is `bg-inset` + `border-edge-dim`, NOT
          `.layer-surface`.
          `.layer-surface` is the FLOATING surface — panel fill + border +
          `0 8px 32px` shadow + the wallpaper glass treatment — and it must
          appear exactly ONCE per stack. It is right for a card sitting directly
          on canvas (SkillCard.tsx:117, MarketplaceCard, FilesTab.tsx:393) and
          for the overlay itself. Nesting one inside another stacks all four:
          under `[data-wallpaper]` each `.layer-surface` is
          `color-mix(--panel, panels-opacity%)`, so a card inside the Resume
          OverlayPanel lays a second helping of --panel over the first and the
          cards glow brighter than the panel holding them (reported 2026-07-30).
          CommandDrawer gets away with `.layer-surface` tiles only because its
          own container is a plain `bg-panel` utility (CommandDrawer.tsx:195),
          which the wallpaper rule does not touch.
          `bg-inset` is what every other item nested in an overlay uses —
          ModelPicker rows, OpenTasksPopup, TagPicker, ContextPopup — and the
          protection cascade (`.layer-surface .bg-inset`, globals.css:951) keeps
          it opaque inside a glass panel.
          Bare `bg-inset` here rather than change 25's `bg-inset/50` in-panel ROW
          surface (EngineCard.tsx:92, LocalModelsSection, ModelProvidersPopup —
          24 files): a row is a tint inside a section, a card is an object you
          click, so it gets the full fill. Worth knowing that the /50 form falls
          outside the protection cascade above, which matches on `.bg-inset`
          exactly — so those rows do let a wallpaper through where a bare
          `bg-inset` would not. That is long-standing and deliberate-looking;
          it is NOT something to "fix" from this file.
          `card-interactive` is deliberately absent — its own comment scopes it
          to cards that ARE a `.layer-surface`, and its hover fill is
          `var(--inset)`, a no-op on an inset base. Hover moves the border
          instead, following SettingsPanel.tsx:1833's selectable cards.
          The card wraps BOTH the trigger and the expanded panel so an open row
          reads as one object instead of a row with a detached box under it. */}
      <div
        className={`rounded-lg border bg-inset overflow-hidden transition-colors ${
          isExpanded ? 'border-accent' : inert ? 'border-edge-dim' : 'border-edge-dim hover:border-edge'
        }`}
      >
      {/* Header row: the expand trigger plus the Organize button beside it.
          They are SIBLINGS, not nested — a button inside a button is invalid
          HTML and the inner one would never receive its own click. */}
      <div className="flex items-stretch">
      <button
        // Resume is disabled for conversations whose project folder isn't on
        // this device (synced in from elsewhere) OR whose transcript hasn't
        // synced here yet — either way there's nothing to resume into, so the
        // row shows a plain-words note instead of expanding.
        onClick={() => { if (!inert) handleSelectSession(s.sessionId); }}
        aria-disabled={inert || undefined}
        aria-expanded={inert ? undefined : isExpanded}
        className={`flex-1 min-w-0 text-left p-3 pr-1 flex focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          inert ? 'text-fg-dim cursor-default' : isExpanded ? 'text-fg' : 'text-fg-dim'
        }`}
      >
        <div className="flex-1 min-w-0">
          <div className="text-sm truncate flex items-center gap-1.5">
            {/* Runtime badge — native (YouCoded harness) sessions only. Plain
                word, no glyph; distinguishes them from Claude Code transcripts. */}
            {s.provider === 'native' && (
              <span
                className="text-4xs px-1.5 py-0.5 rounded bg-inset text-fg-muted shrink-0"
                title="YouCoded native session"
              >YouCoded</span>
            )}
            {/* Preset label — which harness personality this native session runs
                as. Legacy 'chat' (and any unknown id) falls back to Assistant. */}
            {s.provider === 'native' && (
              <span
                className="text-4xs px-1.5 py-0.5 rounded bg-inset text-fg-muted shrink-0"
                title="YouCoded native session"
              >{s.harnessId === 'coder' ? 'Coder' : 'Assistant'}</span>
            )}
            <span className="truncate flex-1 min-w-0">{s.name}</span>
            {/* Timestamp rides the NAME line, top-right, rather than being
                vertically centred against the whole card. A card can be one
                line or four (chips, project/size, an inert-row note) and a
                centred timestamp drifted with it; pinned to the title line it
                sits on a stable baseline across every row. */}
            <span className="text-3xs text-fg-muted shrink-0 font-normal">
              {formatRelativeTime(s.lastModified)}
            </span>
          </div>
          {/* Tag chips after the name. Priority is FIRST and rendered with the
              same TagChip as everything else — it is a built-in tag, not a
              separate species of label (built-in-tags.ts). Complete has no chip:
              its state is the hide icon on the right of this row. */}
          {(s.flags?.priority || (s.tags && s.tags.length > 0) || s.note) && (
            <div className="flex items-center gap-1 mt-0.5 flex-wrap">
              {s.flags?.priority && <TagChip tag={PRIORITY_TAG} />}
              {(s.tags ?? []).map((id) => {
                const t = registry.byId.get(id);
                return t ? <TagChip key={id} tag={t} /> : null;
              })}
              {s.note && <span className="text-4xs text-fg-muted" title={s.note}>📝 note</span>}
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
            <div className="text-3xs text-fg-muted truncate">
              {s.notSyncedYet ? 'Not synced to this device yet' : 'Project folder not on this device'}
            </div>
          ) : (
            <div className="text-3xs text-fg-muted truncate">
              {showPath
                ? `${s.projectPath.replace(/\\/g, '/').split('/').pop()} · ${formatSize(s.size)}`
                : formatSize(s.size)}
            </div>
          )}
        </div>
      </button>
      {/* Complete — the classic "hide" eye-with-a-slash, because that is what
          Complete DOES here: the row drops out of the list unless Show Complete
          is on. It sits on the card rather than inside the Organize popover
          because finishing with a conversation is a one-click action, and
          costing a menu-open for it is what made the old flag row feel buried.
          Hover copy is a question ("Mark this session complete?") so the icon
          reads as an action, not a status badge. */}
      {(() => {
        const done = !!s.flags?.complete;
        return (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); toggleFlag(s.sessionId, 'complete', !done); }}
            aria-pressed={done}
            title={done ? 'Marked complete — hidden unless Show Complete is on. Click to undo.' : 'Mark this session complete?'}
            aria-label={done ? `Mark ${s.name} not complete` : `Mark ${s.name} complete`}
            className={`shrink-0 pl-1 pr-0.5 pt-3 flex items-start focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
              done ? 'text-accent' : 'text-fg-faint hover:text-fg-2'
            }`}
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {done ? (
                // Struck-through eye = hidden. The slash is the state.
                <>
                  <path d="M9.9 4.24A9.1 9.1 0 0112 4c5 0 9 5 9 5a15.5 15.5 0 01-2.8 3.24M6.6 6.6A15.6 15.6 0 003 9s4 5 9 5a9 9 0 003.4-.66" />
                  <path d="M9.9 9.9a3 3 0 004.2 4.2" />
                  <path d="M3 3l18 18" />
                </>
              ) : (
                // Plain eye = currently visible; clicking hides it.
                <>
                  <path d="M3 9s4-5 9-5 9 5 9 5-4 5-9 5-9-5-9-5z" />
                  <circle cx="12" cy="9" r="2.5" />
                </>
              )}
            </svg>
          </button>
        );
      })()}
      {/* Organize: tags and note. Always visible rather than hover-revealed —
          a hover-only affordance is invisible on touch and undiscoverable on
          desktop, and this is the ONLY route to tagging. Rendered for inert
          rows too: the metadata is Conversation Store-backed, so a conversation
          synced in from another device can be organized here even though it
          can't be resumed on this one. */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          if (organizeId === s.sessionId) { setOrganizeId(null); return; }
          // Measure synchronously off the trigger so the popover renders at its
          // final position in the same commit the id flips (same approach the
          // filter pills use — avoids a one-frame jump).
          organizeTriggerRef.current = e.currentTarget;
          setOrganizePos(measureAnchored(e.currentTarget, 256));
          setOrganizeId(s.sessionId);
        }}
        aria-label={`Organize ${s.name}`}
        aria-haspopup="dialog"
        aria-expanded={organizeId === s.sessionId}
        className={`shrink-0 px-2.5 pt-3 flex items-start focus:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
          organizeId === s.sessionId ? 'text-fg' : 'text-fg-faint hover:text-fg-2'
        }`}
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      </div>
      {isExpanded && renderExpandedOptions(s)}
      </div>
    </div>
    );
  };

  return (
    <>
      {/* L1 drawer-style modal — theme-driven via Scrim/OverlayPanel. */}
      <Scrim layer={1} onClick={onClose} />
      <div className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none" style={{ zIndex: CONTENT_Z[1] }}>
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
                <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Show Complete</label>
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
                <span className="text-fg-faint text-4xs">▾</span>
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
                    className="w-full text-left px-2.5 py-1.5 text-2xs text-fg-muted tracking-wider uppercase hover:text-fg hover:bg-inset transition-colors"
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
                          <span className="text-3xs text-fg-muted shrink-0">{p.count}</span>
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
                <span className="text-fg-faint text-4xs">▾</span>
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
                  {/* Second route to the tag manager, so "where do I rename a
                      tag?" is answerable from the filter too — not only from a
                      conversation's Organize popover. */}
                  <button
                    type="button"
                    onClick={() => { setOpenPill(null); setTagManagerOpen(true); }}
                    className="w-full text-left px-2.5 py-1.5 text-2xs text-fg-muted tracking-wider uppercase hover:text-fg hover:bg-inset transition-colors border-b border-edge-dim"
                  >
                    Manage tags…
                  </button>
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
                      <span className="text-3xs font-medium text-fg-muted tracking-wider uppercase">
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

      {/* Organize popover — one instance driven by organizeId, not one per card.
          Portaled to document.body for the same reason the filter dropdowns are:
          OverlayPanel is `.layer-surface`, which sets overflow:hidden, so a
          popover rendered inside a card would be clipped at the panel edge. */}
      {organizeId && organizePos && (() => {
        const s = sessions.find((x) => x.sessionId === organizeId);
        if (!s) return null;
        return createPortal(
          <div
            ref={organizePopRef}
            className="layer-surface w-64 max-w-[calc(100vw-1rem)] p-2.5 flex flex-col gap-2"
            style={{ position: 'fixed', top: organizePos.top, left: organizePos.left, zIndex: 60 }}
            role="dialog"
            aria-label={`Organize ${s.name}`}
          >
            {renderOrganizeControls(s)}
          </div>,
          document.body,
        );
      })()}

      <TagManagerPopup open={tagManagerOpen} onClose={() => setTagManagerOpen(false)} registry={registry} />
    </>
  );
}
