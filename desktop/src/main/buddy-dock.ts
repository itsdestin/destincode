import { clampToWorkArea, type Point, type Rect, type Size } from './buddy-window-manager';

/**
 * Edge snap + peek state machine (spec §6). Pure — the BuddyWindowManager
 * drives it with events and owns the windows.
 *
 *   free ──drag-peek/drag-release(near edge)──▶ peeking ──engage──▶ docked
 *     ▲                                            ▲                   │
 *     └──drag-start / drag-release(elsewhere)      │                  │
 *                                                  └─── disengage ────┘
 *
 * Peek is DIRECT and has no timer (Destin 2026-07-17). It engages LIVE, mid-drag:
 * drag the buddy against an edge and `drag-peek` snaps him into peek while you're
 * still holding him (he then slides along the edge); pull him away and `drag-start`
 * frees him again. Releasing at the edge (`drag-release`) just leaves him peeked.
 * There used to be an 8s idle timer between `docked` and `peeking`, which made
 * peek feel like something that happened TO you rather than something you did —
 * you couldn't put him away, you could only wait.
 *
 * `docked` is now the deliberate "out and staying out" state: engage fires when
 * the chat opens or the buddy needs attention, disengage when both are done.
 * Hover is NOT an event here — it's a transient hop the renderer animates
 * locally (BuddyMascot), because it shouldn't change what state he's in.
 */
export type DockEdge = 'left' | 'right' | 'top' | 'bottom';
export interface DockState { mode: 'free' | 'docked' | 'peeking'; edge: DockEdge | null; }
export type DockEvent =
  | { type: 'drag-start' }
  | { type: 'drag-peek'; edge: DockEdge }        // dragged against an edge — peek NOW, still holding
  | { type: 'drag-release'; snapEdge: DockEdge | null }
  | { type: 'engage' }      // chat opened, or attention needed — come out and stay
  | { type: 'disengage' };  // chat closed and nothing needs attention — sink back

export const FREE_DOCK: DockState = { mode: 'free', edge: null };
export const SNAP_THRESHOLD_PX = 24;

export function dockReducer(state: DockState, event: DockEvent): DockState {
  switch (event.type) {
    case 'drag-start':
      return FREE_DOCK;
    case 'drag-peek':
      // Live peek while the drag is still in progress; the same shape a
      // drag-release near an edge produces, just entered a beat earlier.
      return { mode: 'peeking', edge: event.edge };
    case 'drag-release':
      return event.snapEdge ? { mode: 'peeking', edge: event.snapEdge } : FREE_DOCK;
    case 'engage':
      return state.mode === 'peeking' ? { mode: 'docked', edge: state.edge } : state;
    case 'disengage':
      return state.mode === 'docked' ? { mode: 'peeking', edge: state.edge } : state;
  }
}

/** Nearest workArea edge within threshold of the window bounds, else null.
 *  Corners resolve to the strictly nearer edge. */
export function detectSnapEdge(pos: Point, size: Size, workArea: Rect, threshold = SNAP_THRESHOLD_PX): DockEdge | null {
  const candidates: Array<[DockEdge, number]> = [
    ['left', pos.x - workArea.x],
    ['right', workArea.x + workArea.width - (pos.x + size.width)],
    ['top', pos.y - workArea.y],
    ['bottom', workArea.y + workArea.height - (pos.y + size.height)],
  ];
  const within = candidates.filter(([, d]) => d <= threshold);
  if (within.length === 0) return null;
  within.sort((a, b) => a[1] - b[1]);
  return within[0][0];
}

/** Window position flush against `edge`, preserving (and clamping) the other axis. */
export function dockPosition(edge: DockEdge, current: Point, size: Size, workArea: Rect): Point {
  const raw: Point =
    edge === 'left' ? { x: workArea.x, y: current.y } :
    edge === 'right' ? { x: workArea.x + workArea.width - size.width, y: current.y } :
    edge === 'top' ? { x: current.x, y: workArea.y } :
    { x: current.x, y: workArea.y + workArea.height - size.height };
  return clampToWorkArea(raw, size, workArea);
}
