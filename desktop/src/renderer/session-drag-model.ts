// How a session pill LEAVES its window once the user has dragged it clear of
// the strip. Reordering INSIDE the strip is not affected by any of this — it
// runs on the pointer path on every platform, which is what #404's motion is
// built on and what must not be disturbed.
//
// 'live-window' — today's model on Windows/macOS/X11: spawn a peer window
//   mid-drag and reposition it every frame so it follows the cursor
//   ("Chrome-style live tear-off"), then ask the OS which window's strip
//   contains the cursor in order to resolve the drop.
//
// 'os-drag' — hand the gesture to the COMPOSITOR mid-drag
//   (webContents.startDrag). The destination window is TOLD a drag entered it
//   and dropped on it, in its own window-local coordinates. Nobody computes,
//   reads or sets a screen coordinate anywhere.
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
// WHAT IS DELIBERATELY NOT DONE HERE: an earlier draft of this fix ran the
// WHOLE drag as an HTML5 drag on Wayland, which would have disabled the pointer
// path and flattened #404's in-strip motion on Linux to fix a cross-window
// problem. Window-local coordinates (clientX) work perfectly on Wayland — only
// screen coordinates are dead — so only the cross-window half needs replacing.
//
// NOTE on XWayland: a Wayland session running the app through XWayland is
// classified 'os-drag' here even though positioning would work. Deliberate and
// harmless — 'os-drag' is correct on every platform; it only forgoes an
// animation. Guessing wrong the other way is what leaves a user stranded.
export type SessionTearOffModel = 'live-window' | 'os-drag';

/** What preload reports about the host. Pure data — no decision lives there. */
export interface PlatformFacts {
  platform: string;
  wayland: boolean;
}

export function chooseTearOffModel(facts: PlatformFacts | null | undefined): SessionTearOffModel {
  // Remote browser / Android / workbench report nothing: single-window surfaces
  // where the strip's cross-window paths are inert either way.
  if (!facts) return 'live-window';
  if (facts.platform === 'linux' && facts.wayland) return 'os-drag';
  return 'live-window';
}

/**
 * The session id a cross-window drop carries, smuggled through a FILE NAME.
 *
 * WHY a file name: Electron's only API that can begin a drag mid-gesture is
 * `webContents.startDrag`, and it drags files — there is no way to attach a
 * custom MIME payload to it. So the drag carries a real (empty, temporary) file
 * whose NAME encodes the session. The receiving window reads
 * `event.dataTransfer.files[0].name`; it never needs the file's contents or its
 * path (`File.path` is not exposed to the renderer in current Electron, and is
 * not needed).
 *
 * The source window id is NOT encoded: main resolves the owner from the
 * WindowRegistry, so a hand-crafted drop cannot move somebody else's session.
 */
const PREFIX = 'youcoded-session--';
const SUFFIX = '.ycsession';

export function dragFileNameFor(sessionId: string): string {
  // Session ids are uuids, but encode defensively: a name is a path segment.
  return `${PREFIX}${encodeURIComponent(sessionId)}${SUFFIX}`;
}

/** null when the name is anything other than one of ours — a real file drop. */
export function sessionIdFromDragFileName(name: string | null | undefined): string | null {
  if (!name || !name.startsWith(PREFIX) || !name.endsWith(SUFFIX)) return null;
  const raw = name.slice(PREFIX.length, name.length - SUFFIX.length);
  if (!raw) return null;
  try {
    return decodeURIComponent(raw);
  } catch {
    return null;
  }
}
