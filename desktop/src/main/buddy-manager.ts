import type { BrowserWindow, WebContents } from 'electron';

// WHY: main.ts must not care whether the buddy is three windows (Win/mac/X11)
// or one overlay window (Linux Wayland). Everything main.ts needs is here.
export interface BuddyManager {
  show(): void;
  hide(): void;
  dismiss(): void;
  getStatus(): { dismissed: boolean; visible: boolean };
  toggleChat(): void;
  setViewedSession(sessionId: string): void;
  getViewedSession(): string | null;
  setAttentionNeeded(needed: boolean): void;
  isBuddyWindow(win: BrowserWindow): boolean;
  /** Windows to hide while capturing the desktop (capture-icon flow). */
  captureWindows(): BrowserWindow[];
  /** WebContents that hosts the buddy chat — target for BUDDY_ATTACH_FILE. */
  chatWebContents(): WebContents | null;
  /** Per-frame drag path used ONLY by the three-window model; overlay no-ops. */
  moveMascot(targetX: number, targetY: number): void;
  dragEnded(): void;
}

// WHY: one decision point, pure and testable. The overlay exists because
// Wayland forbids window positioning; everywhere else keeps three windows.
export function chooseBuddyStrategy(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>
): 'overlay' | 'windows' {
  if (platform !== 'linux') return 'windows';
  const wayland = env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY;
  if (env.YOUCODED_BUDDY_STRATEGY === 'windows' || env.YOUCODED_BUDDY_STRATEGY === 'overlay') {
    return env.YOUCODED_BUDDY_STRATEGY; // dev/test override + user escape hatch
  }
  return wayland ? 'overlay' : 'windows';
}
