import React, { useEffect } from 'react';
import { OverlayPanel } from '../overlays/Overlay';

/**
 * Transient feedback (change 44, §1.8).
 *
 * Replaces three uncoordinated systems: the App-global toast (hand-rolled
 * bg-panel/border-edge/shadow-lg with a manual setTimeout at EVERY call site),
 * LikeButton's local mini-toast (different size, radius, and z), and the
 * marketplace role="status" strips.
 *
 * The dismiss timer lives here on purpose — call sites kept re-implementing it,
 * and each one was a chance to leak a timer across unmount.
 *
 * Border/shadow/background all come from .layer-surface via OverlayPanel, which
 * also owns the z-index (design rule 11 — Overlay.tsx is the only z authority).
 */

export type ToastTone = 'default' | 'error';

export type ToastProps = {
  message: React.ReactNode;
  onDismiss: () => void;
  tone?: ToastTone;
  /** global = centered above the input bar. anchored = pinned above its
   *  relatively-positioned parent (LikeButton). */
  variant?: 'global' | 'anchored';
  /** Auto-dismiss delay. Pass null to require an explicit dismiss. */
  durationMs?: number | null;
};

export function Toast({
  message,
  onDismiss,
  tone = 'default',
  variant = 'global',
  durationMs = 3000,
}: ToastProps) {
  useEffect(() => {
    if (durationMs == null) return;
    const id = setTimeout(onDismiss, durationMs);
    return () => clearTimeout(id);
    // Re-arm when the message changes so a second toast gets its own full
    // window rather than inheriting the first one's remaining time.
  }, [message, durationMs, onDismiss]);

  return (
    <OverlayPanel
      layer={4}
      role="status"
      aria-live="polite"
      className={[
        // rounded-lg overrides .layer-surface's radius-xl — a toast is a control-
        // sized surface, not a panel.
        'flex items-center gap-2 px-4 py-2 rounded-lg text-sm text-fg pointer-events-none',
        variant === 'global'
          ? 'fixed bottom-16 left-1/2 -translate-x-1/2'
          : 'absolute bottom-full right-0 mb-1 whitespace-nowrap',
      ].join(' ')}
    >
      {tone === 'error' && (
        // The state family's failure mark (§1.6) — same dot ErrorState uses.
        <span className="w-1.5 h-1.5 rounded-full bg-destructive shrink-0" aria-hidden="true" />
      )}
      {message}
    </OverlayPanel>
  );
}

export default Toast;
