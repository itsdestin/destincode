import { BrowserWindow, screen } from 'electron';
import type { WebContents } from 'electron';
import type { WindowRegistry } from './window-registry';
import { clampToWorkArea, MASCOT_SIZE, type Rect, type Point } from '../shared/buddy-geometry';
import type { DockEdge } from '../shared/buddy-dock';
import type { BuddyManager } from './buddy-manager';
import { IPC } from '../shared/types';

// WHY: Task 8's KWin script matches windows by title to apply keep-above —
// this string is the contract between that script and window creation, so it
// lives here (not inlined at the call site) to make the coupling visible.
export const OVERLAY_TITLE = 'YouCoded Buddy';

// WHY exported (not inlined in the class): main.ts's construction site needs
// the shape to build the deps object, and later tasks (4, 8) extend/consume
// individual fields (applyKeepAbove is a real KWin runner from Task 8 on).
export interface BuddyOverlayDeps {
  createOverlayWindow(opts: { width: number; height: number }): BrowserWindow;
  getPersisted(): { mascot: Point | null; dock: DockEdge | null; keepAbove: boolean };
  persist(state: { mascot: Point; dock: DockEdge | null }): void;
  registry: WindowRegistry;
  mainWindow: () => BrowserWindow | null;
  onStatusChanged(status: { dismissed: boolean; visible: boolean }): void;
  /** Task 8: wired at main.ts's construction site to a fire-and-forget call
   *  into kwin-keep-above.ts's applyKwinKeepAbove(OVERLAY_TITLE, true) —
   *  the real KWin scripting DBus runner. Silently does nothing on
   *  GNOME/wlroots/anywhere qdbus or the KWin scripting service is absent. */
  applyKeepAbove(win: BrowserWindow): void;
}

export interface OverlayInit {
  /** WINDOW-LOCAL: displayWorkArea offset by -displayBounds.x/y. The overlay
   *  window is constructed at exactly displayBounds size and position 0,0
   *  relative to itself, so this is the only work-area frame the renderer
   *  can use — getBounds()/getPosition() are stale/echoed on Wayland. */
  workArea: Rect;
  /** Window-local, pre-clamped into workArea, or null if nothing was
   *  persisted yet (renderer picks its own default position). */
  mascot: Point | null;
  dock: DockEdge | null;
}

/**
 * Pure payload builder for the `IPC.BUDDY_OVERLAY_INIT` push. Kept free of
 * Electron/window state so it's unit-testable without a display server —
 * see tests/buddy-overlay-manager.test.ts.
 *
 * Converts the (screen-absolute) persisted mascot position and the
 * (screen-absolute) display work area into the overlay window's own
 * coordinate frame, which is always displayBounds's top-left at (0,0)
 * because construct-at-size IS how the overlay is positioned (never
 * setPosition/maximize — see buddy-overlay-manager show()).
 */
export function overlayInitPayload(
  displayBounds: Rect,
  displayWorkArea: Rect,
  persisted: { mascot: Point | null; dock: DockEdge | null },
): OverlayInit {
  const workArea: Rect = {
    x: displayWorkArea.x - displayBounds.x,
    y: displayWorkArea.y - displayBounds.y,
    width: displayWorkArea.width,
    height: displayWorkArea.height,
  };
  const mascot = persisted.mascot
    ? clampToWorkArea(
        { x: persisted.mascot.x - displayBounds.x, y: persisted.mascot.y - displayBounds.y },
        MASCOT_SIZE,
        workArea,
      )
    : null;
  return { workArea, mascot, dock: persisted.dock };
}

/**
 * One screen-sized, click-through-by-default BrowserWindow hosting the whole
 * buddy floater (mascot + chat + bar) as DOM, for platforms where Electron
 * cannot reposition windows (Linux Wayland — see chooseBuddyStrategy).
 *
 * Everywhere else (`BuddyWindowManager`) drags/docks the mascot by moving
 * BrowserWindows around the screen. That's not possible here, so:
 *   - the window is constructed AT the primary display's bounds and never
 *     moved — construct-at-size is the entire positioning mechanism;
 *   - all mascot drag/dock/peek logic moves into the renderer (DOM/CSS),
 *     which is why moveMascot/dragEnded below are no-ops on this class;
 *   - a display change (monitor plugged in, resolution change) can't be
 *     handled by resizing/repositioning either, so the fix is destroy +
 *     recreate at the new bounds (see handleDisplayChange).
 */
export class BuddyOverlayManager implements BuddyManager {
  private win: BrowserWindow | null = null;
  private dismissed = false;
  private viewedSessionId: string | null = null;
  // Debounces bursty display-metrics-changed/display-added/display-removed
  // events (e.g. a monitor hotplug fires several in quick succession) into
  // one destroy+recreate rather than rebuilding the renderer repeatedly.
  private recreateTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: BuddyOverlayDeps) {
    // WHY these three (not the brief's literal 'display-metrics-changed' |
    // 'primary-display-changed'): Electron's Screen API (checked against the
    // installed v41 typings) has no 'primary-display-changed' event — it
    // never existed in the public API. 'display-metrics-changed' covers
    // resolution/scale/rotation changes; 'display-added'/'display-removed'
    // cover monitor hotplug, which is the actual "primary display changed"
    // case (unplugging the primary monitor, or plugging in a new one that
    // becomes primary) — together a strict superset of what the brief asked
    // to debounce.
    screen.on('display-metrics-changed', () => this.handleDisplayChange());
    screen.on('display-added', () => this.handleDisplayChange());
    screen.on('display-removed', () => this.handleDisplayChange());
  }

  private handleDisplayChange(): void {
    if (this.recreateTimer) clearTimeout(this.recreateTimer);
    this.recreateTimer = setTimeout(() => {
      this.recreateTimer = null;
      // Only rebuild while actually shown — a hidden overlay has nothing to
      // resize, and the next show() will read the current display anyway.
      if (!this.win || this.win.isDestroyed()) return;
      const old = this.win;
      this.win = null;
      old.destroy();
      this.createWindow();
    }, 300);
  }

  /** Build (or rebuild) the overlay window at the primary display's current
   *  bounds and wire it up. Callers (show(), handleDisplayChange()) are
   *  responsible for having cleared `this.win` first. */
  private createWindow(): void {
    const primary = screen.getPrimaryDisplay();
    const win = this.deps.createOverlayWindow({ width: primary.bounds.width, height: primary.bounds.height });
    this.win = win;
    win.setTitle(OVERLAY_TITLE);
    win.setAlwaysOnTop(true, 'screen-saver'); // harmless request; Task 8's applyKeepAbove does the real work
    // WHY immediately, before showInactive(): the overlay must NEVER eat
    // clicks by default. Setting this after showing would leave a window
    // that briefly swallows clicks the instant it appears.
    win.setIgnoreMouseEvents(true, { forward: true });
    const persisted = this.deps.getPersisted();
    // WHY it's fine that a toggle-time apply can fail transiently and leave
    // the CURRENT window's KWin keepAbove state stale (e.g. Settings' toggle
    // flips to "off" but a momentary DBus hiccup means the compositor never
    // got the unpin — see SettingsPanel.tsx's toggleKeepAbove for the fuller
    // reasoning on why the toggle doesn't try to detect/revert that): KWin's
    // keepAbove is a property of THIS window instance, not something that
    // persists across recreation. Every recreate constructs a brand-new
    // window that starts unpinned, and this guard is the only place
    // keepAbove ever gets (re)applied — so any stale pin/unpin state is
    // wiped the next time the overlay is torn down and rebuilt (display
    // change, or the next show() after a hide()), not accumulated forever.
    if (persisted.keepAbove) this.deps.applyKeepAbove(win);
    win.showInactive();
    win.webContents.on('did-finish-load', () => {
      if (win.isDestroyed()) return;
      // Recompute against the CURRENT primary display, not the snapshot
      // `primary` was taken from at construction — a display change between
      // creation and first paint should still hand the renderer fresh geometry.
      const display = screen.getPrimaryDisplay();
      const payload = overlayInitPayload(display.bounds, display.workArea, {
        mascot: persisted.mascot,
        dock: persisted.dock,
      });
      win.webContents.send(IPC.BUDDY_OVERLAY_INIT, payload);
    });
    // Mirrors BuddyWindowManager's crash handling: non-clean renderer exits
    // (crash, OOM, force-kill) tear the buddy down; clean exits (dev hot
    // reload) must NOT, or the buddy would vanish on every HMR reload.
    win.webContents.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit') this.hide();
    });
    win.on('closed', () => {
      // Guard by identity: a display-change recreate destroys the old window
      // and immediately assigns a new one to `this.win` — if the old
      // window's 'closed' event fires after that reassignment, it must not
      // null out the NEW window's reference.
      if (this.win === win) this.win = null;
    });
  }

  show(): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.showInactive();
      return;
    }
    this.createWindow();
    // Any show() clears "hidden until restart" — mirrors BuddyWindowManager
    // (Settings' "Show now" is just buddy.show()). The hide button (dismiss())
    // sets it after calling hide(), so this order is safe.
    this.dismissed = false;
    this.deps.onStatusChanged(this.getStatus());
  }

  getStatus(): { dismissed: boolean; visible: boolean } {
    return { dismissed: this.dismissed, visible: !!(this.win && !this.win.isDestroyed()) };
  }

  hide(): void {
    if (this.recreateTimer) { clearTimeout(this.recreateTimer); this.recreateTimer = null; }
    const win = this.win;
    this.win = null;
    if (win && !win.isDestroyed()) win.destroy();
    // Reset so a subsequent show() + setViewedSession(sameId) doesn't
    // early-return in setViewedSession and skip re-subscription — same
    // reasoning as BuddyWindowManager.hide().
    this.viewedSessionId = null;
    this.dismissed = false;
    this.deps.onStatusChanged(this.getStatus());
  }

  /** Hide-for-this-run (bar hide button). Preference untouched — the bar's
   *  hide button must NOT write the localStorage preference (PITFALLS). */
  dismiss(): void {
    this.hide();
    this.dismissed = true;
    this.deps.onStatusChanged(this.getStatus());
  }

  toggleChat(): void {
    // External callers only (e.g. tray/menu). Mascot clicks toggle the chat
    // renderer-local, since the whole floater is DOM inside this one window.
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC.BUDDY_OVERLAY_TOGGLE_CHAT);
    }
  }

  /** Move the overlay's session subscription from the previous session to
   *  the new one — identical dance to BuddyWindowManager.setViewedSession,
   *  just against the overlay's single webContents.id. */
  setViewedSession(sessionId: string): void {
    const prev = this.viewedSessionId;
    if (prev === sessionId) return;
    if (this.win && !this.win.isDestroyed()) {
      const wcId = this.win.webContents.id;
      if (prev) this.deps.registry.unsubscribe(prev, wcId);
      this.deps.registry.subscribe(sessionId, wcId);
    }
    this.viewedSessionId = sessionId;
  }

  getViewedSession(): string | null {
    return this.viewedSessionId;
  }

  // WHY no-op: the three-window model uses attention-needed to drive the
  // dock/peek state machine's forced "come out and stay" (buddy-dock.ts
  // engage/disengage), which exists because a peeking mascot is parked off-
  // screen at an edge and has to be dragged back into view by moving its
  // BrowserWindow. The overlay's mascot is DOM inside an always-full-screen
  // window — there's no window-level "pop out"; if attention visuals need
  // to react, that's a renderer-side concern for a later task to wire.
  setAttentionNeeded(_needed: boolean): void {}

  isBuddyWindow(win: BrowserWindow): boolean {
    return win === this.win;
  }

  captureWindows(): BrowserWindow[] {
    return this.win && !this.win.isDestroyed() ? [this.win] : [];
  }

  chatWebContents(): WebContents | null {
    return this.win && !this.win.isDestroyed() ? this.win.webContents : null;
  }

  // WHY a public method rather than exposing `deps.persist` directly: `deps`
  // is a private constructor param, so main.ts's IPC handler (which only
  // holds a `BuddyManager` reference, not this class's internals) has no
  // other way to reach it. This just forwards to the same persist function
  // the class already uses internally — no second storage location.
  persistFromRenderer(state: { mascot: Point; dock: DockEdge | null }): void {
    this.deps.persist(state);
  }

  setInteractive(interactive: boolean): void {
    if (!this.win || this.win.isDestroyed()) return;
    if (interactive) {
      this.win.setIgnoreMouseEvents(false);
    } else {
      this.win.setIgnoreMouseEvents(true, { forward: true });
    }
  }

  // WHY no-op: per-frame BrowserWindow.setPosition dragging is the
  // three-window model's mechanism (see BuddyWindowManager.moveMascot). The
  // overlay is one screen-sized window that's never repositioned — the
  // mascot moves via DOM/CSS transform inside it, driven entirely by the
  // renderer, so main never needs a per-frame drag target here.
  moveMascot(_targetX: number, _targetY: number): void {}

  // WHY no-op: see moveMascot — drag-release snap detection also has to
  // live renderer-side for the overlay model, since there's no per-mascot
  // BrowserWindow bounds for main to read edge proximity from.
  dragEnded(): void {}
}
