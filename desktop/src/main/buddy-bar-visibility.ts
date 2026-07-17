/**
 * Decides whether the buddy action bar should be visible.
 *
 * Rule (Destin 2026-07-16): visible IFF the chat is open. The bar used to also
 * reveal on hover (spec §4.1), but its three actions are only useful alongside
 * an open chat, so a hover-reveal fired constantly for nothing — the cursor
 * merely passing over the buddy summoned it. Clicking the mascot toggles the
 * chat, and the bar now rides along with it. That also makes the reveal a
 * deliberate moment, which is what the staggered button pop-in animates
 * (styles/buddy.css → buddy-btn-pop).
 *
 * Hover is still TRACKED, just no longer wired to visibility: `isEngaged()`
 * feeds the dock's idle→peek timer so a buddy under the cursor doesn't slink
 * off the screen edge mid-hover.
 *
 * Pure logic — unit-tested without Electron.
 */
export class BarVisibilityTracker {
  private hovered = new Set<'mascot' | 'bar'>();
  private chatOpen = false;
  private visible = false;

  constructor(private readonly onChange: (visible: boolean) => void) {}

  setHover(source: 'mascot' | 'bar', hovering: boolean): void {
    if (hovering) this.hovered.add(source);
    else this.hovered.delete(source);
    // Deliberately no recompute: hover does not move the bar any more.
  }

  setChatOpen(open: boolean): void {
    this.chatOpen = open;
    this.recompute();
  }

  /** The bar's visibility rule. */
  wantsVisible(): boolean {
    return this.chatOpen;
  }

  /** "The user is currently busy with the buddy" — hover OR an open chat.
   *  Distinct from wantsVisible(): hover keeps a docked buddy from peeking
   *  but no longer reveals the bar. */
  isEngaged(): boolean {
    return this.chatOpen || this.hovered.size > 0;
  }

  /** Drop all state without firing onChange — used when the buddy is torn down. */
  reset(): void {
    this.hovered.clear();
    this.chatOpen = false;
    this.visible = false;
  }

  private recompute(): void {
    const want = this.wantsVisible();
    if (want === this.visible) return;
    this.visible = want;
    this.onChange(want);
  }
}
