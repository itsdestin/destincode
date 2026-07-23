import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { ThemeProvider } from '../../state/theme-context';
import { ChatProvider } from '../../state/chat-context';
import { useAnyAttentionNeeded } from '../../hooks/useAnyAttentionNeeded';
import { BuddyChat } from './BuddyChat';
import { BuddyMascot, type OverlayDrive } from './BuddyMascot';
import { BuddyBarButtons } from './BuddyBarApp';
import { MASCOT_SIZE, CHAT_SIZE, BAR_SIZE, type Point } from '../../../shared/buddy-geometry';
import { FREE_DOCK, type DockEdge } from '../../../shared/buddy-dock';
import {
  overlayReducer, overlayLayout, type OverlayState, type OverlayInitLike,
} from './overlay-state';

// Placeholder state before the first onOverlayInit push lands — never
// rendered (see `if (!initialized) return null` below), just something
// valid for useReducer to start from. workArea 0×0 keeps clampToWorkArea
// harmless if anything fires before init (e.g. a stray disengage dispatch).
const PLACEHOLDER_STATE: OverlayState = {
  workArea: { x: 0, y: 0, width: 0, height: 0 },
  mascot: { x: 0, y: 0 },
  dock: FREE_DOCK,
  chatVisible: false,
  barVisible: false,
};

// How long the chat/bar wrappers stay mounted after chatVisible flips false,
// so their CSS exit animations (buddy-chat-exit / the bar's opacity
// transition, both buddy.css) get to finish before the DOM node is torn
// down. Mirrors main delaying the three-window model's chat-window hide()
// by the same 140ms after cueing the close (buddy-window-manager.ts:390).
const GROUP_HIDE_DELAY_MS = 140;

// Persist debounce — mirrors the three-window model's own buddyPositions
// save coalescing so a drag or a burst of dock changes doesn't spam disk
// writes.
const PERSIST_DEBOUNCE_MS = 300;

// Hover→interactivity trailing debounce on the FALSE edge only (brief step
// 2): crossing the small gap between the mascot and the bar fires
// leave→enter within a couple ms, and without this the overlay window would
// flicker click-through on and off between them — any click landing exactly
// in that gap would fall through to the desktop instead of registering.
const HOVER_FALSE_DEBOUNCE_MS = 60;

/**
 * Linux-Wayland buddy host (Task 6): mounts the mascot, chat, and action bar
 * as plain DOM inside ONE transparent, screen-sized, click-through-by-default
 * BrowserWindow, instead of the three separate BrowserWindows the rest of
 * the platforms use (BuddyMascotApp/BuddyChatApp/BuddyBarApp) — Wayland gives
 * Electron no way to reposition a window, so all the drag/dock/peek logic
 * that used to live in main (BuddyWindowManager) moves into this component's
 * `overlayReducer` (Task 5) instead.
 */
export function BuddyOverlayApp() {
  const [state, dispatch] = useReducer(overlayReducer, PLACEHOLDER_STATE);
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-overlay');
  }, []);

  // Main → overlay push, sent once on did-finish-load (Task 3/4): window-local
  // workArea/mascot/dock so the reducer knows where to place him. The reducer
  // itself picks a default position when `mascot` is null (fresh install).
  useEffect(() => {
    const off = window.claude?.buddy?.onOverlayInit?.((init) => {
      dispatch({ type: 'init', init: init as OverlayInitLike });
      setInitialized(true);
    });
    return off;
  }, []);

  // External (tray/menu) chat toggle request — mascot-click toggles are
  // renderer-local (BuddyMascot's onTap below), this is the OTHER caller.
  useEffect(() => {
    const off = window.claude?.buddy?.onOverlayToggleChat?.(() => {
      dispatch({ type: 'toggle-chat' });
    });
    return off;
  }, []);

  // ── Engagement sync ──
  // WHY: mirrors BuddyWindowManager.syncEngagement (src/main/buddy-window-
  // manager.ts:102-117) — the three-window model dispatches engage whenever
  // the bar wants visibility (chat open) or something needs attention, and
  // disengage otherwise, on every change to either reason, so the two can't
  // fight each other (closing the chat while attention is pending must NOT
  // sink him). Without this replica, tapping a peeking mascot to open chat
  // would leave dock.mode: 'peeking' with the chat open — an invariant
  // violation the reducer itself doesn't enforce (Task 5 review ruling).
  const attention = useAnyAttentionNeeded();
  useEffect(() => {
    if (!initialized) return;
    dispatch({ type: state.chatVisible || attention ? 'engage' : 'disengage' });
  }, [state.chatVisible, attention, initialized]);

  // ── Persistence ──
  // overlayPersist({mascot, dock: dock.edge}) on drag-end and on dock change,
  // 300ms debounced (brief step 2) — mirrors the three-window save debounce.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const schedulePersist = useCallback((mascot: Point, dockEdge: DockEdge | null) => {
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      window.claude?.buddy?.overlayPersist?.({ mascot, dock: dockEdge });
    }, PERSIST_DEBOUNCE_MS);
  }, []);
  useEffect(() => () => { if (persistTimerRef.current) clearTimeout(persistTimerRef.current); }, []);

  // "On dock change": fires whenever mode/edge actually differ from the
  // previous render, INCLUDING transitions driven by engage/disengage above
  // (not just drag). Skips the very first post-init settle (prevDockKeyRef
  // starts null) so restoring a persisted dock doesn't immediately re-save
  // the identical value it was just loaded from.
  const prevDockKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized) return;
    const key = `${state.dock.mode}|${state.dock.edge}`;
    if (prevDockKeyRef.current !== null && prevDockKeyRef.current !== key) {
      schedulePersist(state.mascot, state.dock.edge);
    }
    prevDockKeyRef.current = key;
  }, [state.dock.mode, state.dock.edge, initialized, schedulePersist]);
  // (state.mascot / schedulePersist deliberately read via closure, not
  // listed as deps — this effect should only RE-RUN on a dock change, but
  // must persist whatever mascot position that dock change landed on.)

  // ── Hover → interactivity ──
  // Tracked per-wrapper (mascot/chat/bar) rather than a raw increment/
  // decrement counter — a counter can drift permanently positive if a
  // pointerleave never fires (browsers don't reliably dispatch one for a DOM
  // node removed out from under the cursor, which is exactly what happens to
  // the chat/bar wrappers ~140ms after the chat closes — see groupVisible
  // below). Flags self-heal on unmount instead (see the groupVisible effect
  // further down). Instant TRUE edge so the first click always lands, 60ms
  // trailing debounce on the FALSE edge only (HOVER_FALSE_DEBOUNCE_MS).
  // Force-held true for the duration of a drag regardless of hover, released
  // on drag-end.
  const hoveredRef = useRef({ mascot: false, chat: false, bar: false });
  const draggingRef = useRef(false);
  const hoverFalseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const applyInteractive = useCallback((interactive: boolean) => {
    window.claude?.buddy?.overlaySetInteractive?.(interactive);
  }, []);
  const wantsInteractive = useCallback(() => {
    const h = hoveredRef.current;
    return h.mascot || h.chat || h.bar || draggingRef.current;
  }, []);
  const reconcileInteractive = useCallback(() => {
    if (hoverFalseTimerRef.current) { clearTimeout(hoverFalseTimerRef.current); hoverFalseTimerRef.current = null; }
    if (wantsInteractive()) {
      applyInteractive(true);
    } else {
      hoverFalseTimerRef.current = setTimeout(() => {
        hoverFalseTimerRef.current = null;
        if (!wantsInteractive()) applyInteractive(false);
      }, HOVER_FALSE_DEBOUNCE_MS);
    }
  }, [applyInteractive, wantsInteractive]);
  const setHover = useCallback((key: 'mascot' | 'chat' | 'bar', hovering: boolean) => {
    hoveredRef.current[key] = hovering;
    reconcileInteractive();
  }, [reconcileInteractive]);
  // Cleanup: an unmount mid-hover (theme swap, HMR) must not leave the
  // overlay window permanently swallowing clicks.
  useEffect(() => () => {
    if (hoverFalseTimerRef.current) clearTimeout(hoverFalseTimerRef.current);
    applyInteractive(false);
  }, [applyInteractive]);

  // ── Drive callbacks for BuddyMascot ──
  const onDragMove = useCallback((to: { x: number; y: number }) => {
    if (!draggingRef.current) {
      // Force-hold interactivity true for the whole drag, independent of
      // hover count — the pointer stays captured on the mascot but a fast
      // drag can outrun the hover-enter/leave events of whatever it passes
      // over.
      draggingRef.current = true;
      reconcileInteractive();
    }
    dispatch({ type: 'drag-move', to });
  }, [reconcileInteractive]);
  const onDragEnd = useCallback(() => {
    draggingRef.current = false;
    // overlayReducer is pure (Task 5) — compute the post-drag-end state
    // synchronously here instead of reading `state` after dispatch (which
    // would still be the PRE-drag-end snapshot; dispatch is async), so the
    // persisted position/dock always match what the reducer actually landed
    // on (e.g. an edge-snap correction), not the raw un-snapped drag target.
    const next = overlayReducer(state, { type: 'drag-end' });
    dispatch({ type: 'drag-end' });
    schedulePersist(next.mascot, next.dock.edge);
    reconcileInteractive();
  }, [state, schedulePersist, reconcileInteractive]);
  const onTap = useCallback(() => {
    dispatch({ type: 'toggle-chat' });
  }, []);

  // Force-clear the mascot hover flag on any PROGRAMMATIC relocation — a
  // drag-end edge snap, or disengage's peek re-flush (see reducer's
  // reconcilePeekPosition-equivalent). Mirrors the groupVisible force-clear
  // for chat/bar above, for the same underlying reason: the mascot wrapper
  // is repositioned via inline left/top with no pointer movement involved,
  // and Chromium does not re-run hit-testing (fire pointerleave) just
  // because an element moved out from under a stationary cursor. Left
  // uncorrected, a drag that snaps to a dock edge could leave
  // hoveredRef.current.mascot stuck true forever, and the screen-sized
  // overlay would never go click-through again — swallowing every desktop
  // click (reviewer-flagged risk).
  //
  // Trigger: an effect on the committed state.mascot position, guarded on
  // !draggingRef.current — the simplest correct signal available, since
  // every relocation NOT under the user's live pointer control (edge snap,
  // disengage re-flush) shows up as exactly this: state.mascot changing
  // while draggingRef is false. It never fights an ACTIVE drag (draggingRef
  // force-hold still owns interactivity there; drag-move's own continuous
  // repositioning is cursor-controlled, so no clear is needed or wanted),
  // and it's a no-op init noise (dependency unchanged on renders that don't
  // move him).
  //
  // Chosen failure direction: force to non-interactive, never the reverse.
  // If the cursor genuinely still sits on the mascot at its new spot, the
  // very next real pointerenter restores interactivity — a one-hover
  // correction. The overlay must NEVER eat clicks by default (global
  // constraint), so "wrongly click-through for a moment" is the acceptable
  // error, not "wrongly swallowing clicks forever."
  const prevMascotRef = useRef<Point | null>(null);
  useEffect(() => {
    const prev = prevMascotRef.current;
    prevMascotRef.current = state.mascot;
    if (draggingRef.current) return;
    if (!prev) return; // first placement (post-init) — nothing was hoverable yet
    if (prev.x === state.mascot.x && prev.y === state.mascot.y) return;
    if (hoveredRef.current.mascot) {
      hoveredRef.current.mascot = false;
      reconcileInteractive();
    }
  }, [state.mascot.x, state.mascot.y, reconcileInteractive]);

  // ── Chat mount/fade lifecycle ──
  // Mirrors BuddyChatApp's onChatState effect, but sourced from the reducer's
  // chatVisible instead of an IPC push (there's no separate chat window to
  // push to here). groupVisible keeps the chat+bar wrappers mounted for
  // GROUP_HIDE_DELAY_MS past chatVisible→false so the exit CSS gets to play
  // (see the constant's comment) before the DOM nodes are removed.
  const [chatPhase, setChatPhase] = useState<'enter' | 'exit'>('enter');
  const [chatReplayKey, setChatReplayKey] = useState(0);
  const [groupVisible, setGroupVisible] = useState(false);
  const groupHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (groupHideTimerRef.current) { clearTimeout(groupHideTimerRef.current); groupHideTimerRef.current = null; }
    if (state.chatVisible) {
      setGroupVisible(true);
      setChatPhase('enter');
      setChatReplayKey((k) => k + 1);
    } else {
      setChatPhase('exit');
      groupHideTimerRef.current = setTimeout(() => setGroupVisible(false), GROUP_HIDE_DELAY_MS);
    }
    return () => { if (groupHideTimerRef.current) clearTimeout(groupHideTimerRef.current); };
  }, [state.chatVisible]);

  // Force-clear chat/bar hover flags the moment their wrappers actually
  // leave the DOM (see the hoveredRef comment above) — a pointerleave is not
  // guaranteed to fire for a node removed out from under the cursor, so the
  // flags could otherwise stay stuck true forever and the overlay would
  // never go click-through again over that area.
  useEffect(() => {
    if (groupVisible) return;
    if (hoveredRef.current.chat || hoveredRef.current.bar) {
      hoveredRef.current.chat = false;
      hoveredRef.current.bar = false;
      reconcileInteractive();
    }
  }, [groupVisible, reconcileInteractive]);

  if (!initialized) return null;

  const layout = overlayLayout(state);
  const overlayDrive: OverlayDrive = { dock: state.dock, onDragMove, onDragEnd, onTap };

  return (
    <ThemeProvider>
      <div
        style={{
          position: 'fixed', left: layout.mascot.x, top: layout.mascot.y,
          width: MASCOT_SIZE.width, height: MASCOT_SIZE.height,
        }}
        onPointerEnter={() => setHover('mascot', true)}
        onPointerLeave={() => setHover('mascot', false)}
      >
        <BuddyMascot overlayDrive={overlayDrive} />
      </div>

      {groupVisible && (
        <div
          style={{
            position: 'fixed', left: layout.chat.x, top: layout.chat.y,
            width: CHAT_SIZE.width, height: CHAT_SIZE.height,
          }}
          onPointerEnter={() => setHover('chat', true)}
          onPointerLeave={() => setHover('chat', false)}
        >
          {/* ChatProvider nesting + fade classes mirrored exactly from
              BuddyChatApp.tsx — see that file's own comment on why
              ChatProvider is needed (ToolCard's permission buttons call
              useChatDispatch). ThemeProvider is hoisted to this component's
              root instead of duplicated per-panel — all three surfaces share
              one React tree here, unlike the three separate windows. */}
          <ChatProvider>
            <div
              key={chatReplayKey}
              className={`buddy-chat-panel ${chatPhase === 'enter' ? 'buddy-chat-enter' : 'buddy-chat-exit'}`}
              style={{ width: '100%', height: '100%' }}
            >
              <BuddyChat />
            </div>
          </ChatProvider>
        </div>
      )}

      {groupVisible && (
        <div
          style={{
            position: 'fixed', left: layout.bar.x, top: layout.bar.y,
            width: BAR_SIZE.width, height: BAR_SIZE.height,
          }}
          onPointerEnter={() => setHover('bar', true)}
          onPointerLeave={() => setHover('bar', false)}
        >
          {/* data-visible tracks chatVisible directly (not groupVisible) so
              the buddy-bar-root opacity transition (buddy.css) actually
              plays during the same window groupVisible is keeping this
              mounted for. */}
          <div
            className="buddy-bar-root"
            data-visible={state.chatVisible ? '1' : '0'}
            style={{
              width: '100%', height: '100%', display: 'flex',
              alignItems: 'center', justifyContent: 'center', gap: 8,
              background: 'transparent',
            }}
          >
            <BuddyBarButtons />
          </div>
        </div>
      )}
    </ThemeProvider>
  );
}
