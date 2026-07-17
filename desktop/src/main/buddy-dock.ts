import { clampToWorkArea, type Point, type Rect, type Size } from './buddy-window-manager';

/**
 * Edge snap + peek state machine (spec §6). Pure — the BuddyWindowManager
 * drives it with events and owns the timers/windows.
 *
 *   free ──drag-release(near edge)──▶ docked ──8s idle──▶ peeking
 *     ▲                                 ▲                    │
 *     └──drag-release(elsewhere)/drag-start                  │
 *                                       └────── activity ────┘
 */
export type DockEdge = 'left' | 'right' | 'top' | 'bottom';
export interface DockState { mode: 'free' | 'docked' | 'peeking'; edge: DockEdge | null; }
export type DockEvent =
  | { type: 'drag-start' }
  | { type: 'drag-release'; snapEdge: DockEdge | null }
  | { type: 'idle-timeout' }
  | { type: 'activity' }; // hover, chat opening, attention

export const FREE_DOCK: DockState = { mode: 'free', edge: null };
export const SNAP_THRESHOLD_PX = 24;
export const PEEK_IDLE_MS = 8000;

export function dockReducer(state: DockState, event: DockEvent): DockState {
  switch (event.type) {
    case 'drag-start':
      return FREE_DOCK;
    case 'drag-release':
      return event.snapEdge ? { mode: 'docked', edge: event.snapEdge } : FREE_DOCK;
    case 'idle-timeout':
      return state.mode === 'docked' ? { mode: 'peeking', edge: state.edge } : state;
    case 'activity':
      return state.mode === 'peeking' ? { mode: 'docked', edge: state.edge } : state;
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
