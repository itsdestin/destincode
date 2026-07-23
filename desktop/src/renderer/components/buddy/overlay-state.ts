// Pure overlay-window state: mascot drag, dock snap, chat/bar reveal, and
// group layout, all in one reducer so the buddy floater's behavior is
// vitest-testable without DOM. Ported from the three-window BuddyWindowManager
// (src/main/buddy-window-manager.ts) now that Task 3+ hosts everything as DOM
// inside one transparent overlay window instead of three BrowserWindows.
//
// RENDERER code: may import only from src/shared/, never src/main/ (which
// pulls in electron and can't load in the browser sandbox).
import {
  MASCOT_SIZE, computeGroupLayout, computeBarPosition, clampToWorkArea, mascotXRangeForChat,
  type Rect, type Point,
} from '../../../shared/buddy-geometry';
import {
  dockReducer, detectSnapEdge, dockPosition, FREE_DOCK,
  type DockState, type DockEdge,
} from '../../../shared/buddy-dock';

// How close (px) a raw drag target must get to a screen edge, WITH the chat
// open, to read as "put him away" — close the chat and peek. Deliberately
// much smaller than SNAP_THRESHOLD_PX: the chat-open x-pin below already
// parks the mascot ~17px off the left edge, so a 24px test would false-fire
// on ordinary positioning. Ported verbatim from
// BuddyWindowManager.moveMascot's PEEK_PAST_EDGE_PX (src/main/buddy-window-manager.ts).
const PEEK_PAST_EDGE_PX = 6;

export interface OverlayState {
  workArea: Rect;                          // window-local
  mascot: Point;                           // window-local mascot window-rect origin
  dock: DockState;                         // {mode:'free'|'docked'|'peeking', edge}
  chatVisible: boolean;
  barVisible: boolean;                     // invariant: barVisible → chatVisible
}

/**
 * Mirrors the `OverlayInit` payload built by
 * src/main/buddy-overlay-manager.ts's `buildOverlayInit`. Duplicated (not
 * imported) rather than shared, because that file lives under src/main/ and
 * this one — renderer code — can never import from there.
 */
export interface OverlayInitLike {
  workArea: Rect;
  mascot: Point | null;
  dock: DockEdge | null;
}

export type OverlayAction =
  | { type: 'init'; init: OverlayInitLike }
  | { type: 'drag-move'; to: Point }        // raw pointer target; reducer clamps + peeks
  | { type: 'drag-end' }
  | { type: 'toggle-chat' }
  | { type: 'engage' } | { type: 'disengage' };

/** Bottom-right nook, clamped into the work area — used when no position was
 *  persisted yet. Mirrors BuddyWindowManager.show()'s `defaultPos`. */
export function defaultMascotPosition(workArea: Rect): Point {
  const raw: Point = {
    x: workArea.x + workArea.width - MASCOT_SIZE.width - 24,
    y: workArea.y + workArea.height - MASCOT_SIZE.height - 24,
  };
  return clampToWorkArea(raw, MASCOT_SIZE, workArea);
}

export function overlayReducer(s: OverlayState, a: OverlayAction): OverlayState {
  switch (a.type) {
    case 'init': {
      const workArea = a.init.workArea;
      let mascot = a.init.mascot ?? defaultMascotPosition(workArea);
      let dock: DockState = FREE_DOCK;
      if (a.init.dock) {
        // A buddy put away on an edge comes back put away — peeking is the
        // resting state at an edge, not a fresh drag away from it. Ported
        // from BuddyWindowManager.show()'s persisted-dock restore.
        dock = { mode: 'peeking', edge: a.init.dock };
        mascot = dockPosition(a.init.dock, mascot, MASCOT_SIZE, workArea);
      }
      return { workArea, mascot, dock, chatVisible: false, barVisible: false };
    }

    case 'drag-move': {
      const clamped = clampToWorkArea(a.to, MASCOT_SIZE, s.workArea);

      if (s.chatVisible) {
        // Chat-open drag branch, ported from moveMascot's `chatOpen` branch
        // (src/main/buddy-window-manager.ts:509-534). Ordinary edge-snap/peek
        // is disabled here — the pair is horizontally rigid while the chat is
        // open, so the mascot is x-pinned instead (below). Shoving the cursor
        // hard past an edge is the one way to "put him away": it reads as
        // intent to dock, so it closes the chat/bar and hands off to peek.
        const shove = detectSnapEdge(clamped, MASCOT_SIZE, s.workArea, PEEK_PAST_EDGE_PX);
        if (shove) {
          const dock = dockReducer(s.dock, { type: 'drag-peek', edge: shove });
          const mascot = dockPosition(shove, clamped, MASCOT_SIZE, s.workArea);
          return { ...s, mascot, dock, chatVisible: false, barVisible: false };
        }
        // No shove: dragging with the chat open never enters peek/dock — it
        // only ever resets to free (mirrors moveMascot's unconditional
        // `dispatchDock({type:'drag-start'})` in this branch).
        const dock = dockReducer(s.dock, { type: 'drag-start' });
        // Horizontal pin (mascotXRangeForChat) keeps the chat fully on
        // screen — "keep the chat on screen" is a constraint on the MASCOT,
        // not the chat, because the pair are rigidly offset (buddy-geometry.ts).
        const range = mascotXRangeForChat({ ...clamped, ...MASCOT_SIZE }, s.workArea);
        const pinned: Point = { x: Math.max(range.min, Math.min(clamped.x, range.max)), y: clamped.y };
        // Rigid-group rule: adopt computeGroupLayout's mascot into state
        // immediately, the same call toggle-chat makes — this reducer has no
        // separate "glide to rest" step (unlike BuddyWindowManager), so state
        // must always hold the position actually rendered, including any
        // tier-3 vertical squash the chat forces mid-drag, not defer it.
        const layout = computeGroupLayout({ ...pinned, ...MASCOT_SIZE }, s.workArea);
        return { ...s, mascot: layout.mascot, dock };
      }

      const edge = detectSnapEdge(clamped, MASCOT_SIZE, s.workArea);
      // Live peek while still dragging (buddy-dock.ts's `drag-peek`); pulling
      // back into open space frees him again (`drag-start` resets to free).
      const dock = edge
        ? dockReducer(s.dock, { type: 'drag-peek', edge })
        : dockReducer(s.dock, { type: 'drag-start' });
      return { ...s, mascot: clamped, dock };
    }

    case 'drag-end': {
      if (s.chatVisible) {
        // Chat-open release never snaps/docks, ported from dragEnded's
        // `chatOpen ? null : detectSnapEdge(...)` (buddy-window-manager.ts:161)
        // — drag-release with a null edge always resolves to FREE_DOCK
        // (buddy-dock.ts), so this collapses to that. glideGroup's real
        // counterpart also always settles onto computeGroupLayout's mascot
        // while the chat is visible, regardless of dock outcome — adopt it
        // here for the same "state must hold what's rendered" reason as
        // drag-move above.
        const dock = dockReducer(s.dock, { type: 'drag-release', snapEdge: null });
        const layout = computeGroupLayout({ ...s.mascot, ...MASCOT_SIZE }, s.workArea);
        return { ...s, dock, mascot: layout.mascot };
      }
      const edge = detectSnapEdge(s.mascot, MASCOT_SIZE, s.workArea);
      let dock = dockReducer(s.dock, { type: 'drag-release', snapEdge: edge });
      // WHY chain engage here: dockReducer's drag-release contract only ever
      // resolves to 'peeking' or 'free' (buddy-dock.ts) — there's no separate
      // "hover the edge, wait to be summoned" idle timer in the single-window
      // overlay, so releasing a drag AT an edge commits straight through to
      // 'docked' rather than leaving him half-settled in 'peeking'.
      dock = dockReducer(dock, { type: 'engage' });
      const mascot = dock.mode === 'docked' && dock.edge
        ? dockPosition(dock.edge, s.mascot, MASCOT_SIZE, s.workArea)
        : s.mascot;
      return { ...s, dock, mascot };
    }

    case 'toggle-chat': {
      const chatVisible = !s.chatVisible;
      let mascot = s.mascot;
      if (chatVisible) {
        // Rigid-group rule: opening the chat may force the mascot to make
        // room for it (computeGroupLayout's tier-3 squash) — adopt that
        // shift into state so later drags/docks read the buddy's REAL
        // position, not a spot the chat has since covered.
        const layout = computeGroupLayout({ ...s.mascot, ...MASCOT_SIZE }, s.workArea);
        mascot = layout.mascot;
      }
      // WHY: BarVisibilityTracker.wantsVisible() (buddy-bar-visibility.ts) is
      // literally `chatOpen` — inlined here rather than porting a whole
      // tracker class for one boolean. The bar opens with the chat and
      // nothing else (PITFALLS §Buddy Floater), so this assignment is what
      // makes `barVisible → chatVisible` structurally impossible to violate.
      return { ...s, mascot, chatVisible, barVisible: chatVisible };
    }

    case 'engage':
      return { ...s, dock: dockReducer(s.dock, { type: 'engage' }) };

    case 'disengage': {
      const dock = dockReducer(s.dock, { type: 'disengage' });
      // Re-flush a peeking buddy to his edge on disengage. `peeking` is only
      // guaranteed flush when live drag-peek enters it (drag-move sets the
      // position in the same step); reaching it via disengage after the
      // group was shoved off its edge to fit an open chat would otherwise
      // strand him mid-air (PITFALLS: "peek occasionally hangs off of
      // nothing", ported from BuddyWindowManager.reconcilePeekPosition).
      const mascot = dock.mode === 'peeking' && dock.edge
        ? dockPosition(dock.edge, s.mascot, MASCOT_SIZE, s.workArea)
        : s.mascot;
      return { ...s, dock, mascot };
    }
  }
}

export function overlayLayout(s: OverlayState): { mascot: Point; chat: Point; bar: Point } {
  const mascotBounds: Rect = { ...s.mascot, ...MASCOT_SIZE };
  const group = computeGroupLayout(mascotBounds, s.workArea);
  const bar = computeBarPosition({ ...group.mascot, ...MASCOT_SIZE }, s.workArea);
  return { mascot: group.mascot, chat: group.chat, bar };
}
