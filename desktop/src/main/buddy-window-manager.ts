import { BrowserWindow, screen } from 'electron';
import type { WindowRegistry } from './window-registry';
import { BAR_SIZE, computeBarPosition } from './buddy-bar-geometry';
import { BarVisibilityTracker } from './buddy-bar-visibility';
import {
  dockReducer, detectSnapEdge, dockPosition, FREE_DOCK, PEEK_IDLE_MS,
  type DockState, type DockEvent, type DockEdge,
} from './buddy-dock';

// Push-channel names (kept as local consts — this module deliberately doesn't
// import shared/types; values must match IPC.* in src/shared/types.ts).
const IPC_BAR_STATE = 'buddy:bar-state';
const IPC_CHAT_STATE = 'buddy:chat-state';
const IPC_MASCOT_STATE = 'buddy:mascot-state';

export interface Rect { x: number; y: number; width: number; height: number; }
export interface Point { x: number; y: number; }
export interface Size { width: number; height: number; }

/**
 * Clamp a position so the window stays fully inside the workArea.
 * Pure function — no electron deps — so it's unit-testable.
 */
export function clampToWorkArea(pos: Point, size: Size, workArea: Rect): Point {
  const maxX = workArea.x + workArea.width - size.width;
  const maxY = workArea.y + workArea.height - size.height;
  return {
    x: Math.max(workArea.x, Math.min(pos.x, maxX)),
    y: Math.max(workArea.y, Math.min(pos.y, maxY)),
  };
}

// 112px (was 80): Destin's 2026-07-16 dev test — the buddy read too small.
const MASCOT_SIZE: Size = { width: 112, height: 112 };
const CHAT_SIZE: Size = { width: 320, height: 480 };
// Action-bar size + position math live in buddy-bar-geometry.ts (pure,
// unit-tested); main.ts imports the same BAR_SIZE so the BrowserWindow
// dimensions and the positioning math can't drift.

export interface BuddyWindowManagerDeps {
  createBuddyWindow(variant: 'mascot' | 'chat' | 'bar', opts: { x: number; y: number }): BrowserWindow;
  getPersistedPosition(key: 'mascot'): Point | null;
  setPersistedPosition(key: 'mascot', pos: Point): void;
  /** Persisted dock edge (buddy-positions.json `dock` key) so a docked/peeking
   *  buddy is still docked after a restart (spec §6.1). */
  getPersistedDock(): DockEdge | null;
  setPersistedDock(edge: DockEdge | null): void;
  registry: WindowRegistry;
  mainWindow: () => BrowserWindow | null;
  /** Broadcast { dismissed, visible } to all windows (buddy:status-changed). */
  onStatusChanged(status: { dismissed: boolean; visible: boolean }): void;
}

/**
 * Owns the buddy mascot + chat BrowserWindows, their positions, and the
 * session-subscription handoff when the chat switches sessions.
 *
 * Lifecycle:
 *   - `show()` creates (or re-shows) the mascot window, clamped to a visible
 *     workArea so a saved position from a disconnected monitor can't hide it.
 *   - `toggleChat()` lazily creates the chat window on first click; subsequent
 *     toggles hide/show the same window (state preserved between toggles).
 *   - `hide()` destroys both windows.
 *   - Window crashes (`render-process-gone`) trigger `hide()` — user re-enables via settings.
 */
export class BuddyWindowManager {
  private mascot: BrowserWindow | null = null;
  private chat: BrowserWindow | null = null;
  // 3-button action-bar window pinned below the mascot while the chat is
  // open. Hidden (not destroyed) on chat-close so toggling doesn't rebuild
  // the renderer every time.
  private bar: BrowserWindow | null = null;
  private viewedSessionId: string | null = null;
  // Decides bar visibility from hover + chat-open (spec §4.1). The bar
  // BrowserWindow stays shown once created; reveals are CSS fades driven by
  // the buddy:bar-state push, and click-through is toggled alongside so the
  // invisible bar never eats clicks meant for windows underneath.
  private readonly barVisibility = new BarVisibilityTracker((visible) => this.applyBarVisible(visible));
  private barCssVisible = false;
  // "Hide until restart": set by the bar's hide button (buddy:dismiss), cleared
  // by any show(). localStorage['youcoded-buddy-enabled'] is untouched — the
  // preference stays on; only this run's windows go away. (spec §7)
  private dismissed = false;
  // Dock/peek state machine (spec §6) — pure reducer in buddy-dock.ts; this
  // class owns the timers, the windows, and the persistence.
  private dockState: DockState = FREE_DOCK;
  private peekTimer: NodeJS.Timeout | null = null;
  private glideTimer: NodeJS.Timeout | null = null;
  private attentionNeeded = false;

  constructor(private readonly deps: BuddyWindowManagerDeps) {}

  /** Renderer hover reports land here (buddy:hover-changed IPC). Hover is
   *  also the dock 'activity' signal that slides a peeking mascot out. */
  reportHover(source: 'mascot' | 'bar', hovering: boolean): void {
    this.barVisibility.setHover(source, hovering);
    if (hovering) this.dispatchDock({ type: 'activity' });
    else this.schedulePeek();
  }

  /** Clear hover state stranded by WINDOW movement: pointerleave only fires
   *  on pointer MOVEMENT, so repositioning the bar/mascot out from under a
   *  stationary cursor leaves the tracker hovering forever — bar pinned
   *  visible, docked buddy never peeks. Called after main-driven moves. */
  private reconcileHoverWithCursor(): void {
    let cursor: Point;
    try { cursor = screen.getCursorScreenPoint(); } catch { return; }
    const contains = (w: BrowserWindow | null) => {
      if (!w || w.isDestroyed()) return false;
      const b = w.getBounds();
      return cursor.x >= b.x && cursor.x < b.x + b.width && cursor.y >= b.y && cursor.y < b.y + b.height;
    };
    if (!contains(this.bar)) this.barVisibility.setHover('bar', false);
    if (!contains(this.mascot)) this.barVisibility.setHover('mascot', false);
    this.schedulePeek();
  }

  private dispatchDock(event: DockEvent): void {
    const next = dockReducer(this.dockState, event);
    if (next.mode === this.dockState.mode && next.edge === this.dockState.edge) {
      this.schedulePeek(); // state unchanged, but activity resets the idle clock
      return;
    }
    this.dockState = next;
    this.deps.setPersistedDock(next.mode === 'free' ? null : next.edge);
    this.pushMascotState();
    this.schedulePeek();
  }

  private pushMascotState(): void {
    if (this.mascot && !this.mascot.isDestroyed()) {
      this.mascot.webContents.send(IPC_MASCOT_STATE, this.dockState);
    }
  }

  /** (Re)arm the docked→peeking idle timer. Peek only starts when nothing is
   *  going on: not hovered, chat closed, no attention (spec §6.2). */
  private schedulePeek(): void {
    if (this.peekTimer) { clearTimeout(this.peekTimer); this.peekTimer = null; }
    if (this.dockState.mode !== 'docked') return;
    if (this.barVisibility.wantsVisible() || this.attentionNeeded) return;
    this.peekTimer = setTimeout(() => {
      this.peekTimer = null;
      // Re-check: state may have changed while the timer was pending.
      if (this.dockState.mode === 'docked' && !this.barVisibility.wantsVisible() && !this.attentionNeeded) {
        this.dispatchDock({ type: 'idle-timeout' });
      }
    }, PEEK_IDLE_MS);
  }

  /** Called by main.ts from the attention aggregation broadcast — attention
   *  pops a peeking buddy out (spec §6.2). */
  setAttentionNeeded(needed: boolean): void {
    if (needed === this.attentionNeeded) return;
    this.attentionNeeded = needed;
    if (needed) this.dispatchDock({ type: 'activity' });
    else this.schedulePeek();
  }

  /** buddy:drag-ended — run snap detection against final window bounds. */
  dragEnded(): void {
    if (!this.mascot || this.mascot.isDestroyed()) return;
    const mb = this.mascot.getBounds();
    const display = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
    const edge = detectSnapEdge({ x: mb.x, y: mb.y }, MASCOT_SIZE, display.workArea);
    this.dispatchDock({ type: 'drag-release', snapEdge: edge });
    if (edge) {
      const target = dockPosition(edge, { x: mb.x, y: mb.y }, MASCOT_SIZE, display.workArea);
      this.glideTo(target);
    }
  }

  /** The one sanctioned window-bounds animation (spec §6.1): a short eased
   *  glide onto the edge. ~10 steps over 150ms; canceled by any new drag. */
  private glideTo(target: Point, ms = 150): void {
    if (this.glideTimer) { clearInterval(this.glideTimer); this.glideTimer = null; }
    const win = this.mascot;
    if (!win || win.isDestroyed()) return;
    const [sx, sy] = win.getPosition();
    const t0 = Date.now();
    this.glideTimer = setInterval(() => {
      if (!win || win.isDestroyed()) {
        if (this.glideTimer) clearInterval(this.glideTimer);
        this.glideTimer = null;
        return;
      }
      const t = Math.min(1, (Date.now() - t0) / ms);
      const ease = 1 - Math.pow(1 - t, 3);
      win.setPosition(Math.round(sx + (target.x - sx) * ease), Math.round(sy + (target.y - sy) * ease));
      if (t >= 1) {
        if (this.glideTimer) clearInterval(this.glideTimer);
        this.glideTimer = null;
        // Bar may need to flip sides now that the mascot sits on an edge.
        if (this.barCssVisible) this.applyBarVisible(true);
        // The glide moved windows under a possibly-stationary cursor.
        this.reconcileHoverWithCursor();
      }
    }, 16);
  }

  private applyBarVisible(visible: boolean): void {
    this.barCssVisible = visible;
    if (visible) {
      // Reposition-before-reveal: mascot may have moved while the bar was
      // hidden (the Task 3 bug class — never show at a stale position).
      this.showBar();
      const bar = this.bar;
      if (bar && !bar.isDestroyed()) {
        bar.setIgnoreMouseEvents(false);
        bar.webContents.send(IPC_BAR_STATE, { visible: true });
      }
    } else {
      const bar = this.bar;
      if (bar && !bar.isDestroyed()) {
        bar.webContents.send(IPC_BAR_STATE, { visible: false });
        // Let the 150ms CSS fade finish, then make the window click-through.
        // forward:true keeps mousemove flowing to the page so hovering the
        // (invisible) bar zone can still re-summon it — a nice grace region.
        setTimeout(() => {
          if (this.bar && !this.bar.isDestroyed() && !this.barCssVisible) {
            this.bar.setIgnoreMouseEvents(true, { forward: true });
          }
        }, 180);
      }
    }
  }

  show(): void {
    if (this.mascot && !this.mascot.isDestroyed()) {
      this.mascot.showInactive();
      return;
    }
    const saved = this.deps.getPersistedPosition('mascot');
    const primary = screen.getPrimaryDisplay().workArea;
    const defaultPos = { x: primary.x + primary.width - MASCOT_SIZE.width - 24, y: primary.y + primary.height - MASCOT_SIZE.height - 24 };
    const raw = saved ?? defaultPos;
    // getDisplayMatching picks the display containing the window's bounds;
    // if the saved position is off-screen entirely, fall back to primary.
    const display = screen.getDisplayMatching({ ...raw, ...MASCOT_SIZE }) ?? screen.getPrimaryDisplay();
    const clamped = clampToWorkArea(raw, MASCOT_SIZE, display.workArea);
    this.mascot = this.deps.createBuddyWindow('mascot', clamped);
    this.wireMascotLifecycle(this.mascot);
    this.mascot.showInactive();
    // Restore a persisted dock: place flush on the saved edge and re-enter
    // docked state (spec §6.1 — a docked buddy survives restarts).
    const savedEdge = this.deps.getPersistedDock();
    if (savedEdge) {
      const mb = this.mascot.getBounds();
      const d = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
      const flush = dockPosition(savedEdge, { x: mb.x, y: mb.y }, MASCOT_SIZE, d.workArea);
      this.mascot.setPosition(Math.round(flush.x), Math.round(flush.y));
      this.dockState = { mode: 'docked', edge: savedEdge };
      // Renderer may not have loaded yet — replay state when it has.
      this.mascot.webContents.once('did-finish-load', () => this.pushMascotState());
      this.pushMascotState();
      this.schedulePeek();
    }
    // Any show() clears "hidden until restart" — Settings' "Show now" is
    // just buddy.show(). Broadcast so open Settings panels update live.
    this.dismissed = false;
    this.deps.onStatusChanged(this.getStatus());
  }

  getStatus(): { dismissed: boolean; visible: boolean } {
    return {
      dismissed: this.dismissed,
      visible: !!(this.mascot && !this.mascot.isDestroyed()),
    };
  }

  /** Hide-for-this-run (bar hide button). Preference untouched. */
  dismiss(): void {
    this.hide();
    this.dismissed = true;
    this.deps.onStatusChanged(this.getStatus());
  }

  hide(): void {
    // Drop tracker state silently so a torn-down buddy doesn't fire a
    // stale visibility callback against destroyed windows. Dock timers die
    // with the windows, but the PERSISTED dock edge stays — a dismissed
    // buddy should come back docked.
    if (this.peekTimer) { clearTimeout(this.peekTimer); this.peekTimer = null; }
    if (this.glideTimer) { clearInterval(this.glideTimer); this.glideTimer = null; }
    this.dockState = FREE_DOCK;
    this.barVisibility.reset();
    this.barCssVisible = false;
    if (this.bar && !this.bar.isDestroyed()) this.bar.destroy();
    if (this.chat && !this.chat.isDestroyed()) this.chat.destroy();
    if (this.mascot && !this.mascot.isDestroyed()) this.mascot.destroy();
    this.bar = null;
    this.chat = null;
    this.mascot = null;
    // Reset so a subsequent show() + setViewedSession(sameId) doesn't
    // early-return in setViewedSession and skip re-subscription.
    this.viewedSessionId = null;
    // Settings-off also clears the dismissed flag — a disabled buddy isn't
    // "hidden until restart". (dismiss() re-sets the flag AFTER calling
    // hide(), so this order works; it then broadcasts the final value.)
    this.dismissed = false;
    this.deps.onStatusChanged(this.getStatus());
  }

  toggleChat(): void {
    if (!this.chat || this.chat.isDestroyed()) {
      this.createChat();
      return;
    }
    if (this.chat.isVisible()) {
      this.chatOpenIntent = false;
      // Exit animation: cue the renderer, let the 120ms fade play, THEN hide
      // the window. Guarded so a rapid re-toggle inside the delay can't hide
      // a window the user just re-opened.
      this.chat.webContents.send(IPC_CHAT_STATE, { visible: false });
      const chatRef = this.chat;
      setTimeout(() => {
        if (chatRef && !chatRef.isDestroyed() && chatRef === this.chat && !this.chatOpenIntent) {
          chatRef.hide();
        }
      }, 140);
      this.barVisibility.setChatOpen(false);
      this.schedulePeek(); // chat closed — the docked idle clock starts now
    } else {
      // Re-anchor to current mascot position before showing — the user may
      // have dragged the mascot while the chat was hidden, and the chat
      // should open "wherever the icon is" rather than at its stale last
      // position.
      this.chatOpenIntent = true;
      const pos = this.computeChatAnchoredPosition();
      this.chat.setPosition(Math.round(pos.x), Math.round(pos.y));
      this.chat.show();
      this.chat.webContents.send(IPC_CHAT_STATE, { visible: true });
      this.barVisibility.setChatOpen(true);
      // Opening the chat is dock 'activity' — a peeking mascot slides out.
      this.dispatchDock({ type: 'activity' });
    }
  }

  /**
   * Choose the chat window's position relative to the current mascot.
   * Prefer right-of-mascot; fall back to left-of-mascot if the right side
   * would clip the workArea. Always clamps to visible workArea as a safety.
   * Top-align chat with mascot so they read as a single unit — icon sits
   * alongside the top of its conversation panel.
   */
  private computeChatAnchoredPosition(): Point {
    if (!this.mascot || this.mascot.isDestroyed()) {
      const primary = screen.getPrimaryDisplay().workArea;
      return { x: primary.x + primary.width - CHAT_SIZE.width - 24, y: primary.y + primary.height - CHAT_SIZE.height - 24 };
    }
    const mb = this.mascot.getBounds();
    const display = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
    const wa = display.workArea;
    // Chat opens BELOW the mascot+bar GROUP, centered on the group's span
    // (not the mascot alone), flipping ABOVE when too close to the workArea
    // bottom. The horizontal relationship is pinned — above/below is the only
    // positional mode (Destin 2026-07-16). The bar rect is computed with the
    // same pure math showBar uses, so this holds even before the bar window
    // exists on a first reveal.
    const barPos = computeBarPosition(mb, wa);
    const groupLeft = Math.min(mb.x, barPos.x);
    const groupRight = Math.max(mb.x + mb.width, barPos.x + BAR_SIZE.width);
    const x = Math.round((groupLeft + groupRight) / 2) - Math.round(CHAT_SIZE.width / 2);
    const belowY = mb.y + mb.height + 12;
    const belowFits = belowY + CHAT_SIZE.height <= wa.y + wa.height;
    const raw = belowFits
      ? { x, y: belowY }
      : { x, y: mb.y - CHAT_SIZE.height - 12 };
    return clampToWorkArea(raw, CHAT_SIZE, wa);
  }

  /** Move the chat's subscription from the previous session to the new one. */
  setViewedSession(sessionId: string): void {
    const prev = this.viewedSessionId;
    if (prev === sessionId) return;
    if (this.chat && !this.chat.isDestroyed()) {
      const wcId = this.chat.webContents.id;
      if (prev) this.deps.registry.unsubscribe(prev, wcId);
      this.deps.registry.subscribe(sessionId, wcId);
    }
    this.viewedSessionId = sessionId;
  }

  getViewedSession(): string | null {
    return this.viewedSessionId;
  }

  /** True iff `win` is one of the buddy windows this manager owns
   *  (mascot, chat, or the action-bar window). main.ts uses this
   *  to decide when to tear the buddy down — spec §7.6 says buddy closes
   *  with the last main window. */
  isBuddyWindow(win: BrowserWindow): boolean {
    return win === this.mascot || win === this.chat || win === this.bar;
  }

  /** Read-only accessors for the main-process capture handler, which needs
   *  to hide every buddy window before calling desktopCapturer. */
  getMascotWindow(): BrowserWindow | null { return this.mascot; }
  getChatWindow(): BrowserWindow | null { return this.chat; }
  getBarWindow(): BrowserWindow | null { return this.bar; }

  /**
   * Place the mascot at an anchor-based target position from the renderer
   * (cursor screenX/Y minus the grab offset captured on pointerdown). Clamps
   * to the visible workArea. Replaces CSS -webkit-app-region: drag, which on
   * Windows consumes all pointer events via WM_NCHITTEST → HTCAPTION and
   * breaks click detection.
   *
   * Anchor-based (not delta-based): per-move rounding on HiDPI displays
   * cannot accumulate drift between cursor and mascot, because every move
   * recomputes the absolute target from the current cursor position. A
   * previous delta-based implementation caused "slides under my cursor" on
   * fractional-scale displays (125 / 150%): Math.round of each tiny dx
   * systematically over- or under-shot, and the residual compounded.
   */
  moveMascot(targetX: number, targetY: number): void {
    if (!this.mascot || this.mascot.isDestroyed()) return;
    // A live drag cancels any in-flight snap glide and pops the mascot out
    // of its dock (spec §6.1 — dragging always frees).
    if (this.glideTimer) { clearInterval(this.glideTimer); this.glideTimer = null; }
    if (this.dockState.mode !== 'free') this.dispatchDock({ type: 'drag-start' });
    const [oldX, oldY] = this.mascot.getPosition();
    const raw = { x: targetX, y: targetY };
    const display = screen.getDisplayMatching({ ...raw, ...MASCOT_SIZE }) ?? screen.getPrimaryDisplay();
    const clamped = clampToWorkArea(raw, MASCOT_SIZE, display.workArea);
    // setPosition requires integer args. Pointer screenX/Y on HiDPI displays
    // can be fractional, so targetX/Y (and therefore clamped.x/y) may be
    // floats — passing a float throws "Error processing argument at index 1,
    // conversion failure" from Electron's native bridge.
    const newX = Math.round(clamped.x);
    const newY = Math.round(clamped.y);
    this.mascot.setPosition(newX, newY);
    // Move the chat by the SAME delta the mascot actually moved (not the
    // requested delta, which may have been clamped). Clamp the follow-
    // position to the chat's own display's workArea — the mascot may be
    // pinned at an edge where the chat would otherwise overflow.
    //
    // Skip the follow entirely when the chat is hidden: toggleChat() always
    // re-anchors chat to the current mascot position via
    // computeChatAnchoredPosition() on show, so there's nothing a hidden
    // chat can do with a pending position. Every extra setPosition on a
    // frameless Windows BrowserWindow hits DWM, and stacking three per
    // pointermove (mascot + chat + action bar) was a measurable source
    // of "squishy" drag latency.
    const actualDx = newX - oldX;
    const actualDy = newY - oldY;
    const chatVisible = !!(this.chat && !this.chat.isDestroyed() && this.chat.isVisible());
    if ((actualDx !== 0 || actualDy !== 0) && this.chat && !this.chat.isDestroyed() && chatVisible) {
      const cb = this.chat.getBounds();
      const chatRaw = { x: cb.x + actualDx, y: cb.y + actualDy };
      const chatDisplay = screen.getDisplayMatching({ ...chatRaw, ...CHAT_SIZE }) ?? screen.getPrimaryDisplay();
      const chatClamped = clampToWorkArea(chatRaw, CHAT_SIZE, chatDisplay.workArea);
      this.chat.setPosition(Math.round(chatClamped.x), Math.round(chatClamped.y));
    }
    // Bar follows its own CSS visibility (not Electron isVisible() — the
    // window stays Electron-shown once created; reveals are CSS fades).
    // Recompute from scratch on visible: if the mascot lands on a bottom
    // edge the bar needs to flip above automatically.
    if (this.bar && !this.bar.isDestroyed() && this.barCssVisible) {
      const pos = this.currentBarPosition();
      this.bar.setPosition(Math.round(pos.x), Math.round(pos.y));
      // The bar just moved — it may have left a stationary cursor behind.
      this.reconcileHoverWithCursor();
    }
  }

  /** Create-if-needed and show the action-bar window.
   *  FIX (youcoded buddy bug): ALWAYS recompute position from the current
   *  mascot bounds before showing. The old code only computed position at
   *  creation, so dragging the mascot while the chat was closed left the
   *  re-shown icon stranded at the mascot's OLD position. */
  private showBar(): void {
    const pos = this.currentBarPosition();
    if (!this.bar || this.bar.isDestroyed()) {
      this.bar = this.deps.createBuddyWindow('bar', { x: Math.round(pos.x), y: Math.round(pos.y) });
      this.wireBarLifecycle(this.bar);
      // First reveal races page load — re-push the current CSS-visibility
      // state once the renderer is actually listening.
      this.bar.webContents.once('did-finish-load', () => {
        if (this.bar && !this.bar.isDestroyed()) {
          this.bar.webContents.send(IPC_BAR_STATE, { visible: this.barCssVisible });
        }
      });
    } else {
      this.bar.setPosition(Math.round(pos.x), Math.round(pos.y));
    }
    if (!this.bar.isVisible()) this.bar.showInactive();
  }

  private hideBar(): void {
    if (this.bar && !this.bar.isDestroyed() && this.bar.isVisible()) this.bar.hide();
  }

  /** Bar position derived from live mascot bounds; falls back to bottom-right
   *  of the primary display when the mascot is gone (mirrors old behavior). */
  private currentBarPosition(): Point {
    if (!this.mascot || this.mascot.isDestroyed()) {
      const primary = screen.getPrimaryDisplay().workArea;
      return {
        x: primary.x + primary.width - BAR_SIZE.width - 24,
        y: primary.y + primary.height - BAR_SIZE.height - 24,
      };
    }
    const mb = this.mascot.getBounds();
    const display = screen.getDisplayMatching(mb) ?? screen.getPrimaryDisplay();
    return computeBarPosition(mb, display.workArea);
  }

  private wireBarLifecycle(win: BrowserWindow): void {
    win.webContents.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit') this.hide();
    });
    win.on('closed', () => { this.bar = null; });
  }

  // True while the user intends the chat visible — set in the show paths,
  // cleared in the hide path. Guards the delayed exit-animation hide()
  // against rapid re-toggles.
  private chatOpenIntent = false;

  private createChat(): void {
    this.chatOpenIntent = true;
    // Chat is always anchored to the mascot — saved chat position was
    // intentionally dropped. User's mental model: "chat opens where my
    // buddy is." Drag the mascot, chat follows; open the chat, it's next
    // to the mascot.
    const pos = this.computeChatAnchoredPosition();
    const rounded = { x: Math.round(pos.x), y: Math.round(pos.y) };
    this.chat = this.deps.createBuddyWindow('chat', rounded);
    this.wireChatLifecycle(this.chat);
    // If a session was already chosen (via setViewedSession) before the
    // chat window was ever opened, subscribe now. Without this, the first
    // render of chat renders empty because no transcript events are
    // reaching this webContents.
    if (this.viewedSessionId) {
      this.deps.registry.subscribe(this.viewedSessionId, this.chat.webContents.id);
    }
    this.chat.show();
    this.chat.focus();
    this.barVisibility.setChatOpen(true);
    // Opening the chat is dock 'activity' — a peeking mascot slides out.
    this.dispatchDock({ type: 'activity' });
  }

  private wireMascotLifecycle(win: BrowserWindow): void {
    const save = debounce(() => {
      if (win.isDestroyed()) return;
      const { x, y } = win.getBounds();
      this.deps.setPersistedPosition('mascot', { x, y });
    }, 300);
    win.on('move', save);
    // Replay dock state on every page load: a renderer reload (crash
    // recovery, dev hot reload) resets the component's local state and there
    // is no pull-side getter — without this a docked/peeking mascot renders
    // free until the next dock transition.
    win.webContents.on('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send(IPC_MASCOT_STATE, this.dockState);
    });
    // Catch non-clean teardowns (crashes, OOM, force-kill). Clean renderer
    // reloads during `npm run dev` fire with reason === 'clean-exit' — those
    // should NOT trigger hide(), otherwise the buddy vanishes on every hot
    // reload in dev mode.
    win.webContents.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit') this.hide();
    });
    // OS-level close (force-quit via Task Manager or app exit). Clear our
    // ref so show() doesn't try to operate on a destroyed BrowserWindow and
    // hide() doesn't double-destroy.
    win.on('closed', () => { this.mascot = null; });
  }

  private wireChatLifecycle(win: BrowserWindow): void {
    // WHY no move-persistence here: chat position was written but never
    // read — the chat is always re-anchored to the mascot on show. Dead
    // code removed; persistence keys narrowed to 'mascot' in the deps.
    win.webContents.on('render-process-gone', (_evt, details) => {
      if (details.reason !== 'clean-exit') this.hide();
    });
    win.on('closed', () => {
      this.chat = null;
      // FIX: an OS-closed chat (not a toggle) used to strand the action bar
      // visible with no chat. Tell the tracker so the bar fades out (after
      // grace) unless the user is still hovering.
      this.barVisibility.setChatOpen(false);
      this.schedulePeek();
    });
  }
}

function debounce<T extends (...a: any[]) => void>(fn: T, ms: number): T {
  let t: NodeJS.Timeout | null = null;
  return ((...args: any[]) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  }) as T;
}
