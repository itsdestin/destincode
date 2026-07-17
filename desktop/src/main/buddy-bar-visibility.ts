/**
 * Decides whether the buddy action bar should be visible.
 * Inputs: per-source hover (mascot window, bar window) and chat-open state.
 * Rule (spec §4.1): visible while hovering OR while the chat is open.
 * A grace timeout on hover-loss lets the cursor cross the ~6px gap between
 * the mascot and the bar without the bar flickering out.
 * Pure logic + injected timers — unit-tested without Electron.
 */
export class BarVisibilityTracker {
  private hovered = new Set<'mascot' | 'bar'>();
  private chatOpen = false;
  private graceTimer: NodeJS.Timeout | null = null;
  private visible = false;

  constructor(
    private readonly onChange: (visible: boolean) => void,
    private readonly graceMs = 350,
  ) {}

  setHover(source: 'mascot' | 'bar', hovering: boolean): void {
    if (hovering) this.hovered.add(source);
    else this.hovered.delete(source);
    this.recompute();
  }

  setChatOpen(open: boolean): void {
    this.chatOpen = open;
    this.recompute();
  }

  wantsVisible(): boolean {
    return this.chatOpen || this.hovered.size > 0;
  }

  /** Drop all state without firing onChange — used when the buddy is torn down. */
  reset(): void {
    this.cancelGrace();
    this.hovered.clear();
    this.chatOpen = false;
    this.visible = false;
  }

  private recompute(): void {
    const want = this.wantsVisible();
    if (want) {
      // Any return-to-wanted state cancels a pending hide.
      this.cancelGrace();
      if (!this.visible) {
        this.visible = true;
        this.onChange(true);
      }
      return;
    }
    if (!this.visible || this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      // Re-check: state may have changed while the timer was pending.
      if (!this.wantsVisible()) {
        this.visible = false;
        this.onChange(false);
      }
    }, this.graceMs);
  }

  private cancelGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }
}
