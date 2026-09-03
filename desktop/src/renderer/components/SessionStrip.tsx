import React, { useState, useRef, useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
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
import { pillMetrics, NAME_FONT, type PillMetrics } from './header/pill-metrics';
import { sessionRuntimeLabel } from './header/session-runtime-label';
import { ProviderIcon } from './ProviderIcon';
import { nextSlotId, clampFloatLeft, layoutRects, reorderIndices, neighbourOffsets, mapToSettled, DRAG_TUNE, type PillRect } from './header/drag-order';
import { useOneShotWindow } from '../hooks/use-one-shot-window';
import { useScrollFade } from '../hooks/useScrollFade';
import { useArtifact } from '../state/ArtifactContext';
import { isTypingTarget } from '../utils/is-typing-target';
import { useTagRegistry } from '../hooks/useTagRegistry';
import { useSessionMeta } from '../hooks/useSessionMeta';
import { PRIORITY_TAG } from './tags/built-in-tags';
import { NotePageGlyph } from './tags/glyphs';
import { TagChip } from './tags/TagChip';
import type { TagRecord } from '../../shared/tags';

// Stable empty map for the non-dragging render, so a new Map is not allocated
// on every frame the strip re-renders.
const EMPTY_OFFSETS: ReadonlyMap<string, number> = new Map();

/** How long the pill-label transitions stay switched on after a session
 *  switch, if the stylesheet cannot be read: the name reveal, with slack. The
 *  live value is read off the strip's computed `--dur-reveal` (see
 *  motionWindowMs) — a fixed number tuned to one vocabulary closed
 *  mid-animation once another was picked, and the label popped to full size.
 *  Destin called the result "jank". */
const EXPAND_WINDOW_FALLBACK_MS = 340;
const EXPAND_WINDOW_SLACK_MS = 80;

/** The reveal time the current vocabulary needs, read off an element that
 *  inherits the tokens. `ms` or `s`; anything unreadable → the fallback. */
function motionWindowMs(el: Element | null): number {
  if (!el) return EXPAND_WINDOW_FALLBACK_MS;
  const cs = getComputedStyle(el);
  const read = (name: string) => {
    const v = cs.getPropertyValue(name).trim();
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return NaN;
    return v.endsWith('ms') ? n : v.endsWith('s') ? n * 1000 : n;
  };
  const reveal = read('--dur-reveal');
  return Number.isFinite(reveal) && reveal > 0 ? Math.round(reveal + EXPAND_WINDOW_SLACK_MS) : EXPAND_WINDOW_FALLBACK_MS;
}

/** A collapsed pill (dot only): px-1.5 (12) + dot (10) + border (2) + the
 *  gap-1 (4) that sits between the dot and its zero-width label. Measured
 *  2026-09-01 at 28px; the packer had budgeted 24 since it was written, so a
 *  row of N dots was under-reserved by 4N px and the active name got squeezed. */
const COLLAPSED_PILL_PX = 28;

/** How close (px) a dot may be drawn to the pill in hand before it is hidden.
 *  More than DRAG_TUNE.margin (6), so a dot is gone before it is asked to
 *  step aside, with a frame's travel of a brisk drag to spare. */
const VEIL_PX = 10;


interface SessionEntry {
  id: string;
  name: string;
  cwd: string;
  permissionMode: string;
  // Which runtime backend this session runs — 'claude' (default) or 'native'.
  // With harnessId and model, drives the "Claude Code · Sonnet" /
  // "YouCoded Coder · DeepSeek R1" line under the name in the All Sessions
  // menu (session-runtime-label.ts). Nothing on the pill itself.
  provider?: string;
  // Resolved native preset id ('assistant' | 'coder', post legacy-mapping).
  // Absent for Claude sessions.
  harnessId?: string;
  // Model id the session runs on — a Claude alias or a native model id.
  model?: string;
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
  // How far the pill in hand has travelled from where it was picked up, in CSS
  // px, clamped to the strip. Null when nothing is in hand. Only X: the pill
  // rides the strip line; downward motion is tear-off (below), never a Y offset.
  const [dragLeft, setDragLeft] = useState<number | null>(null);
  // Where inside the pill the cursor landed, as a FRACTION of its width. A
  // fraction, not px: on a select-on-press the pill grows from a 24px dot to
  // its full name while in hand, and a px offset would leave the cursor at its
  // far left edge; a fraction keeps it under the same part of the pill.
  const grabFrac = useRef(0.5);
  // The cursor's last x, for the rAF loop that re-anchors a shrinking twin.
  const cursorXRef = useRef(0);
  // The pack the row is settling INTO for this drag, computed at pointer-down
  // (with the pressed session as active when the mode selects on press). Read
  // in place of the live pack for the whole drag so a resize cannot repack
  // under the cursor, and so the synthetic geometry and the rendered row agree.
  const frozenPackRef = useRef<PackResult | null>(null);
  // The bar's left edge at pointer-down. The synthetic geometry is laid out
  // from where the row's first pill sat at press — but after a select-on-press
  // the header re-centres the strip as the row reshapes (measured 2026-09-02:
  // ~40px over 260ms), so the bar, and every pill in it, slides. Positions
  // RELATIVE to the bar stay right; the drag reads the geometry shifted by
  // however far the bar has moved since press.
  const barLeftAtPress = useRef(0);
  // Mirror of overId for the move handler: the next slot depends on the
  // current one (the yield line is crossed early forward and late back), and
  // the handler must read it at event time, not the value it closed over.
  const overIdRef = useRef<string | null>(null);
  // Which way the pill is travelling, with a dead-band (DRAG_TUNE.deadband):
  // `extreme` is the furthest the cursor has gone in the current direction, and
  // the direction flips only once the cursor has come back that far from it.
  const travel = useRef<{ dir: -1 | 0 | 1; extreme: number }>({ dir: 0, extreme: 0 });
  // The settle glide after a drop (see the layout effect below). `settleRef`
  // is armed in the same batch as the reorder; `settle` is the two-phase FLIP
  // state that drives the pill's transform on the renders after it.
  // Keyed by session id: where EVERY pill was drawn at the instant of the drop
  // (the held pill via its twin), so that every pill — not only the held one —
  // glides from where it was to where the reorder puts it. The neighbours step
  // aside by a computed width during the drag; the real width differs by a few
  // px, and without them in the settle they all hop that much at the drop.
  const settleRef = useRef<{ heldId: string; lefts: Map<string, number> } | null>(null);
  const [settle, setSettle] = useState<{ heldId: string; deltas: Map<string, number>; phase: 'hold' | 'glide' } | null>(null);
  // True for the one render in which the DOM order changes after a drop.
  // Neighbours' transforms drop to zero in that same render, and their DOM
  // position moves by exactly the amount the transform was — so their
  // transition must be OFF for it, or they would visibly jump and then glide
  // back to where they already were.
  const [reorderQuiet, setReorderQuiet] = useState(false);
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

  // Persistent measuring canvas — exists once per component, reused.
  const measureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  if (measureCanvasRef.current === null && typeof document !== 'undefined') {
    measureCanvasRef.current = document.createElement('canvas');
  }

  // One measurement per session, shared by the packer (how much room a pill
  // needs) and the label (how wide its box opens to). The arithmetic lives in
  // header/pill-metrics.ts so the two cannot drift apart.
  //
  // The font is read off the REAL rendered label, not assumed: the UI font is
  // a monospace, and a system-font canvas measured it ~15% narrow. Read after
  // every commit (one getComputedStyle), stored only when it changes, so a theme
  // that swaps the font re-measures and everything else costs a string compare.
  const [font, setFont] = useState<string>(NAME_FONT);
  useLayoutEffect(() => {
    const nameEl = pillBarRef.current?.querySelector('.session-pill__name');
    if (!nameEl) return;
    const name = getComputedStyle(nameEl).font;
    if (name && name !== font) setFont(name);
  });
  const metrics = useMemo(() => {
    const out = new Map<string, PillMetrics>();
    const ctx = measureCanvasRef.current?.getContext('2d') ?? null;
    const measure = (text: string, font: string) => {
      if (!ctx) return text.length * 7; // no canvas (tests): a rough monospace guess
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    for (const s of sessions) {
      out.set(s.id, pillMetrics(s.name, measure, font));
    }
    return out;
  }, [sessions, font]);

  // What the packer is handed — shared by the repack below and by a press,
  // which packs the row it is about to become (see handlePointerDown).
  const measurementsOf = useCallback((): SessionMeasurement[] => sessions.map(s => ({
    id: s.id,
    expandedWidth: metrics.get(s.id)?.expandedWidth ?? 120,
    collapsedWidth: COLLAPSED_PILL_PX,
  })), [sessions, metrics]);

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
    // Widths freeze for the duration of a drag — and that includes the pill in
    // hand. A fast drag leaves the pill's own box (mouseleave fires), and
    // letting its peek collapse mid-drag would shrink the thing under the
    // cursor by the width its neighbours had already stepped aside for. That
    // was the ~150px void Destin photographed on 2026-09-01: the geometry was
    // frozen at peek width, the pill was not. Hover is released at drop.
    if (dragIdRef.current !== null) return;
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

  const handlePointerDown = useCallback((e: React.PointerEvent, sessionId: string, inStrip = false) => {
    // Only primary button
    if (e.button !== 0) return;
    dragOrigin.current = { x: e.clientX, y: e.clientY };
    isDragging.current = false;
    travel.current = { dir: 0, extreme: e.clientX };

    const s = sessions.find(x => x.id === sessionId);
    if (!s) return;
    // Capture label + color eagerly so pointermove can start immediately
    setDragId(s.id);
    // Hover is deliberately NOT cleared here. Clearing it collapsed the peek
    // you had open to a dot on mouse-down, and the click then re-expanded the
    // same pill as the active one: open → shut → open, on every click of a dot
    // ("clicking is weird and jumpy", Destin 2026-09-01). The peek simply stays
    // open and becomes the active label.

    const barEl = pillBarRef.current;
    // Chrome selects a tab the instant you press it, and so does the strip
    // (Destin picked "switch on press" over press-with-name-on-drop and
    // switch-on-release, 2026-09-02). That reshapes the row — the old name
    // collapses, the pressed one opens — while a drag may be starting on it,
    // which is why the geometry below is SYNTHETIC: the row the drag is judged
    // against is the one it is settling into, not the one mid-animation under
    // the cursor. Menu rows never select on press.
    const selectsNow = inStrip && sessionId !== activeSessionId;
    const activeForDrag = selectsNow ? sessionId : activeSessionId;

    if (barEl) {
      const barRect = barEl.getBoundingClientRect();
      barLeftAtPress.current = barRect.left;
      const budget = barEl.parentElement?.clientWidth ?? barEl.clientWidth;
      const target = packSessions({
        sessions: measurementsOf(), activeId: activeForDrag, budget, gap: PILL_GAP, triggerWidth: 24,
      });
      frozenPackRef.current = target;
      const visible = sessions.filter(x => target.expanded.has(x.id) || target.collapsed.includes(x.id));
      // A pill's settled width: its full measured width if the packer expands
      // it (capped at the budget, where the active pill ellipsises instead),
      // else a dot. The pill in hand keeps its open name — Destin, 2026-09-02:
      // "i want to keep the fully expanded name" — so in the row's eyes it is
      // its full width, and a neighbour steps that far to make room.
      const widthOf = (id: string) => {
        if (!target.expanded.has(id)) return COLLAPSED_PILL_PX;
        return Math.min(metrics.get(id)?.expandedWidth ?? 120, Math.max(COLLAPSED_PILL_PX, budget - 24 - PILL_GAP));
      };
      // The row starts where the first pill starts today (the bar's padding).
      const first = barEl.querySelector<HTMLElement>('[data-session-id]');
      const originLeft = first ? first.getBoundingClientRect().left : barRect.left + 6;
      pillRectsRef.current = layoutRects(visible.map(x => ({ id: x.id, width: widthOf(x.id) })), originLeft, PILL_GAP);
    }
    if (selectsNow) onSelectSession(sessionId);

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
  }, [sessions, sessionStatuses, activeSessionId, onSelectSession, metrics, measurementsOf]);

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
      // The grab point is taken NOW, not at the press: between the two the
      // row has slid under the stationary cursor (the old name collapsing,
      // the strip re-centring), and a fraction measured at the press would
      // draw the twin up to ~150px from the box it stands in for. Measured
      // against the box as it is, the twin appears exactly on it; and as the
      // box shrinks to a dot the twin shrinks around the cursor.
      const bar0 = pillBarRef.current;
      const held0 = bar0?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(dragId)}"]`);
      if (held0) {
        const r = held0.getBoundingClientRect();
        grabFrac.current = r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0.5;
      }
      // (no snapshot needed: the row is read as drawn on every move, below)
      // Tell main this is a real drag — it starts the cross-window cursor
      // ticker so peer windows can highlight their strip as a drop target.
      const draggedSession = sessions.find(x => x.id === dragId);
      if (!draggedSession) return;
      (window as any).claude?.detach?.dragStarted?.({ sessionId: draggedSession.id });
    }

    // The pill in hand floats over the row, tracking the cursor 1:1 — no
    // transition, no slot snapping — clamped so it cannot leave the row of
    // pills. Its settled width comes from the synthetic geometry.
    // The geometry, shifted by however far the bar has slid since press (see
    // barLeftAtPress) — so the yield lines are where the dots ARE, not where
    // they were before the header re-centred the strip.
    cursorXRef.current = e.clientX;
    const barLeftNow = pillBarRef.current ? pillBarRef.current.getBoundingClientRect().left : barLeftAtPress.current;
    const shift = barLeftNow - barLeftAtPress.current;
    const settled = shift === 0
      ? pillRectsRef.current
      : pillRectsRef.current.map(r => ({ id: r.id, left: r.left + shift, right: r.right + shift }));
    const rects = settled;
    const held = rects.find(r => r.id === dragId);
    // The settled width of the pill in hand — a dot. The twin is still
    // shrinking towards that for the first --dur-reveal of a drag, so it is
    // placed by its CURRENT width (the cursor stays at the same fraction of
    // it) while the slot is judged by the dot it is becoming.
    const heldWidth = held ? held.right - held.left : 0;
    const heldEl = pillBarRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(dragId)}"]`);
    const widthNow = heldEl ? heldEl.getBoundingClientRect().width || heldWidth : heldWidth;
    const floatLeft = held
      ? clampFloatLeft(rects, e.clientX - grabFrac.current * widthNow, widthNow)
      : null;
    // Bar-local against the bar's left edge NOW, for the same reason.
    if (floatLeft !== null) setDragLeft(floatLeft - barLeftNow);

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
            overIdRef.current = null;
            setDragLeft(null);
          }).catch(() => {
            liveDetachPending.current = false;
          });
        }
        return;
      }
    }

    // Which slot is the pill heading for? The one its CENTRE is nearest to,
    // computed from the geometry frozen at pointer-down (drag-order.ts). Y is
    // ignored on purpose: the pickup range is the full height of the window,
    // so a slightly-low drag still reorders.
    if (!bar) return;
    // A drag from the All Sessions menu has no float (it is not in the row);
    // nextSlotId then falls back to the pill nearest the cursor.
    // The dot's centre — then mapped from the row AS DRAWN to the row as it
    // will settle (mapToSettled): for the first --dur-reveal of a drag the
    // row is still sliding under the cursor from the select-on-press, and a
    // dot must yield when the pill visibly reaches it, not when it would have
    // in the settled layout. Each pill's drawn left has its in-flight
    // transform (a yield, the hop's delayed jump) taken back out.
    const centreDrawn = floatLeft !== null ? e.clientX - grabFrac.current * heldWidth + heldWidth / 2 : e.clientX;
    const drawn: PillRect[] = [];
    bar.querySelectorAll<HTMLElement>('[data-session-id]').forEach((el) => {
      const id = el.dataset.sessionId;
      if (!id) return;
      const r = el.getBoundingClientRect();
      const m = /matrix\(([^)]+)\)/.exec(getComputedStyle(el).transform);
      const tx = m ? Number(m[1].split(',')[4]) || 0 : 0;
      drawn.push({ id, left: r.left - tx, right: r.right - tx });
    });
    const centre = floatLeft !== null ? mapToSettled(drawn, rects, centreDrawn) : centreDrawn;
    const tv = travel.current;
    if (tv.dir >= 0 && e.clientX > tv.extreme) { tv.dir = 1; tv.extreme = e.clientX; }
    else if (tv.dir <= 0 && e.clientX < tv.extreme) { tv.dir = -1; tv.extreme = e.clientX; }
    else if (tv.dir > 0 && e.clientX < tv.extreme - DRAG_TUNE.deadband) { tv.dir = -1; tv.extreme = e.clientX; }
    else if (tv.dir < 0 && e.clientX > tv.extreme + DRAG_TUNE.deadband) { tv.dir = 1; tv.extreme = e.clientX; }
    const next = nextSlotId(rects, dragId, overIdRef.current, centre, tv.dir);
    if (next !== overIdRef.current) { overIdRef.current = next; setOverId(next); }
  }, [dragId]);

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    const wasDragging = isDragging.current;
    const releasedDragId = dragId;
    const releasedOverId = overId;
    const releasedSession = releasedDragId !== null
      ? sessions.find(x => x.id === releasedDragId) ?? null
      : null;
    const wasLiveDetached = liveDetachedWindowId.current !== null;
    // Where the pill in hand is DRAWN at this instant — the settle glide after
    // the drop starts from here, not from the pill's origin.
    // Read off the DOM, not reconstructed: the twin is where the user sees the
    // pill, and the neighbours' rects INCLUDE their step-aside transforms.
    const snapshot = new Map<string, number>();
    if (wasDragging && pillBarRef.current) {
      for (const el of Array.from(pillBarRef.current.querySelectorAll<HTMLElement>('[data-session-id]'))) {
        snapshot.set(el.dataset.sessionId!, el.getBoundingClientRect().left);
      }
      const twin = pillBarRef.current.querySelector<HTMLElement>(':scope > div[aria-hidden]');
      if (twin && releasedDragId !== null) snapshot.set(releasedDragId, twin.getBoundingClientRect().left);
    }

    dragOrigin.current = null;
    isDragging.current = false;
    liveDetachedWindowId.current = null;
    liveDetachPending.current = false;
    setTimeout(() => { suppressClick.current = false; }, 0);

    // The drag VISUALS are not cleared here. They hold, frozen, until the drop
    // is resolved — the release below is batched into the same render as the
    // reorder, so the pill never springs back to its origin and then jumps to
    // its new slot (what the first version did while it waited on the
    // cross-window drop resolution).
    const releaseVisuals = () => {
      setDragId(null);
      setOverId(null);
      overIdRef.current = null;
      setDragLeft(null);
    };

    // Always notify main that the drag ended — even when live-detach already
    // cleared dragId (so releasedSession is null). Main relies on this to
    // turn off mouse-passthrough on the detached window and focus it. Skipping
    // it leaves the new window click-through forever.
    const det = (window as any).claude?.detach;
    if (wasDragging) det?.dragEnded?.();

    // Chrome-style live tear-off already spawned the new window and handed off
    // ownership mid-drag — nothing to resolve on release.
    if (wasLiveDetached) { releaseVisuals(); return; }

    // Pointer capture is set on the strip container (not the pill button) so
    // that capture survives live tear-off ownership transfer. Side-effect: the
    // browser won't synthesize a click event on the button after pointerup
    // (click requires the same physical target for both down and up). Handle
    // session selection here for the no-drag case instead of relying on onClick.
    if (!wasDragging) {
      releaseVisuals();
      if (releasedSession) {
        suppressClick.current = true; // guard against onClick double-fire
        onSelectSession(releasedSession.id);
      }
      return;
    }

    if (!releasedSession) { releaseVisuals(); return; }

    // A local drop: the reorder, the release of the drag visuals and the
    // arming of the settle glide all land in ONE render (React batches every
    // update in a tick, inside a promise callback too). So the DOM order
    // changes in the same commit the transforms drop — the neighbours are
    // already exactly where they were drawn, and only the pill in hand has
    // anywhere left to go.
    const commitLocal = () => {
      // Both ends resolved against the FULL session list — see drag-order.ts.
      if (releasedOverId !== null && onReorderSessions && releasedDragId !== null) {
        const move = reorderIndices(sessions.map(x => x.id), releasedDragId, releasedOverId);
        if (move) onReorderSessions(move.from, move.to);
      }
      if (snapshot.size > 0) settleRef.current = { heldId: releasedSession.id, lefts: snapshot };
      setReorderQuiet(true);
      // The drop selects the pill, so its name stays open as the active label;
      // the peek state that kept it open through the drag is done.
      setHoveredId(null);
      releaseVisuals();
      onSelectSession(releasedSession.id);
    };

    // If detach IPC isn't available (remote-shim / Android), fall back to
    // the legacy local-only behavior.
    if (!det?.dropResolve) { commitLocal(); return; }

    // Resolve drop across all peer windows: main hit-tests [data-session-strip]
    // in each window against the current cursor. If a hit, re-dock there;
    // if no hit and the cursor is outside our own viewport, detach to a
    // new peer window; otherwise fall through to the local reorder path.
    const clientX = e.clientX;
    const clientY = e.clientY;
    const outsideOwnWindow =
      clientX < 0 || clientY < 0 ||
      clientX > window.innerWidth || clientY > window.innerHeight;
    const screenX = (e as any).screenX ?? (window.screenX + clientX);
    const screenY = (e as any).screenY ?? (window.screenY + clientY);

    const resolveAndRoute = async () => {
      let resolved: { targetWindowId: number | null } = { targetWindowId: null };
      try { resolved = await det?.dropResolve?.(); } catch { /* fall through */ }

      const myId = (window as any).__youcodedWindowId;
      const target = resolved?.targetWindowId;

      if (target != null && target !== myId) {
        // Dropped on a peer window's strip → re-dock. The pill leaves this
        // window; nothing here to settle.
        releaseVisuals();
        det?.dragDropped?.({ sessionId: releasedSession.id, targetWindowId: target, insertIndex: 0 });
        return;
      }
      // Dropped outside any window's strip → spawn new peer window. Skip if
      // this would empty the source window (matches the live-tear-off rule:
      // can't tear off a window's only session).
      if (outsideOwnWindow && sessions.length > 1) {
        releaseVisuals();
        det?.detachStart?.({ sessionId: releasedSession.id, screenX, screenY });
        return;
      }
      commitLocal();
    };

    resolveAndRoute();
  }, [dragId, overId, onReorderSessions, sessions, onSelectSession]);

  const handleClick = useCallback((id: string) => {
    if (suppressClick.current) return;
    onSelectSession(id);
  }, [onSelectSession]);

  const pillElement = (id: string) =>
    pillBarRef.current?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`) ?? null;

  // The settle glide after a drop — a FLIP in two renders, all before paint.
  //
  // Render A (the drop's own render): the DOM order has changed and every
  // transform has dropped, so the released pill is drawn IN its new slot. Not
  // painted yet. This effect measures where that slot is, and the difference
  // from where the pill was released is `delta`.
  // Render B ('hold'): the pill is put back at its release position with
  // `translateX(delta)` and NO transition, and the forced layout read below
  // makes the browser compute that style.
  // Render C ('glide'): the transform goes to zero on the settle curve — the
  // browser sees delta → 0 with a transition and animates it. Chrome's
  // release: the tab is already where it is going; it just has a little way
  // left to travel.
  useLayoutEffect(() => {
    const armed = settleRef.current;
    if (armed !== null) {
      settleRef.current = null;
      const deltas = new Map<string, number>();
      for (const [id, wasLeft] of armed.lefts) {
        const el = pillElement(id);
        if (!el) continue;
        const delta = wasLeft - el.getBoundingClientRect().left;
        if (Math.abs(delta) >= 0.5) deltas.set(id, delta);
      }
      // The reads above also forced layout of render A, so the neighbours'
      // "no transition" render has been computed and can now be restored.
      setReorderQuiet(false);
      if (deltas.size > 0) setSettle({ heldId: armed.heldId, deltas, phase: 'hold' });
      return;
    }
    if (settle?.phase === 'hold') {
      const el = pillElement(settle.heldId);
      if (el) void el.getBoundingClientRect();
      setSettle({ ...settle, phase: 'glide' });
    }
  });
  // The twin is a fresh element, so its label opens to full width the instant
  // it mounts — while the in-flow box it stands in for is still mid-reveal
  // after a select-on-press, and the dots beyond it have not been pushed yet.
  // Measured 2026-09-01: the twin's leading edge sat 14px over the next dot
  // for the first ~40ms of every drag started right after a press. So while a
  // pill is in hand the twin's WIDTH follows the in-flow box's width, frame by
  // frame, written straight to the DOM (no React churn for a 200ms settle).
  useEffect(() => {
    if (dragLeft === null || dragId === null) return;
    const bar = pillBarRef.current;
    if (!bar) return;
    let raf = 0;
    const tick = () => {
      const real = pillElement(dragId);
      const twin = bar.querySelector<HTMLElement>(':scope > div[aria-hidden]');
      if (real && twin) {
        const w = real.getBoundingClientRect().width;
        twin.style.width = `${w}px`;
        // And its LEFT: the cursor stays at the same fraction of a twin that
        // is still opening after a press, so both edges move with it rather
        // than the leading edge sweeping across the dots ahead.
        twin.style.left = `${cursorXRef.current - grabFrac.current * w - bar.getBoundingClientRect().left}px`;
        // The veil (see veiledRef): a dot within VEIL_PX of the twin, where
        // it is DRAWN this frame, is hidden; one that has come clear is shown
        // again (its inline opacity transition fades it in). Written straight
        // to the DOM — one class toggle per dot per frame at most.
        const t = twin.getBoundingClientRect();
        bar.querySelectorAll<HTMLElement>('[data-session-id]').forEach((el) => {
          const id = el.dataset.sessionId;
          if (!id || id === dragId || !dotIdsRef.current.has(id)) return;
          const r = el.getBoundingClientRect();
          const near = r.right > t.left - VEIL_PX && r.left < t.right + VEIL_PX;
          const veiled = veiledRef.current.has(id);
          if (near && !veiled) { veiledRef.current.add(id); el.classList.add('session-pill--veiled'); }
          else if (!near && veiled) { veiledRef.current.delete(id); el.classList.remove('session-pill--veiled'); }
        });
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      // The drag is over: everything is drawn again.
      veiledRef.current.clear();
      bar.querySelectorAll('.session-pill--veiled').forEach((el) => el.classList.remove('session-pill--veiled'));
    };
  }, [dragLeft !== null, dragId]);

  // Belt and braces: transitionend does not fire for an element that was
  // re-rendered out of its transition, so the glide state also times out.
  useEffect(() => {
    if (settle?.phase !== 'glide') return;
    const t = setTimeout(() => setSettle(null), 400);
    return () => clearTimeout(t);
  }, [settle]);

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
  // The window is as long as the vocabulary needs (the name reveal), read off
  // the stylesheet — see motionWindowMs. Also armed when a drag starts and
  // ends, so a label that opens or closes at pickup or drop is inside the
  // repack-churn kill-switch's exception.
  const [windowMs, setWindowMs] = useState(EXPAND_WINDOW_FALLBACK_MS);
  useLayoutEffect(() => {
    const ms = motionWindowMs(pillBarRef.current);
    if (ms !== windowMs) setWindowMs(ms);
  });
  const expandArmed = useOneShotWindow(`${activeSessionId}:${dragLeft !== null}`, windowMs);

  // Everything below reads the pack the drag was packed against (frozen at
  // pointer-down) while a pill is held; `pack` is the live one otherwise.
  const displayPack = dragId !== null && frozenPackRef.current !== null ? frozenPackRef.current : pack;

  // Mirror of `displayPack` for event handlers — they must read the CURRENT
  // pack at event time, not the one captured when the callback was created. A
  // ref, so handleEnter does not need it in its dependency list and stays
  // stable across repacks.
  const packRef = useRef(displayPack);
  useEffect(() => { packRef.current = displayPack; }, [displayPack]);

  // Mirror of dragId for the same reason.
  const dragIdRef = useRef<string | null>(null);
  useEffect(() => { dragIdRef.current = dragId; }, [dragId]);


  const repack = useCallback(() => {
    const bar = pillBarRef.current;
    if (!bar) return;
    // Fix: read the flex-1 wrapper's allocated width, not the strip's own
    // content width. Without this, the budget equals whatever 1 pill happens
    // to occupy — a chicken-and-egg that prevents a 2nd pill from ever
    // appearing (2nd session would need space that wasn't measured yet).
    const budget = bar.parentElement?.clientWidth ?? bar.clientWidth;
    const result = packSessions({
      sessions: measurementsOf(),
      activeId: activeSessionId,
      budget,
      gap: PILL_GAP,
      triggerWidth: 24, // ▾ button is w-5 + ml-1
    });
    setPack(result);
  }, [activeSessionId, measurementsOf]);

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

  const dragging = dragId !== null && isDragging.current && dragLeft !== null;

  // Chrome's model: the pill in hand is the thing that moves — under the
  // cursor, clamped to the strip — and every pill between its origin and its
  // target steps aside by one pill-width so the gap it will land in is already
  // open. On release there is nothing to jump to: it glides the last few px
  // home.
  //
  // HOW the pill in hand is drawn (2026-09-01): its in-flow box stays in the row
  // but invisible, still holding its slot and still animating its own width
  // (so the row reshapes naturally on a select-on-press), and a TWIN of it —
  // the same markup, same styles — floats absolutely inside the bar at the
  // cursor. The twin has no data attributes: everything that walks the row by
  // `[data-session-id]` (tear-off placement in main.ts, the perf lab, the
  // settle below) must find exactly one node per session.
  const dragOffsets = dragging && dragId
    ? neighbourOffsets(pillRectsRef.current, dragId, overId)
    : EMPTY_OFFSETS;

  // NO DOT IS EVER DRAWN TOUCHING THE PILL IN HAND (2026-09-02). Destin, after
  // a slide and then a blink had both been tried: "the problem is that the
  // dragged session kept visibly overlapping dots before they appeared to
  // begin to move. it would be fine if they teleport or fade in/fade out as
  // long as they dont visually touch the dragged pill." So the rule is
  // geometric, not timed: a dot within VEIL_PX of the twin is not drawn at
  // all (`.session-pill--veiled`, instant), it moves — a plain jump — while
  // it cannot be seen, and it fades back in only once it is clear of the pill
  // again. Two writers keep the set in step: the rAF loop below (proximity,
  // read off the DOM every frame, and the only thing that ever UNVEILS) and
  // this render (a dot whose step-aside offset changes is veiled in the same
  // commit that moves it, so a fast pointer can never land the jump in view).
  // Only dots: a wide neighbour still slides, on the fast-deceleration curve;
  // blanking a 190px name would leave a hole. Cleared when the drag ends.
  const veiledRef = useRef<Set<string>>(new Set());
  const prevOffsetsRef = useRef<ReadonlyMap<string, number>>(EMPTY_OFFSETS);
  if (dragging) {
    for (const s of sessions) {
      const off = dragOffsets.get(s.id) ?? 0;
      if (off !== (prevOffsetsRef.current.get(s.id) ?? 0) && !displayPack.expanded.has(s.id)) veiledRef.current.add(s.id);
    }
  } else if (veiledRef.current.size > 0) {
    veiledRef.current.clear();
  }
  prevOffsetsRef.current = dragOffsets;
  // Which pills are dots in the pack the drag is judged against — for the rAF loop.
  const dotIdsRef = useRef<Set<string>>(new Set());
  dotIdsRef.current = new Set(displayPack.collapsed);

  // After the hooks above: an early return before them would change the hook
  // order between renders.
  if (sessions.length === 0) return null;

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
        className={`session-strip relative flex items-center gap-0.5 bg-inset rounded-full px-1.5 py-0.5 overflow-hidden min-w-0 shrink transition-shadow ${incomingDropActive ? 'ring-2 ring-accent/70' : ''}`}
      >
        {/* ── Session pills ──────────────────────────────── */}
        {visibleSessions.map((s, idx) => {
          const color = sessionStatuses?.get(s.id) || 'gray';
          const isActive = s.id === activeSessionId;
          const isHovered = hoveredId === s.id;
          const isBeingDragged = dragId === s.id && isDragging.current;
          const showName = forceSingle
            ? isActive
            : displayPack.expanded.has(s.id) || isHovered || isActive;
          // A HOVER PEEK: the name is showing only because the cursor is on it.
          // The packer reserved no room for this pill, so the name is capped
          // (pill-label-style.ts).
          const hoverPeek = !isActive && !displayPack.expanded.has(s.id);
          const isDot = !displayPack.expanded.has(s.id);

          const pillClass = `
                  relative flex items-center gap-1 rounded-full px-1.5 py-px
                  border select-none touch-none overflow-hidden
                  ${showName && (isActive || !displayPack.expanded.has(s.id))
                    ? 'border-edge bg-panel'
                    : 'border-transparent'
                  }`;
          const pillBody = (
            <>
                <SessionDot color={color} isActive={isActive} />
                <span
                  className={`session-pill__label text-xs font-medium text-fg-2 ${isActive ? 'min-w-0' : ''}`}
                  style={pillLabelStyle({
                    showName,
                    isActive,
                    packExpanded: displayPack.expanded.has(s.id),
                    // The repack-churn kill-switch is lifted for every pill
                    // during the switch window: the new active pill opens and
                    // the old one closes in the same motion.
                    animateExpand: expandArmed,
                    nameWidth: metrics.get(s.id)?.nameWidth ?? 0,
                  })}
                >
                  {/* Laid out once at full width; the box above clips and fades
                      it. See .session-pill__name in globals.css. */}
                  <span className="session-pill__name">{s.name}</span>
                </span>
            </>
          );

          return (
            <React.Fragment key={s.id}>
              <button
                data-session-idx={idx}
                data-session-id={s.id}
                onPointerDown={(e) => handlePointerDown(e, s.id, true)}
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
                className={`${pillClass} ${isActive ? 'min-w-0 shrink' : 'shrink-0'} ${isBeingDragged ? 'cursor-grabbing' : ''}${veiledRef.current.has(s.id) ? ' session-pill--veiled' : ''}`}
                style={{
                  // Explicit property list, not `all`: `all` animates every
                  // animatable property that changes, including layout ones, and
                  // each animating property is presented at the panel's full
                  // refresh rate. Only these change on hover/active/drag.
                  // box-shadow is in the list because the active pill's glow is
                  // set right below from GLOW_SHADOW — without it the glow would
                  // snap on.
                  // The in-flow box of the pill in hand keeps its slot but is
                  // not drawn — its twin below is. Its label still animates
                  // (so the row reshapes on a select-on-press), hence the
                  // ordinary transition list, not 'none'.
                  visibility: isBeingDragged ? 'hidden' : undefined,
                  transition: (reorderQuiet || settle?.deltas.has(s.id) && settle.phase === 'hold')
                      // The render in which the DOM order changes, and the
                      // 'hold' render of the settle: nothing may animate, see
                      // the layout effect above.
                      ? 'none'
                      // `transform` gets the settle curve when a drop is gliding
                      // home. During a drag a DOT stepping aside does not animate
                      // at all — it jumps while veiled (see veiledRef) — and a
                      // wide neighbour slides on the fast-deceleration curve; a
                      // hover scales on the same curve. Never an overshoot: a
                      // release must not spring.
                      : `transform ${settle?.deltas.has(s.id) ? 'var(--dur-hover) var(--ease-settle)' : dragging && isDot ? '0s' : 'var(--dur-hover) var(--ease-out)'}, border-color var(--dur-hover) var(--ease-reveal), background-color var(--dur-hover) var(--ease-reveal), box-shadow var(--dur-hover) var(--ease-reveal), opacity var(--dur-hover) var(--ease-reveal)`,
                  // Four mutually exclusive transform states: the pill in hand
                  // (under the cursor), a dropped pill gliding home, a neighbour
                  // stepping aside, or a plain hover.
                  transform: isBeingDragged
                    ? undefined
                    : settle?.deltas.has(s.id)
                      ? `translateX(${settle.phase === 'hold' ? settle.deltas.get(s.id) : 0}px)`
                      : dragOffsets.has(s.id)
                        ? `translateX(${dragOffsets.get(s.id)}px)`
                        : (isHovered && !isActive) ? 'scale(1.02)' : undefined,
                  // The 3px focus outline (globals.css) reads as a bright ring
                  // around the thing you are dragging. Suppressed in hand.
                  zIndex: settle?.heldId === s.id ? 10 : undefined,
                  // The dropped pill keeps the twin's lift while it glides home,
                  // then the shadow eases into the active glow — no pop at the
                  // handoff from twin to real pill.
                  boxShadow: settle?.heldId === s.id
                    ? '0 8px 20px rgba(0,0,0,0.35)'
                    : (!forceSingle && isActive) ? GLOW_SHADOW[color] : undefined,
                  cursor: 'default',
                }}
                onTransitionEnd={settle?.heldId === s.id ? () => setSettle(null) : undefined}
                title={s.name}
              >
                {pillBody}
              </button>
              {isBeingDragged && dragLeft !== null && (
                // The twin: the pill in hand, drawn at the cursor. NO transition
                // on its position — a 150ms ease there made the pill trail the
                // pointer like it was on a rubber band. pointer-events off so
                // the pointerup lands on the bar that holds capture.
                <div
                  aria-hidden
                  className={`${pillClass} shrink-0 cursor-grabbing`}
                  style={{
                    // Width is driven from the in-flow box by the rAF sync
                    // above; the first frame gets the box's width from React.
                    width: pillElement(s.id)?.getBoundingClientRect().width,
                    position: 'absolute',
                    left: dragLeft,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    zIndex: 10,
                    pointerEvents: 'none',
                    boxShadow: '0 8px 20px rgba(0,0,0,0.35)',
                    transition: 'box-shadow var(--dur-hover) var(--ease-reveal)',
                  }}
                >
                  {pillBody}
                </div>
              )}
            </React.Fragment>
          );
        })}
        {/* END of the per-pill map — everything below is the strip's tail. */}
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
                          {/* What runs this session, and on what — "Claude Code ·
                              Sonnet", "YouCoded Coder · DeepSeek R1" — with the
                              brand mark the status bar's model chip uses. This
                              replaced the pill's "YouCoded · Coder" badge on
                              2026-09-02 (Destin: it "still cause[d] a bit of
                              visual jank"); the row is read at rest and has the
                              room. The mark carries the brand colour; the text
                              stays muted like the folder beside it, so the row's
                              second line reads as one line of metadata. Capped
                              so a long local model name never pushes the folder
                              out. */}
                          {(() => {
                            const rt = sessionRuntimeLabel(s);
                            return (
                              <span
                                className="shrink-0 min-w-0 max-w-[55%] flex items-center gap-1 text-3xs text-fg-muted"
                                title={rt.text}
                              >
                                {rt.icon && (
                                  <span className="shrink-0 flex items-center" style={{ color: rt.color }}>
                                    <ProviderIcon icon={rt.icon} size={10} />
                                  </span>
                                )}
                                <span className="truncate">{rt.text}</span>
                              </span>
                            );
                          })()}
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

    </>
  );
}
