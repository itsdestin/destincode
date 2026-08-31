import React, { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { SessionStatusColor, STATUS_LABEL } from './StatusDot';
import { Button, Toggle } from './ui';
import { isAndroid } from '../platform';
import FolderSwitcher from './FolderSwitcher';
import { SkipPermissionsInfoTooltip } from './SkipPermissionsInfoTooltip';
import { useNativeBinding, usePreset, NativeExtras, loadLastBinding, persistLastBinding, type Runtime, type Binding } from './RuntimeBinding';
import ModelPicker, { type ModelChoice } from './model/ModelPicker';
import { packSessions, PILL_GAP, type SessionMeasurement, type PackResult } from './header/pack-sessions';
import { pillLabelStyle } from './header/pill-label-style';
import { nearestPillId, reorderIndices, type PillRect } from './header/drag-order';
import { useOneShotWindow } from '../hooks/use-one-shot-window';
import { useFrozenPack } from './header/use-frozen-pack';
import { useScrollFade } from '../hooks/useScrollFade';
import { useArtifact } from '../state/ArtifactContext';
import { isTypingTarget } from '../utils/is-typing-target';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { useSessionMeta } from '../hooks/useSessionMeta';
import { PRIORITY_TAG } from './tags/built-in-tags';
import { NotePageGlyph } from './tags/glyphs';
import { TagChip } from './tags/TagChip';
import type { TagRecord } from '../../shared/tags';

interface SessionEntry {
  id: string;
  name: string;
  cwd: string;
  permissionMode: string;
  // Which runtime backend this session runs — 'claude' (default) or 'native'.
  // Drives the live-pill "YouCoded · <preset>" badge for native sessions.
  provider?: string;
  // Resolved native preset id ('assistant' | 'coder', post legacy-mapping).
  // Absent for Claude sessions.
  harnessId?: string;
}

interface Props {
  sessions: SessionEntry[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onCreateSession: (cwd: string, dangerous: boolean, model: string, provider?: 'claude' | 'native', launchInNewWindow?: boolean, binding?: { providerId: string; modelId: string }, preset?: string) => void;
  onCloseSession: (id: string) => void;
  sessionStatuses?: Map<string, SessionStatusColor>;
  // WHY: `onResumeSession` is no longer accepted here. The strip never invoked
  // it — resuming is owned by the ResumeBrowser modal, opened via
  // `onOpenResumeBrowser` below. App/HeaderBar were still passing it through;
  // those call sites are updated in the same commit.
  onOpenResumeBrowser: () => void;
  onReorderSessions?: (fromIndex: number, toIndex: number) => void;
  defaultModel?: string;
  defaultSkipPermissions?: boolean;
  defaultProjectFolder?: string;
  /** Window directory (for switcher's "Sessions in other windows" group). */
  windowDirectory?: {
    leaderWindowId: number;
    windows: { window: { id: number; label: string; createdAt: number }; sessions: SessionEntry[] }[];
  } | null;
  /** This renderer's own window id — excluded from remote sessions group. */
  myWindowId?: number | null;
}

/* ── Status dot color maps ───────────────────────────────── */

const DOT_BG: Record<SessionStatusColor, string> = {
  green: 'bg-green-400',
  red: 'bg-red-400',
  // Amber harmonizes with the buddy AttentionStrip's #f5a623 ("needs
  // attention" convention). bg-amber-400 (#fbbf24) reads as the same status
  // across surfaces.
  amber: 'bg-amber-400',
  blue: 'bg-blue-400',
  gray: 'bg-gray-500',
};

const GLOW_SHADOW: Record<SessionStatusColor, string> = {
  green: '0 0 6px rgba(76,175,80,0.35)',
  red: '0 0 6px rgba(221,68,68,0.35)',
  amber: '0 0 6px rgba(245,166,35,0.35)',
  blue: '0 0 6px rgba(96,165,250,0.35)',
  gray: 'none',
};

// WHY: `INDICATOR_COLOR` was the pre-tailwind status-dot palette. The strip
// switched to theme-driven classes; the object was left behind. Removed in the
// 2026-08-06 unused-code sweep.

function SessionDot({ color, isActive }: { color: SessionStatusColor; isActive: boolean }) {
  const breathing = color !== 'gray';
  return (
    <span className="relative inline-flex items-center justify-center w-2.5 h-2.5 shrink-0">
      <span
        className={`relative w-2 h-2 rounded-full ${DOT_BG[color]}`}
        // Perf: steps(8) instead of ease-in-out. This dot breathes whenever the
        // session isn't gray — i.e. for every non-idle session, in the
        // always-visible header — and on a 180Hz panel a smoothly-animating
        // element costs ~29% of one CPU core (Chromium presents a frame per
        // refresh; measured 2026-07-30, cost is per-frame not per-element).
        // steps(8) = 8 opacity changes/sec: measured 3x cheaper, and visually
        // indistinguishable on an 8px dot. See the .animate-pulse comment in
        // globals.css + docs/archive/investigations/2026-07-30-idle-cpu-burn.md
        style={breathing ? { animation: 'breathe 2s steps(8) infinite' } : { opacity: isActive ? 1 : 0.5 }}
      />
    </span>
  );
}

/* ── Status pill ─────────────────────────────────────────── */

// P-8 (2026-08-28): the menu used to show the bare dot and nothing else, so the
// colour was the whole message and you had to remember what amber meant. The
// pill says it in words. Background and border are the dot's own colour at low
// strength; the WORD is the theme's text colour, because the dot palette is
// fixed (bg-green-400 and friends) and a green word on a pale theme measured
// well under a readable contrast.
const STATUS_PILL: Record<SessionStatusColor, string> = {
  green: 'bg-green-400/15 border-green-400/30',
  red: 'bg-red-400/15 border-red-400/30',
  amber: 'bg-amber-400/15 border-amber-400/30',
  blue: 'bg-blue-400/15 border-blue-400/30',
  gray: 'bg-gray-500/15 border-gray-500/30',
};

// `label` exists for ONE caller: the mock-up page that shows two candidate
// wordings side by side. Everywhere in the app it is omitted, so STATUS_LABEL
// stays the single source of the words.
export function StatusPill({ color, isActive, label }: { color: SessionStatusColor; isActive: boolean; label?: string }) {
  return (
    <span className={`shrink-0 inline-flex items-center gap-1 pl-1 pr-1.5 py-[1px] rounded-full border text-4xs leading-none text-fg-2 ${STATUS_PILL[color]}`}>
      <SessionDot color={color} isActive={isActive} />
      {label ?? STATUS_LABEL[color]}
    </span>
  );
}

/* ── Project folder mark ─────────────────────────────────── */

function FolderMark({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 7.5A1.5 1.5 0 014.5 6h4l2 2.5h7A1.5 1.5 0 0119 10v7a1.5 1.5 0 01-1.5 1.5h-13A1.5 1.5 0 013 17V7.5z" />
    </svg>
  );
}

/* ── Tag marks (a named chip per tag, plus a page when there is a note) ── */

// The tags a session carries, as the same named chips the tag picker and the
// Resume Browser card use — spelled out, not colour-coded dots (Destin, P-8
// review 2, 2026-08-28: "tags should not be dots, but full chips with spelled
// names"). Priority is a reserved flag rather than a tag and leads the row, the
// way it leads the status-bar chip.
const MAX_CHIPS = 3;

function SessionTagMarks({ sessionId, byId }: { sessionId: string; byId: Map<string, TagRecord> }) {
  // One getMeta per open row. The menu holds the live sessions of ONE window,
  // so this is a handful of cheap reads while it is open, and nothing at all
  // when it is shut. A bulk read would need a new channel on all five surfaces.
  const meta = useSessionMeta(sessionId);
  const applied = [...meta.tags].map((id) => byId.get(id)).filter((t): t is TagRecord => !!t);
  const marks: { label: string; color: string }[] = [
    ...(meta.flags.priority ? [{ label: PRIORITY_TAG.label, color: PRIORITY_TAG.color as string }] : []),
    ...applied.map((t) => ({ label: t.label, color: t.color as string })),
  ];
  if (marks.length === 0 && !meta.note) return null;
  // Names cost width, so past three the rest collapse into a count that names
  // them on hover — a row must never push the status pill off its own line.
  const shown = marks.slice(0, MAX_CHIPS);
  const rest = marks.slice(MAX_CHIPS);
  return (
    <span className="shrink-0 flex items-center gap-1">
      {shown.map((m, i) => (
        <TagChip key={i} tag={{ label: m.label, color: m.color as TagRecord['color'] }} />
      ))}
      {rest.length > 0 && (
        <span className="text-3xs text-fg-muted" title={rest.map((m) => m.label).join(', ')}>
          +{rest.length}
        </span>
      )}
      {meta.note && (
        <span title="This session has a note" className="flex items-center">
          <NotePageGlyph className="w-3 h-3 text-fg-faint" />
        </span>
      )}
    </span>
  );
}

/* ── Drag grip icon (6-dot braille pattern) ──────────────── */

function DragGrip() {
  return (
    <svg className="w-3 h-3 text-fg-faint" viewBox="0 0 12 16" fill="currentColor">
      <circle cx="3.5" cy="2" r="1.2" />
      <circle cx="8.5" cy="2" r="1.2" />
      <circle cx="3.5" cy="8" r="1.2" />
      <circle cx="8.5" cy="8" r="1.2" />
      <circle cx="3.5" cy="14" r="1.2" />
      <circle cx="8.5" cy="14" r="1.2" />
    </svg>
  );
}

/* ── Adaptive session name — shrinks font / adds lines to fit ── */

// P-8 (2026-08-28): one line, cut with an ellipsis, full name on hover.
// This used to wrap to three lines and shrink to 11px to fit the whole name,
// which made six of ten rows two or three lines tall (70px against 42px) and
// left the menu's rows visibly uneven. The project folder now sits on its own
// second line under the name, so the name gets the row's full width.
function SessionName({ name }: { name: string }) {
  return (
    <span className="block truncate leading-snug text-sm-tight" title={name}>
      {name}
    </span>
  );
}

/* ── Main component ──────────────────────────────────────── */

export default function SessionStrip({
  sessions, activeSessionId, onSelectSession,
  onCreateSession, onCloseSession, sessionStatuses,
  onOpenResumeBrowser, onReorderSessions,
  defaultModel, defaultSkipPermissions, defaultProjectFolder,
  windowDirectory, myWindowId,
}: Props) {
  // One registry read for the whole menu: the rows need tag COLOURS, and a hook
  // per row would be one tags.list() per row.
  const tagsById = useTagRegistry().byId;

  // Artifact dispatch — SessionStrip renders only in the main window, inside
  // the ArtifactContext provider, so calling the hook at top level is safe.
  // Used by the FolderSwitcher "Manage projects…" footer to open Project View.
  const { dispatch: artifactDispatch } = useArtifact();
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [shiftNavIdx, setShiftNavIdx] = useState<number>(-1);
  const shiftNavActive = useRef(false);
  const [showNewForm, setShowNewForm] = useState(false);
  const [newCwd, setNewCwd] = useState('');
  const [dangerous, setDangerous] = useState(false);
  const [newModel, setNewModel] = useState<string>('sonnet');
  // Runtime (Claude Code vs YouCoded native harness) + native binding. The
  // whole control — Runtime toggle, provider/model picker, and all derivation —
  // now lives in the shared RuntimeBinding module so this form and the welcome/
  // app-open form can't drift on native-session creation.
  const [runtime, setRuntime] = useState<Runtime>('claude');
  const [binding, setBinding] = useState<Binding | null>(() => loadLastBinding());
  const nb = useNativeBinding({ active: showNewForm, runtime, binding, setBinding });
  // Native harness preset (Assistant | Coder) — shared lifecycle hook (see
  // RuntimeBinding.usePreset). Follows the folder heuristic until the user picks a
  // card, then latches; re-arms every time the form (re)opens via `showNewForm`.
  const { preset, setPreset } = usePreset({ active: showNewForm, cwd: newCwd });

  // Bridge between the unified <ModelPicker> and the create-time state the form
  // already threads through (runtime / newModel / binding). Kept as a derived
  // value + one setter so the create path below is untouched while the UI is
  // being iterated on.
  const modelChoice: ModelChoice | null = runtime === 'native'
    ? (nb.effectiveBinding
        ? { runtime: 'native', providerId: nb.effectiveBinding.providerId, modelId: nb.effectiveBinding.modelId }
        : null)
    : { runtime: 'claude', alias: newModel };

  const applyModelChoice = (c: ModelChoice) => {
    if (c.runtime === 'claude') {
      setRuntime('claude');
      setNewModel(c.alias);
    } else {
      setRuntime('native');
      nb.setBinding({ providerId: c.providerId, modelId: c.modelId });
    }
  };
  // Launch the new session in its own peer window instead of this one.
  // Hidden on platforms without multi-window support (Android / remote-shim).
  const [launchInNewWindow, setLaunchInNewWindow] = useState(false);
  const detachAvailable = typeof (window as any).claude?.detach?.openDetached === 'function';
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const triggerBtnRef = useRef<HTMLButtonElement>(null);
  const pillBarRef = useRef<HTMLDivElement>(null);
  const sessionListRef = useScrollFade<HTMLDivElement>();

  /* ── Pointer-event drag state ──────────────────────────── */
  // Keyed by SESSION ID, not index — see header/drag-order.ts.
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  // The strip's pill geometry, MEASURED ONCE at pointer-down and not touched
  // again until the next one. A ref, not state: the render reads it to position
  // neighbours, but writing it must not itself schedule a render.
  //
  // WHY frozen rather than re-measured per move: getBoundingClientRect()
  // INCLUDES the translateX applied to the neighbours while a drag is in
  // flight. Re-measuring would feed this frame's answer to "which pill am I
  // over?" back in as next frame's input — the pills chatter back and forth at
  // the boundaries, and the dragged pill's travel clamp (computed from its own
  // rect) drifts.
  const pillRectsRef = useRef<PillRect[]>([]);
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [dragLabel, setDragLabel] = useState<string>('');
  const [dragColor, setDragColor] = useState<SessionStatusColor>('gray');
  const [ghostTarget, setGhostTarget] = useState<{ x: number; y: number } | null>(null);
  // Track whether pointer moved enough to distinguish drag from click
  const dragOrigin = useRef<{ x: number; y: number } | null>(null);
  const isDragging = useRef(false);
  // Suppress the click that fires after a drag release
  const suppressClick = useRef(false);
  // Chrome-style live tear-off: once the user drags the pill far enough below
  // the header, we spawn the new window mid-drag and stream cursor positions
  // to it so it follows the mouse. Ref (not state) because we read/write it
  // from pointermove without wanting a re-render per frame. `pending` guards
  // the async spawn so we only fire the IPC once per drag.
  const liveDetachedWindowId = useRef<number | null>(null);
  const liveDetachPending = useRef(false);
  // Where inside the grabbed pill the cursor sits when pointerdown fires.
  // Reused during live tear-off to position the new window so the cursor ends
  // up over the *same spot* on the torn-off pill, not the window's corner.
  const grabOffsetInPill = useRef<{ x: number; y: number }>({ x: 40, y: 12 });
  const pointerCaptureEl = useRef<HTMLElement | null>(null);
  const pointerCaptureId = useRef<number | null>(null);
  // Cross-window re-dock: true while another window is dragging a pill and
  // the cursor is currently over this window's strip. Drives a visual drop-
  // target highlight. Cleared on any non-hover tick or when the drag ends.
  const [incomingDropActive, setIncomingDropActive] = useState(false);

  // Listen for cross-window cursor updates from main — fires ~30Hz while
  // a peer window is dragging a pill. We hit-test each update against our
  // own strip's bounding box to decide whether to show the drop highlight.
  useEffect(() => {
    const det = (window as any).claude?.detach;
    if (!det?.onCrossWindowCursor) return;
    const unsub = det.onCrossWindowCursor(({ screenX, screenY }: { screenX: number; screenY: number }) => {
      const bar = pillBarRef.current;
      if (!bar) { setIncomingDropActive(false); return; }
      // Ignore cursor broadcasts originating from our own drag — the source
      // window also receives these but shouldn't highlight its own strip.
      if (isDragging.current) { setIncomingDropActive(false); return; }
      const rect = bar.getBoundingClientRect();
      const localX = screenX - window.screenX;
      const localY = screenY - window.screenY;
      const inside =
        localX >= rect.left && localX <= rect.right &&
        localY >= rect.top && localY <= rect.bottom;
      setIncomingDropActive(inside);
    });
    return () => { try { unsub?.(); } catch {} setIncomingDropActive(false); };
  }, []);

  // Home path is now auto-selected by FolderSwitcher on mount

  // Close menu on outside click (check both trigger area and portal dropdown)
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const inTrigger = menuRef.current?.contains(target);
      const inDropdown = dropdownRef.current?.contains(target);
      // Fix: the FolderSwitcher's dropdown is PORTALED to document.body (to
      // escape this menu's overflow-hidden), so the contains() checks above
      // can't see it. Without this check, a mousedown on the portaled panel
      // counted as "outside", closed the menu, and unmounted the picker BEFORE
      // its click could fire — "Manage projects…" and row selection did nothing.
      const inFolderPortal = target instanceof Element && !!target.closest('[data-folder-switcher-portal]');
      // Same trap for the Provider/Model Select menus (RuntimeBinding): those
      // portal to document.body too (data-select-portal), so a click on an
      // option would otherwise close this menu and unmount the Select before
      // its onChange fires — the exact bug above, one component over.
      const inSelectPortal = target instanceof Element && !!target.closest('[data-select-portal]');
      // Third instance of the same trap: the unified <ModelPicker> portals its
      // dropdown to document.body as well. Without this, clicking a model (or
      // its favourite star, or a filter chip) closed this menu and unmounted
      // the picker before the click landed.
      const inModelPortal = target instanceof Element && !!target.closest('[data-model-picker-portal]');
      if (!inTrigger && !inDropdown && !inFolderPortal && !inSelectPortal && !inModelPortal) {
        setMenuOpen(false);
        setShowNewForm(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

  // Shift-hold session switcher: hold Shift to open dropdown, arrow keys to
  // navigate, release Shift to switch to the highlighted session
  const shiftHoldTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTypingTarget(document.activeElement)) return;

      // Bare Shift press — start hold timer to open dropdown
      if (e.key === 'Shift' && !e.ctrlKey && !e.altKey && !e.metaKey && !shiftNavActive.current) {
        shiftHoldTimer.current = setTimeout(() => {
          shiftHoldTimer.current = null;
          shiftNavActive.current = true;
          const currentIdx = sessions.findIndex(s => s.id === activeSessionId);
          setShiftNavIdx(currentIdx >= 0 ? currentIdx : 0);
          setMenuOpen(true);
        }, 350);
        return;
      }

      // Arrow keys while shift-nav is active
      if (shiftNavActive.current && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        setShiftNavIdx(prev => {
          if (e.key === 'ArrowDown') return Math.min(prev + 1, sessions.length - 1);
          return Math.max(prev - 1, 0);
        });
        return;
      }

      // Any other key while Shift is held — cancel switcher (timer or already open)
      if (shiftHoldTimer.current) {
        clearTimeout(shiftHoldTimer.current);
        shiftHoldTimer.current = null;
      }
      if (shiftNavActive.current) {
        shiftNavActive.current = false;
        setShiftNavIdx(-1);
        setMenuOpen(false);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        // Cancel hold timer if Shift was released before it fired
        if (shiftHoldTimer.current) {
          clearTimeout(shiftHoldTimer.current);
          shiftHoldTimer.current = null;
        }
        if (shiftNavActive.current) {
          // Release Shift — select the highlighted session and close
          shiftNavActive.current = false;
          setShiftNavIdx(idx => {
            if (idx >= 0 && idx < sessions.length) {
              onSelectSession(sessions[idx].id);
            }
            return -1;
          });
          setMenuOpen(false);
        }
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      if (shiftHoldTimer.current) clearTimeout(shiftHoldTimer.current);
    };
  }, [sessions, activeSessionId, onSelectSession]);

  const handleEnter = useCallback((id: string) => {
    // A pack-expanded pill already shows its name — there is nothing to
    // reveal, and setting hoveredId would only cost a render.
    if (packRef.current.expanded.has(id)) return;
    // Widths freeze for the duration of a drag: dragging OVER a pill must not
    // trigger its hover reveal and grow the row under the cursor.
    if (dragIdRef.current !== null) return;
    if (leaveTimer.current) { clearTimeout(leaveTimer.current); leaveTimer.current = null; }
    setHoveredId(id);
  }, []);

  const handleLeave = useCallback(() => {
    leaveTimer.current = setTimeout(() => setHoveredId(null), 80);
  }, []);


  const handleMenuToggle = useCallback(() => {
    setMenuOpen(prev => !prev);
    setShowNewForm(false);
  }, []);

  const handleCreate = useCallback(() => {
    // Native runtime carries a provider/model binding; a missing binding is
    // already guarded by the disabled Create button, so bail defensively.
    if (runtime === 'native') {
      if (!nb.effectiveBinding) return;
      persistLastBinding(nb.effectiveBinding);
    }
    onCreateSession(
      newCwd,
      // Hidden for native (see the gate on the toggle), so a value left over
      // from an earlier Claude pick must not ride along into the create.
      runtime === 'native' ? false : dangerous,
      newModel,
      runtime,
      launchInNewWindow,
      runtime === 'native' ? (nb.effectiveBinding ?? undefined) : undefined,
      runtime === 'native' ? preset : undefined,
    );
    setMenuOpen(false);
    setShowNewForm(false);
    setDangerous(defaultSkipPermissions || false);
    setNewModel(defaultModel || 'sonnet');
    setLaunchInNewWindow(false);
    setRuntime('claude');
  }, [newCwd, dangerous, newModel, launchInNewWindow, onCreateSession, defaultSkipPermissions, defaultModel, runtime, nb.effectiveBinding, preset]);

  /* ── Pointer-event drag handlers ───────────────────────── */

  const handlePointerDown = useCallback((e: React.PointerEvent, sessionId: string) => {
    // Only primary button
    if (e.button !== 0) return;
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;

    const s = sessions.find(x => x.id === sessionId);
    if (!s) return;
    // Capture label + color eagerly so pointermove can start immediately
    setDragId(s.id);
    // Any standing hover would keep that pill wide for the whole drag.
    setHoveredId(null);

    // Freeze the strip's geometry for the whole drag — see pillRectsRef.
    const barEl = pillBarRef.current;
    if (barEl) {
      // Array.from, not spread: this tsconfig's lib has no DOM.Iterable, so a
      // NodeList is not iterable here.
      pillRectsRef.current = Array.from(barEl.querySelectorAll<HTMLElement>('[data-session-id]'))
        .map(el => {
          const r = el.getBoundingClientRect();
          return { id: el.dataset.sessionId!, left: r.left, right: r.right };
        });
    }
    setDragLabel(s.name);
    setDragColor(sessionStatuses?.get(s.id) || 'gray');

    // Measure where in the pill the cursor landed. Used when the live-detach
    // spawns a new window: we offset that window's screen position so the
    // cursor stays over the pill, not the window's top-left corner.
    const pillEl = (e.target as HTMLElement).closest('[data-session-idx]') as HTMLElement | null;
    if (pillEl) {
      const r = pillEl.getBoundingClientRect();
      grabOffsetInPill.current = { x: e.clientX - r.left, y: e.clientY - r.top };
    }

    // Capture on the strip container (not the pill) so capture survives when
    // the pill unmounts after ownership transfer during a live tear-off. If
    // we captured on the pill itself, unmounting would release capture and
    // the new window would stop following the cursor mid-drag.
    const captureEl = (pillBarRef.current ?? (e.target as HTMLElement)) as HTMLElement;
    try { captureEl.setPointerCapture(e.pointerId); } catch { /* container not capturable */ }
    pointerCaptureEl.current = captureEl;
    pointerCaptureId.current = e.pointerId;
  }, [sessions, sessionStatuses]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    // Live tear-off continuation — runs even after we've cleared dragId so the
    // detached window keeps following the cursor. Must be checked BEFORE the
    // dragId null-guard below.
    if (liveDetachedWindowId.current !== null) {
      (window as any).claude?.detach?.dragWindowMove?.({
        windowId: liveDetachedWindowId.current,
        screenX: e.screenX,
        screenY: e.screenY,
        offsetX: grabOffsetInPill.current.x,
        offsetY: grabOffsetInPill.current.y,
      });
      return;
    }

    if (dragId === null || !dragOrigin.current) return;

    // Require 5px movement to start drag (prevents accidental drags on click)
    if (!isDragging.current) {
      const dx = e.clientX - dragOrigin.current.x;
      const dy = e.clientY - dragOrigin.current.y;
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      isDragging.current = true;
      suppressClick.current = true;
      // Tell main this is a real drag — it starts the cross-window cursor
      // ticker so peer windows can highlight their strip as a drop target.
      const draggedSession = sessions.find(x => x.id === dragId);
      if (!draggedSession) return;
      (window as any).claude?.detach?.dragStarted?.({ sessionId: draggedSession.id });
    }

    setDragPos({ x: e.clientX, y: e.clientY });

    // Chrome-style live tear-off. Once the pill has been dragged past the
    // header (cursor Y below the strip's bottom by >= 60px, or outside the
    // source window entirely), spawn the peer window NOW instead of waiting
    // for pointerup. Subsequent pointermove frames hit the early-return block
    // at the top of this callback and stream cursor positions to the new window.
    const bar = pillBarRef.current;
    // Don't allow tearing off the only session in a window — matches Chrome
    // (a single tab can't be torn out of its window) and avoids the broken
    // click-through state when the source window empties mid-drag.
    if (!liveDetachPending.current && bar && dragId !== null && sessions.length > 1) {
      const stripRect = bar.getBoundingClientRect();
      const outsideOwnWindow =
        e.clientY < 0 || e.clientY > window.innerHeight ||
        e.clientX < 0 || e.clientX > window.innerWidth;
      // 60px past the strip's bottom ≈ "this pill is clearly not in the strip
      // anymore" without being so eager that a fumbled drag tears a window.
      const belowStrip = e.clientY > stripRect.bottom + 60;
      if (belowStrip || outsideOwnWindow) {
        liveDetachPending.current = true;
        const draggedSession = sessions.find(x => x.id === dragId);
        if (!draggedSession) return;
        const det = (window as any).claude?.detach;
        if (det?.detachLive) {
          det.detachLive({
            sessionId: draggedSession.id,
            screenX: e.screenX,
            screenY: e.screenY,
            offsetX: grabOffsetInPill.current.x,
            offsetY: grabOffsetInPill.current.y,
          }).then((res: { windowId: number }) => {
            liveDetachedWindowId.current = res?.windowId ?? null;
            // Clear the source window's drag UI immediately. The pill has moved
            // to the detached window; the floating ghost shouldn't linger.
            // Pointer capture stays on pillBarRef so the source keeps getting
            // pointermove (via Electron's mouse passthrough on the new window)
            // and fires pointerup when the user releases.
            setDragId(null);
            setOverId(null);
            setDragPos(null);
            setGhostTarget(null);
          }).catch(() => {
            liveDetachPending.current = false;
          });
        }
        return;
      }
    }

    // Hit-test by horizontal distance only, against the geometry frozen at
    // pointer-down. Y is ignored on purpose: the pickup range is the full
    // height of the window, so a slightly-low drag still reorders.
    if (!bar) return;
    setOverId(nearestPillId(pillRectsRef.current, e.clientX, dragId));
  }, [dragId]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const wasDragging = isDragging.current;
    const releasedDragId = dragId;
    const releasedOverId = overId;
    const releasedSession = releasedDragId !== null
      ? sessions.find(x => x.id === releasedDragId) ?? null
      : null;
    const wasLiveDetached = liveDetachedWindowId.current !== null;

    // Reset all local drag state immediately so the UI snaps back cleanly.
    // We do the cross-window resolution async below using the captured values.
    setDragId(null);
    setOverId(null);
    setDragPos(null);
    setGhostTarget(null);
    dragOrigin.current = null;
    isDragging.current = false;
    liveDetachedWindowId.current = null;
    liveDetachPending.current = false;
    setTimeout(() => { suppressClick.current = false; }, 0);

    // Always notify main that the drag ended — even when live-detach already
    // cleared dragId (so releasedSession is null). Main relies on this to
    // turn off mouse-passthrough on the detached window and focus it. Skipping
    // it leaves the new window click-through forever.
    const det = (window as any).claude?.detach;
    if (wasDragging) det?.dragEnded?.();

    // Chrome-style live tear-off already spawned the new window and handed off
    // ownership mid-drag — nothing to resolve on release.
    if (wasLiveDetached) return;

    // Pointer capture is set on the strip container (not the pill button) so
    // that capture survives live tear-off ownership transfer. Side-effect: the
    // browser won't synthesize a click event on the button after pointerup
    // (click requires the same physical target for both down and up). Handle
    // session selection here for the no-drag case instead of relying on onClick.
    if (!wasDragging) {
      if (releasedSession) {
        suppressClick.current = true; // guard against onClick double-fire
        onSelectSession(releasedSession.id);
      }
      return;
    }

    if (!releasedSession) return;

    // Resolve drop across all peer windows: main hit-tests [data-session-strip]
    // in each window against the current cursor. If a hit, re-dock there;
    // if no hit and the cursor is outside our own viewport, detach to a
    // new peer window; otherwise fall through to the local reorder path.
    const clientX = e.clientX;
    const clientY = e.clientY;
    const outsideOwnWindow =
      clientX < 0 || clientY < 0 ||
      clientX > window.innerWidth || clientY > window.innerHeight;

    const resolveAndRoute = async () => {
      let resolved: { targetWindowId: number | null } = { targetWindowId: null };
      try { resolved = await det?.dropResolve?.(); } catch { /* fall through */ }

      const myId = (window as any).__youcodedWindowId;
      const target = resolved?.targetWindowId;

      if (target != null && target !== myId) {
        // Dropped on a peer window's strip → re-dock
        det?.dragDropped?.({ sessionId: releasedSession.id, targetWindowId: target, insertIndex: 0 });
        return;
      }
      // Dropped outside any window's strip → spawn new peer window. Skip if
      // this would empty the source window (matches the live-tear-off rule:
      // can't tear off a window's only session).
      if (outsideOwnWindow && sessions.length > 1) {
        const screenX = (e as any).screenX ?? (window.screenX + clientX);
        const screenY = (e as any).screenY ?? (window.screenY + clientY);
        det?.detachStart?.({ sessionId: releasedSession.id, screenX, screenY });
        return;
      }
      // Local drop → reorder within this window's strip (existing behavior)
      // Both ends resolved against the FULL session list — see drag-order.ts.
      if (releasedOverId !== null && onReorderSessions && releasedDragId !== null) {
        const move = reorderIndices(sessions.map(x => x.id), releasedDragId, releasedOverId);
        if (move) onReorderSessions(move.from, move.to);
      }
      onSelectSession(releasedSession.id);
    };

    // If detach IPC isn't available (remote-shim / Android), fall back to
    // the legacy local-only behavior.
    if (!det?.dropResolve) {
      // Both ends resolved against the FULL session list — see drag-order.ts.
      if (releasedOverId !== null && onReorderSessions && releasedDragId !== null) {
        const move = reorderIndices(sessions.map(x => x.id), releasedDragId, releasedOverId);
        if (move) onReorderSessions(move.from, move.to);
      }
      onSelectSession(releasedSession.id);
      return;
    }

    resolveAndRoute();
  }, [dragId, overId, onReorderSessions, sessions, onSelectSession]);

  const handleClick = useCallback((id: string) => {
    if (suppressClick.current) return;
    onSelectSession(id);
  }, [onSelectSession]);

  // --- Space-aware packing ---
  // We measure each pill's expanded width offscreen using a hidden canvas
  // (no layout thrash). Collapsed width is constant (dot + padding ≈ 24 px).
  const [pack, setPack] = useState<PackResult>({
    expanded: new Set(),
    collapsed: sessions.map(s => s.id),
    overflow: [],
  });

  // Fix (active pill snapped open): packSessions always marks the active pill
  // expanded, and the label's `transition: 'none'` — which exists to stop pills
  // sliding on every repack — therefore silenced exactly the pill the user just
  // clicked. Open a short window on a change of active session id, during which
  // that `none` is overridden. Nothing else opens it, so repack churn stays as
  // still as it is today.
  const expandArmed = useOneShotWindow(activeSessionId);

  // Everything below reads the FROZEN pack. `pack` is the live one; only the
  // measuring effect writes it. See header/use-frozen-pack.ts.
  const displayPack = useFrozenPack(pack, dragId !== null);

  // Mirror of `displayPack` for event handlers — they must read the CURRENT
  // pack at event time, not the one captured when the callback was created. A
  // ref, so handleEnter does not need it in its dependency list and stays
  // stable across repacks.
  const packRef = useRef(displayPack);
  useEffect(() => { packRef.current = displayPack; }, [displayPack]);

  // Mirror of dragId for the same reason.
  const dragIdRef = useRef<string | null>(null);
  useEffect(() => { dragIdRef.current = dragId; }, [dragId]);

  // Persistent measuring canvas — exists once per component, reused.
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (measureCanvasRef.current === null && typeof document !== 'undefined') {
    measureCanvasRef.current = document.createElement('canvas');
  }

  const measureExpandedWidth = useCallback((name: string): number => {
    const canvas = measureCanvasRef.current;
    if (!canvas) return 120; // fallback
    const ctx = canvas.getContext('2d');
    if (!ctx) return 120;
    // Match the pill's label styling: text-xs = 12px, medium weight.
    ctx.font = '500 12px system-ui, -apple-system, sans-serif';
    const textWidth = ctx.measureText(name).width;
    // Pill chrome: 6px left pad + dot (10) + 4px gap + text + 6px right pad + 2px border.
    return Math.ceil(textWidth + 28);
  }, []);

  const repack = useCallback(() => {
    const bar = pillBarRef.current;
    if (!bar) return;
    // Fix: read the flex-1 wrapper's allocated width, not the strip's own
    // content width. Without this, the budget equals whatever 1 pill happens
    // to occupy — a chicken-and-egg that prevents a 2nd pill from ever
    // appearing (2nd session would need space that wasn't measured yet).
    const budget = bar.parentElement?.clientWidth ?? bar.clientWidth;
    const measurements: SessionMeasurement[] = sessions.map(s => ({
      id: s.id,
      expandedWidth: measureExpandedWidth(s.name),
      collapsedWidth: 24, // dot (10) + horizontal padding (12) + border (2)
    }));
    const result = packSessions({
      sessions: measurements,
      activeId: activeSessionId,
      budget,
      gap: PILL_GAP,
      triggerWidth: 24, // ▾ button is w-5 + ml-1
    });
    setPack(result);
  }, [sessions, activeSessionId, measureExpandedWidth]);

  // Pack on mount, on session-list change, and on any container resize.
  useLayoutEffect(() => { repack(); }, [repack]);
  useEffect(() => {
    const bar = pillBarRef.current;
    if (!bar) return;
    // Observe the wrapper (parentElement), not the strip itself. The strip is
    // content-sized and never grows on its own, so observing it would never
    // fire when more space becomes available.
    const target = bar.parentElement ?? bar;
    const ro = new ResizeObserver(() => repack());
    ro.observe(target);
    return () => ro.disconnect();
  }, [repack]);

  // Android always forces single-session mode (no room for siblings on mobile chrome).
  const forceSingle = isAndroid();
  const visibleSessions = forceSingle
    ? sessions.filter(s => s.id === activeSessionId)
    : sessions.filter(s => displayPack.expanded.has(s.id) || displayPack.collapsed.includes(s.id));

  if (sessions.length === 0) return null;

  const dragging = dragId !== null && isDragging.current && dragPos !== null;

  return (
    <>
      <div
        ref={pillBarRef}
        data-session-strip
        // Pointer capture is set on this container during drag (see handlePointerDown).
        // React's event delegation still fires the pill's onPointerMove/onPointerUp
        // because events bubble up through the captured element, but we also listen
        // here as a safety net in case the pill unmounts mid-drag (live tear-off).
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        className={`session-strip flex items-center gap-0.5 bg-inset rounded-full px-1.5 py-0.5 overflow-hidden min-w-0 shrink transition-shadow ${incomingDropActive ? 'ring-2 ring-accent/70' : ''}`}
      >
        {/* ── Session pills ──────────────────────────────── */}
        {visibleSessions.map((s, idx) => {
          const color = sessionStatuses?.get(s.id) || 'gray';
          const isActive = s.id === activeSessionId;
          const isHovered = hoveredId === s.id;
          const showName = forceSingle
            ? isActive
            : displayPack.expanded.has(s.id) || isHovered || isActive;
          const isBeingDragged = dragId === s.id && isDragging.current;

          return (
            <React.Fragment key={s.id}>
              <button
                data-session-idx={idx}
                data-session-id={s.id}
                onPointerDown={(e) => handlePointerDown(e, s.id)}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onClick={() => handleClick(s.id)}
                // Fix: these used to be `undefined` for pack-expanded pills.
                // A pill the packer collapsed to a dot while the cursor was
                // already on it therefore never received a mouseenter and sat
                // as a dot until the user moved away and back. Always attach;
                // decide inside, where pack state is read at event time.
                onMouseEnter={() => handleEnter(s.id)}
                onMouseLeave={handleLeave}
                className={`
                  relative flex items-center gap-1 rounded-full px-1.5 py-px
                  border select-none touch-none overflow-hidden
                  ${isActive ? 'min-w-0 shrink' : 'shrink-0'}
                  ${showName && (isActive || !displayPack.expanded.has(s.id))
                    ? 'border-edge bg-panel'
                    : 'border-transparent'
                  }
                  ${isBeingDragged ? 'opacity-30 scale-95' : ''}
                `}
                style={{
                  // Explicit property list, not `all`: `all` animates every
                  // animatable property that changes, including layout ones, and
                  // each animating property is presented at the panel's full
                  // refresh rate. Only these change on hover/active. Same springy
                  // curve, so visually identical. box-shadow is in the list
                  // because the active pill's glow is set right below from
                  // GLOW_SHADOW — without it the glow would snap on.
                  transition: isBeingDragged
                    ? 'opacity 150ms, transform 150ms'
                    // `opacity` is in the list because `opacity-30` (dragging)
                    // is dropped by the SAME render that switches back to this
                    // branch on release — without it the pill would snap from
                    // 30% to full instead of fading, which `transition: all`
                    // used to cover.
                    : 'transform var(--dur-hover) var(--ease-bounce), border-color var(--dur-hover) var(--ease-bounce), background-color var(--dur-hover) var(--ease-bounce), box-shadow var(--dur-hover) var(--ease-bounce), opacity var(--dur-hover) var(--ease-bounce)',
                  transform: (!isBeingDragged && isHovered && !isActive) ? 'scale(1.02)' : undefined,
                  boxShadow: (!forceSingle && isActive) ? GLOW_SHADOW[color] : undefined,
                  cursor: 'default',
                }}
                title={s.name}
              >
                <SessionDot color={color} isActive={isActive} />
                <span
                  className={`text-xs font-medium text-fg-2 whitespace-nowrap overflow-hidden text-ellipsis ${isActive ? 'min-w-0' : ''}`}
                  style={pillLabelStyle({
                    showName,
                    isActive,
                    packExpanded: displayPack.expanded.has(s.id),
                    // Only the pill that just became active is allowed through
                    // the repack-churn kill-switch.
                    animateExpand: expandArmed && isActive,
                  })}
                >
                  {s.name}
                </span>
                {/* Native-runtime badge — marks a YouCoded harness session and
                    which preset it runs as. Only when the name is showing so it
                    never clutters a collapsed dot-only pill. */}
                {s.provider === 'native' && showName && (
                  <span
                    className="shrink-0 text-4xs px-1 py-0.5 rounded bg-inset text-fg-muted whitespace-nowrap"
                    title="YouCoded native session"
                  >
                    {`YouCoded · ${s.harnessId === 'coder' ? 'Coder' : 'Assistant'}`}
                  </span>
                )}
                {/* Active indicator bar — removed (dot is sufficient) */}
              </button>
            </React.Fragment>
          );
        })}

        {/* Overflow count: sessions open in this window that the strip couldn't fit.
            Purely an indicator — clicking the trigger (or this badge) opens the full list. */}
        {sessions.length - visibleSessions.length > 0 && (
          <button
            onClick={handleMenuToggle}
            className="inline-flex items-center justify-center min-w-[18px] h-[16px] px-1 ml-1 rounded-full bg-inset text-fg-2 text-3xs font-semibold leading-none hover:bg-well transition-colors"
            title={`${sessions.length - visibleSessions.length} more session${sessions.length - visibleSessions.length === 1 ? '' : 's'}`}
            aria-label={`${sessions.length - visibleSessions.length} more sessions`}
          >
            +{sessions.length - visibleSessions.length}
          </button>
        )}

        {/* ── Dropdown trigger ───────────────────────────── */}
        <div ref={menuRef}>
          <button
            ref={triggerBtnRef}
            onClick={handleMenuToggle}
            className="flex items-center justify-center w-5 h-5 ml-1 rounded-sm hover:bg-inset transition-colors text-fg-muted hover:text-fg-2"
            title="All Sessions"
          >
            <svg className={`w-3 h-3 transition-transform ${menuOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* ── Dropdown menu (portal — escapes overflow-hidden + backdrop-filter) ── */}
      {menuOpen && createPortal(
        <div
          ref={dropdownRef}
          // P-8 (2026-08-28): w-72 (288px) was too narrow for a session name and
          // its project side by side. 28rem with an 88vw ceiling keeps it inside
          // a phone-width window.
          className="glass-overlay overlay-no-drag fixed w-[min(28rem,88vw)] bg-panel border border-edge rounded-lg shadow-lg z-[9000] overflow-hidden"
          style={(() => {
            const triggerRect = triggerBtnRef.current?.getBoundingClientRect();
            const pillRect = pillBarRef.current?.getBoundingClientRect();
            const pillCenter = pillRect
              ? pillRect.left + pillRect.width / 2
              : undefined;
            // Half the rendered width, which is min(448px, 88vw) — the clamp below
            // keeps the menu on screen, so it has to track the real width.
            const halfDropdown = Math.min(448, window.innerWidth * 0.88) / 2;
            // Compute left-edge directly (no transform: translateX(-50%))
            // so backdrop-filter isn't broken by a persistent transform
            return {
              top: triggerRect ? triggerRect.bottom + 4 : 0,
              left: pillCenter != null
                ? Math.min(Math.max(0, pillCenter - halfDropdown), window.innerWidth - halfDropdown * 2)
                : `calc(50% - ${halfDropdown}px)`,
              animation: 'dropdown-in 120ms var(--ease-out) both',
            };
          })()}
        >
          {/* Android only ever has one window, so the "in this window" scoping label is meaningless there */}
          {sessions.length > 0 && !isAndroid() && (
            <>
              <div className="px-3 pt-1.5 text-3xs font-medium text-fg-muted tracking-wider uppercase">
                Sessions in this window
              </div>
            </>
          )}
          {/* P-8 (2026-08-28): 336px held six and a half of the old wrapped rows;
              432px holds eight of the new one-line rows plus a sliced ninth, which
              is the list's only "there is more below" cue. */}
          {sessions.length > 0 && (
            <div ref={sessionListRef} className="scroll-fade" style={{ maxHeight: 'min(432px, 55vh)' }}>
              <div className="py-1">
              {sessions.map((s, idx) => {
                const color = sessionStatuses?.get(s.id) || 'gray';
                const isBeingDragged = dragId === s.id && isDragging.current;
                return (
                  <div
                    key={s.id}
                    data-session-idx={idx}
                    data-session-id={s.id}
                    ref={shiftNavIdx === idx ? (el) => el?.scrollIntoView({ block: 'nearest' }) : undefined}
                    onPointerDown={(e) => handlePointerDown(e, s.id)}
                    onPointerMove={handlePointerMove}
                    onPointerUp={handlePointerUp}
                    className={`relative flex items-center pr-1 group/row select-none touch-none ${
                      shiftNavIdx === idx
                        ? 'bg-accent/20 text-fg'
                        : s.id === activeSessionId
                          ? 'bg-inset text-fg'
                          : 'text-fg-dim hover:bg-inset hover:text-fg'
                    } ${isBeingDragged ? 'opacity-30' : ''}`}
                    style={{
                      animation: `row-fade-in 100ms ease both`,
                      animationDelay: `${idx * 20}ms`,
                      // steps(4) inline, not via the .stepped-hover utility: an
                      // inline transition cannot be overridden by a stylesheet
                      // rule without !important. Users scan this list top-to-
                      // bottom to pick a session, so every row's fade fires in
                      // one sweep, inside a .glass-overlay backdrop-filter.
                      transition: 'opacity 150ms steps(4), background 150ms steps(4)',
                      cursor: 'default',
                    }}
                  >
                    {/* Drag grip — visible on hover */}
                    <span className={`shrink-0 flex items-center pl-1.5 transition-opacity ${isAndroid() ? 'hidden' : 'opacity-0 group-hover/row:opacity-100'}`}>
                      <DragGrip />
                    </span>
                    <button
                      onClick={() => { if (!suppressClick.current) { onSelectSession(s.id); setMenuOpen(false); } }}
                      className="flex-1 text-left pl-1 pr-1.5 py-1.5 flex items-center min-w-0"
                    >
                      {/* P-8 (2026-08-28): name and project start at the SAME left
                          edge, one under the other; what used to be a bare dot at
                          the left is now the named status pill at the right of the
                          name, with the session's tag marks under it. */}
                      <span className="flex-1 min-w-0 flex flex-col gap-0.5">
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="flex-1 min-w-0"><SessionName name={s.name} /></span>
                          {s.permissionMode === 'bypass' && (
                            <span className="shrink-0 text-4xs font-medium px-1 py-0.5 rounded-sm bg-[#DD4444]/20 text-[#DD4444]">
                              DANGER
                            </span>
                          )}
                          <StatusPill color={color} isActive={s.id === activeSessionId} />
                        </span>
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="flex-1 min-w-0 flex items-center gap-1 text-3xs text-fg-muted">
                            <FolderMark className="w-3 h-3 shrink-0 text-fg-faint" />
                            <span className="truncate">{s.cwd.replace(/\\/g, '/').split('/').pop()}</span>
                          </span>
                          <SessionTagMarks sessionId={s.id} byId={tagsById} />
                        </span>
                      </span>
                    </button>
                    <button
                      // Close the dropdown so the CloseSessionPrompt (L2 popup)
                      // isn't competing with the still-open session menu above it.
                      onClick={(e) => { e.stopPropagation(); if (!suppressClick.current) { setMenuOpen(false); onCloseSession(s.id); } }}
                      onPointerDown={(e) => e.stopPropagation()}
                      className="shrink-0 w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-[#DD4444] hover:bg-inset opacity-0 group-hover/row:opacity-100 transition-opacity"
                      title="Close Session"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </button>
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {/* Sessions in other windows — only shown when the detach subsystem
              reports peer windows owning sessions. Selecting one tells main
              to focus that window and switch its active session. */}
          {(() => {
            // Defensive: a partial windowDirectory payload (missing `sessions`
            // on a peer window entry) must not crash SessionStrip — it lives
            // in the main App tree above the Game ErrorBoundary, so a throw
            // falls through to RootErrorBoundary and wipes chat state.
            const remoteGroups = (windowDirectory?.windows ?? [])
              .filter((w) => w.window.id !== myWindowId)
              .map((w) => ({
                label: w.window.label,
                windowId: w.window.id,
                sessions: w.sessions ?? [],
              }))
              .filter((g) => g.sessions.length > 0);
            if (remoteGroups.length === 0) return null;
            return (
              <>
                <div className="border-t border-edge" />
                <div className="px-3 pt-1.5 text-3xs font-medium text-fg-muted tracking-wider uppercase">
                  Sessions in other windows
                </div>
                <div className="py-1">
                  {remoteGroups.flatMap((g) =>
                    g.sessions.map((s) => {
                      const color = sessionStatuses?.get(s.id) || 'gray';
                      return (
                        <button
                          key={s.id}
                          onClick={() => {
                            (window as any).claude?.detach?.focusAndSwitch?.({ windowId: g.windowId, sessionId: s.id });
                            setMenuOpen(false);
                          }}
                          className="w-full text-left pl-3 pr-2 py-2 flex items-center gap-2 text-fg-dim hover:bg-inset hover:text-fg transition-colors"
                        >
                          <SessionDot color={color} isActive={false} />
                          <span className="flex-1 min-w-0"><SessionName name={s.name} /></span>
                          <span className="ml-auto shrink-0 text-3xs text-fg-muted whitespace-nowrap flex items-center gap-1">
                            <span>→</span>
                            <span>{g.label}</span>
                          </span>
                        </button>
                      );
                    }),
                  )}
                </div>
              </>
            );
          })()}

          <div className="border-t border-edge" />

          {showNewForm ? (
            <div className="p-3 flex flex-col gap-2 rounded-b-lg overflow-hidden">
              <div>
                <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Project Folder</label>
                <FolderSwitcher
                  value={newCwd}
                  onChange={setNewCwd}
                  // "Manage projects…" bridges to Project View (same action as
                  // the header button) and closes the session menu behind it.
                  onManageProjects={() => { setMenuOpen(false); artifactDispatch({ type: 'PROJECT_VIEW_OPENED' }); }}
                />
              </div>
              {/* ONE model list. Replaces the Runtime toggle + the provider and
                  model <Select> pair + this form's Claude alias row. The runtime
                  is DERIVED from the pick (see applyModelChoice), so the user
                  answers "which model?" instead of decoding "Runtime" first. */}
              <div>
                <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Model</label>
                <ModelPicker
                  value={modelChoice}
                  onSelect={applyModelChoice}
                  onManageModels={() => {
                    setMenuOpen(false);
                    window.dispatchEvent(new CustomEvent('youcoded:open-model-providers'));
                  }}
                />
              </div>
              {/* Native-only extras that are NOT model selection. They appear
                  because a native model was picked, not because a runtime was
                  declared. */}
              {runtime === 'native' && nb.nativeSupported && (
                <NativeExtras nb={nb} preset={preset} onPreset={setPreset} />
              )}
              {/* Skip Permissions is CLAUDE-CODE ONLY. It works by starting the
                  CLI with permissions bypassed, and a native session has no PTY
                  and no CC permission flow for it to affect — so on a native
                  model the control did nothing at all. The Resume Browser
                  already gated it per row; this is the create-time half.
                  Gated on the DERIVED runtime, so it appears and disappears as
                  the model choice changes. */}
              {runtime !== 'native' && (
                <>
                  <div className="flex items-center justify-between">
                    <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase inline-flex items-center">
                      Skip Permissions
                      <SkipPermissionsInfoTooltip />
                    </label>
                    {/* Shared Toggle (change 15). The "danger" tone replaces the raw
                        #DD4444 hex, so community themes can restyle it. aria-label
                        added — the neighbouring <label> was never wired to the
                        control, so it announced as an unnamed button. */}
                    <Toggle
                      checked={dangerous}
                      onChange={setDangerous}
                      tone="danger"
                      aria-label="Skip Permissions"
                    />
                  </div>
                  {/* Warning text was a raw text-[#DD4444] hex. Change 17 moves it onto
                      the same token as the toggle beside it, so a community theme
                      restyling its red doesn't leave the two out of sync. */}
                  {dangerous && (
                    <p className="text-3xs text-destructive-fg">Claude will execute tools without asking for approval.</p>
                  )}
                </>
              )}
              {/* Launch in new window — hidden on platforms without multi-window support */}
              {detachAvailable && (
                <div className="flex items-center justify-between">
                  <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase">Launch in New Window</label>
                  {/* Shared Toggle (change 15) — same accent on-state as before. */}
                  <Toggle
                    checked={launchInNewWindow}
                    onChange={setLaunchInNewWindow}
                    aria-label="Launch in New Window"
                  />
                </div>
              )}
              {/* Skip-permissions sessions get the FILLED danger variant (spec §11,
                  change 62 — Destin's call). Known and accepted consequence: this now
                  looks identical to "Remove project". Filled red in this app means
                  "stop and read this", not strictly "this destroys something"; the
                  outline variant is the confirm-y tier. Don't downgrade this to
                  danger-outline for consistency — that was considered and rejected.
                  Was raw bg-[#DD4444]/[#E55555] + text-white; the token pair carries
                  an engine-derived label color so a pale community red can't go
                  white-on-pink. The non-dangerous branch also gains a real hover
                  (it was hover:bg-accent over bg-accent — inert; change 75). */}
              <Button
                variant={dangerous && runtime !== 'native' ? 'danger' : 'primary'}
                size="lg"
                onClick={handleCreate}
                disabled={nb.nativeCreateBlocked}
                className="w-full py-1.5"
              >
                {dangerous && runtime !== 'native' ? 'Create (Dangerous)' : 'Create Session'}
              </Button>
            </div>
          ) : (
            <div className="flex rounded-b-lg overflow-hidden">
              <button
                onClick={() => { setMenuOpen(false); onOpenResumeBrowser(); }}
                className="flex-1 px-3 py-2 text-sm text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>Resume</span>
              </button>
              {/* Gradient divider */}
              <div className="w-px my-0.5" style={{ background: 'linear-gradient(to bottom, transparent, var(--fg-faint), transparent)' }} />
              <button
                onClick={() => {
                  setNewCwd(defaultProjectFolder || '');
                  setDangerous(defaultSkipPermissions || false);
                  setNewModel(defaultModel || 'sonnet');
                  // usePreset re-arms the heuristic itself on the showNewForm
                  // false→true edge — no manual touched reset needed here.
                  setShowNewForm(true);
                }}
                className="flex-1 px-3 py-2 text-sm text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                <span className="text-base leading-none">+</span>
                <span>New Session</span>
              </button>
            </div>
          )}
        </div>,
        document.getElementById('root')! // Portal to #root (not body) so
        // backdrop-filter can sample the compositing tree for live content blur
      )}

      {/* ── Insertion indicator — shows where the pill will land ── */}
      {dragging && ghostTarget && (
        <div
          className="fixed z-[9998] pointer-events-none"
          style={{
            left: ghostTarget.x,
            top: ghostTarget.y,
            transform: 'translate(-50%, -50%)',
            transition: 'left 120ms var(--ease-bounce), top 120ms ease',
          }}
        >
          <div className="w-0.5 h-4 rounded-full bg-accent" style={{ opacity: 0.8 }} />
        </div>
      )}

      {/* ── Floating drag ghost — follows cursor freely ──── */}
      {dragging && dragPos && (
        <div
          className="fixed z-[9999] pointer-events-none flex items-center gap-1.5 rounded-full px-2.5 py-1 bg-inset border border-edge shadow-lg shadow-black/40"
          style={{
            left: dragPos.x,
            top: dragPos.y,
            transform: 'translate(-50%, -50%) scale(1.05)',
          }}
        >
          <SessionDot color={dragColor} isActive />
          <span className="text-xs font-medium text-fg whitespace-nowrap max-w-[180px] truncate">
            {dragLabel}
          </span>
        </div>
      )}
    </>
  );
}
