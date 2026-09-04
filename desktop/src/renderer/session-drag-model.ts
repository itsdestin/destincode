// How a session pill LEAVES its window once the user has dragged it clear of
// the strip, and how the drag carries the session's identity.
//
// 'live-window' — today's model on Windows/macOS/X11: spawn a peer window
//   mid-drag and reposition it every frame so it follows the cursor
//   ("Chrome-style live tear-off"), then ask the OS which window's strip
//   contains the cursor in order to resolve the drop.
//
// 'html-drag' — the pill is a browser-native draggable and the WHOLE gesture
//   is a browser drag from the first pixel. The compositor carries the picture
//   and delivers the drop to whichever YouCoded window it lands on, in that
//   window's own window-local coordinates. Nobody computes, reads or sets a
//   screen coordinate anywhere. Reordering INSIDE the strip runs on the
//   `dragover` stream instead of `pointermove` — measured at ~190 events/s
//   with working clientX (2026-09-04), which is what #404's motion needs.
//
// WHY the fork exists (measured on this machine 2026-09-03, KDE Plasma /
// Wayland, Electron 41.10.7, pointer actively moving over the app's own focused
// window — re-runnable with `node scripts/platform-probe.mjs`):
//
//   screen.getCursorScreenPoint()  ->  {x:0, y:0}   every sample
//   win.getPosition()              ->  [0, 0]       every window, any request
//   win.setPosition(1200, 300)     ->  a no-op that STILL REPORTS SUCCESS
//   window.screenX / screenY       ->  0            every window
//
// 'live-window' has exactly three inputs and all three are zero there. So peer
// windows never highlighted, the torn-off window never followed the cursor, and
// the drop always resolved to "you dropped it on nothing" — which, combined
// with the (correct, Chrome-matching) rule that a window's only session cannot
// be torn off, means a pill in a torn-off window could never be dragged back.
// Destin, 2026-09-03: "permanently stuck with two windows". Wayland forbids a
// client from learning or setting where its windows sit; it is not
// configurable, and XWayland is rejected because it blurs the whole app at
// fractional scaling.
//
// WHY a browser drag and not `webContents.startDrag` (the previous attempt,
// 2026-09-04): on Linux Electron routes startDrag's picture through Chromium's
// LINK-drag helper (button_drag_utils::SetDragImage, kLinkDragImageMaxWidth =
// 150), which crops any picture to ~138px, draws it at 1x, offers only
// copy/link, and can carry nothing but a file. A drag the PAGE starts touches
// none of that: measured the same day, a 330px picture came through whole and
// crisp at 1.5x, the payload arrived through dataTransfer, and 'move' was
// accepted. The cost is that a browser drag can only begin at mouse-down —
// which is why the whole gesture is one on this model, not just its tail.
//
// What a browser drag CANNOT do here (measured 2026-09-04):
//   - start from TOUCH — Chromium never fires dragstart for a touch press on
//     Linux, with or without --touch-drag-drop. A finger keeps the pointer path
//     for reordering; moving a session between windows by touch is the pill's
//     right-click / long-press menu.
//   - tell "released over the empty desktop" from "pressed Escape": both end
//     with dropEffect 'none' and unusable coordinates. Destin chose the
//     desktop drop (2026-09-04): releasing over nothing opens a new window,
//     as on Windows/macOS, and so does Escape; cancelling is dragging the
//     pill back into the strip. The chat area is a second, labelled route
//     to the same thing (SessionDropZone).
//
// NOTE on XWayland: a Wayland session running the app through XWayland is
// classified 'html-drag' here even though positioning would work. Deliberate
// and harmless — 'html-drag' is correct on every platform; it only forgoes an
// animation. Guessing wrong the other way is what leaves a user stranded.
export type SessionTearOffModel = 'live-window' | 'html-drag';

/** What preload reports about the host. Pure data — no decision lives there. */
export interface PlatformFacts {
  platform: string;
  wayland: boolean;
}

export function chooseTearOffModel(facts: PlatformFacts | null | undefined): SessionTearOffModel {
  // Remote browser / Android / workbench report nothing: single-window surfaces
  // where the strip's cross-window paths are inert either way.
  if (!facts) return 'live-window';
  if (facts.platform === 'linux' && facts.wayland) return 'html-drag';
  return 'live-window';
}

/**
 * The MIME type a session drag carries. Private to this app: no other program
 * reads it, and a file, link or text drag never has it — so it doubles as the
 * test for "is this drag one of ours", which is readable MID-drag through
 * `dataTransfer.types` even though the value itself is withheld until drop.
 */
export const SESSION_DRAG_MIME = 'application/x-youcoded-session';

/** Minimal view of DataTransfer — what the strip reads, and what tests fake. */
export interface DragData {
  types?: ArrayLike<string> | null;
  getData?: (type: string) => string;
  setData?: (type: string, value: string) => void;
}

export function dragCarriesSession(dt: DragData | null | undefined): boolean {
  if (!dt?.types) return false;
  return Array.from(dt.types).includes(SESSION_DRAG_MIME);
}

export function writeSessionDrag(dt: DragData, sessionId: string): void {
  dt.setData?.(SESSION_DRAG_MIME, sessionId);
}

/** null when the drop is anything other than one of ours — a real file drop. */
export function readSessionDrag(dt: DragData | null | undefined): string | null {
  if (!dragCarriesSession(dt)) return null;
  const id = dt?.getData?.(SESSION_DRAG_MIME) ?? '';
  return id || null;
}

/**
 * The session drag THIS window started, while it is in flight. Module state,
 * not React state, because two unrelated components need it mid-gesture: the
 * strip (which knows) and the drop zone over the chat (which must label itself
 * "open in a new window" for our own pill and "move here" for another
 * window's — and the browser withholds the payload until the drop, so the
 * zone cannot read it from the drag). Another window sees null and therefore
 * treats any session drag as foreign, which it is.
 */
export interface LocalSessionDrag {
  sessionId: string;
  /** The source window's ONLY session — cannot be torn off (Chrome's rule). */
  lone: boolean;
}

let localDrag: LocalSessionDrag | null = null;

export function beginLocalSessionDrag(drag: LocalSessionDrag): void {
  localDrag = drag;
}

export function endLocalSessionDrag(): void {
  localDrag = null;
}

export function localSessionDrag(): LocalSessionDrag | null {
  return localDrag;
}
