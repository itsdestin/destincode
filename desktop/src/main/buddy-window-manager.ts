import { BrowserWindow, screen } from 'electron';
import type { WindowRegistry } from './window-registry';
import { BAR_SIZE, computeBarPosition } from './buddy-bar-geometry';

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

const MASCOT_SIZE: Size = { width: 80, height: 80 };
const CHAT_SIZE: Size = { width: 320, height: 480 };
// Action-bar size + position math live in buddy-bar-geometry.ts (pure,
// unit-tested); main.ts imports the same BAR_SIZE so the BrowserWindow
// dimensions and the positioning math can't drift.

export interface BuddyWindowManagerDeps {
  createBuddyWindow(variant: 'mascot' | 'chat' | 'bar', opts: { x: number; y: number }): BrowserWindow;
  getPersistedPosition(key: 'mascot'): Point | null;
  setPersistedPosition(key: 'mascot', pos: Point): void;
  registry: WindowRegistry;
  mainWindow: () => BrowserWindow | null;
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

  constructor(private readonly deps: BuddyWindowManagerDeps) {}

  show(): void {
    if (this.mascot && !this.mascot.isDestroyed()) {
      this.mascot.showInactive();
      return;
    }
    const saved = this.deps.getPersistedPosition('mascot');
    const primary = screen.getPrimaryDisplay().workArea;
    const defaultPos = { x: primary.x + primary.width - 104, y: primary.y + primary.height - 104 };
    const raw = saved ?? defaultPos;
    // getDisplayMatching picks the display containing the window's bounds;
    // if the saved position is off-screen entirely, fall back to primary.
    const display = screen.getDisplayMatching({ ...raw, ...MASCOT_SIZE }) ?? screen.getPrimaryDisplay();
    const clamped = clampToWorkArea(raw, MASCOT_SIZE, display.workArea);
    this.mascot = this.deps.createBuddyWindow('mascot', clamped);
    this.wireMascotLifecycle(this.mascot);
    this.mascot.showInactive();
  }

  hide(): void {
    if (this.bar && !this.bar.isDestroyed()) this.bar.destroy();
    if (this.chat && !this.chat.isDestroyed()) this.chat.destroy();
    if (this.mascot && !this.mascot.isDestroyed()) this.mascot.destroy();
    this.bar = null;
    this.chat = null;
    this.mascot = null;
    // Reset so a subsequent show() + setViewedSession(sameId) doesn't
    // early-return in setViewedSession and skip re-subscription.
    this.viewedSessionId = null;
  }

  toggleChat(): void {
    if (!this.chat || this.chat.isDestroyed()) {
      this.createChat();
      this.showBar();
      return;
    }
    if (this.chat.isVisible()) {
      this.chat.hide();
      this.hideBar();
    } else {
      // Re-anchor to current mascot position before showing — the user may
      // have dragged the mascot while the chat was hidden, and the chat
      // should open "wherever the icon is" rather than at its stale last
      // position.
      const pos = this.computeChatAnchoredPosition();
      this.chat.setPosition(Math.round(pos.x), Math.round(pos.y));
      this.chat.show();
      this.showBar();
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
    // Top-align chat with the mascot (chat.y === mascot.y) so the buddy
    // icon sits next to the chat's header, not its midpoint or bottom.
    const y = mb.y;
    const rightX = mb.x + mb.width + 12;
    const rightFits = rightX + CHAT_SIZE.width <= wa.x + wa.width;
    const raw = rightFits
      ? { x: rightX, y }
      : { x: mb.x - CHAT_SIZE.width - 12, y };
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
    // Bar follows its own visibility (not the chat's): in the hover-reveal
    // model the bar can be visible without the chat. Recompute from scratch
    // on visible: if the mascot lands on a bottom edge the bar needs to
    // flip above automatically.
    if (this.bar && !this.bar.isDestroyed() && this.bar.isVisible()) {
      const pos = this.currentBarPosition();
      this.bar.setPosition(Math.round(pos.x), Math.round(pos.y));
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

  private createChat(): void {
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
  }

  private wireMascotLifecycle(win: BrowserWindow): void {
    const save = debounce(() => {
      if (win.isDestroyed()) return;
      const { x, y } = win.getBounds();
      this.deps.setPersistedPosition('mascot', { x, y });
    }, 300);
    win.on('move', save);
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
      // visible with no chat. Drop the bar too until the next reveal.
      this.hideBar();
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
