import React from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel, CONTENT_Z, type OverlayLayer } from '../overlays/Overlay';
import { CloseButton } from './CloseButton';
import { useScrollFade } from '../../hooks/useScrollFade';

/**
 * D1 — the one dialog shell.
 *
 * Supersedes `SettingsPopup.tsx`, which had 7 callers against 49 files that
 * hand-rolled `createPortal` + `<Scrim>` + `<OverlayPanel>` themselves. Between
 * them those shipped ~18 distinct widths, 7 different max-heights, 2 competing
 * centering techniques and 4 header paddings, for one thing.
 *
 * Three properties this owns that the old shell left to the caller, each because
 * leaving it to the caller demonstrably failed:
 *
 * 1. THE SCROLL BODY. SettingsPopup set maxHeight but left the panel a plain
 *    block, so callers had to remember `className="flex flex-col"` AND wrap
 *    their own `.scroll-fade`. Two of its seven forgot (Sound, Session
 *    Defaults); the symptom is a dialog that clips with no way to reach the
 *    bottom. Destin hit it in Sound on 2026-07-26. Pass `scrollBody={false}`
 *    only when the caller genuinely owns its whole surface.
 *
 * 2. CENTERING. An outer flex wrapper, not `position:fixed` + transform. The
 *    transform technique breaks the height constraint a flex-1 scroll region
 *    needs — that is documented at StatusBar.tsx and was rediscovered
 *    independently by ResumeBrowser. One technique, chosen because it is the one
 *    that works with a bounded scroll body.
 *
 * 3. HEIGHT AS A CEILING. There is no `height` prop, so a fixed height is not
 *    expressible. A fixed `h-` is what makes ContextPopup jump to full height
 *    the moment its explainer opens.
 */

/** The width ladder. No bespoke widths — round to the nearest rung. */
export const DIALOG_WIDTHS = {
  sm: 'min(340px, 88vw)',
  md: 'min(420px, 88vw)',
  lg: 'min(560px, 88vw)',
  xl: 'min(820px, 88vw)',
} as const;

export type DialogSize = keyof typeof DIALOG_WIDTHS;

export type DialogProps = {
  open: boolean;
  onClose: () => void;
  /** Omit ONLY when the caller renders its own header (see `scrollBody`). */
  title?: string;
  /** Small second line under the title — e.g. About's version string. */
  subtitle?: React.ReactNode;
  /** Rendered to the LEFT of the close button — e.g. an (i) explainer button. */
  headerActions?: React.ReactNode;
  /**
   * L2 popup (default) or L3 critical — a destructive confirmation, which gets
   * a heavier scrim and sits above ordinary popups so it cannot be lost behind
   * the thing it is confirming.
   */
  layer?: Extract<OverlayLayer, 2 | 3>;
  /** Marks the panel destructive, which the theme uses to tint its border. */
  destructive?: boolean;
  size?: DialogSize;
  /** Ceiling only. Defaults to 80vh. There is deliberately no `height`. */
  maxHeight?: string;
  /**
   * Floor, for dialogs that must not collapse as the user moves between
   * sub-views (Appearance, Remote Access). This is the honest version of the
   * fixed height those two used to set: it stops the panel shrinking without
   * letting it ignore the viewport. The banned case is a height that changes
   * with the view — that is the ContextPopup jump.
   */
  minHeight?: string;
  /** For callers wiring their own outside-click detection. */
  panelRef?: React.Ref<HTMLDivElement>;
  /** Extra classes on the panel. Layout classes are owned here — prefer not to. */
  className?: string;
  /**
   * Set false when the caller owns its whole surface and supplies its own
   * scroll region (Appearance hands the panel to ThemeScreen; Remote Access
   * swaps in SettingsExplainer). Default true.
   */
  scrollBody?: boolean;
  /** Accessible name when there is no visible title. */
  'aria-label'?: string;
  children: React.ReactNode;
};

export function Dialog({
  open,
  onClose,
  title,
  subtitle,
  headerActions,
  layer = 2,
  destructive,
  size = 'md',
  maxHeight = '80vh',
  minHeight,
  panelRef,
  className = '',
  scrollBody = true,
  children,
  ...aria
}: DialogProps) {
  // Dialog owns the scroll region, so it owns the edge-fade hook too. Callers
  // used to wire their own useScrollFade at the body they supplied; leaving it
  // to them now would silently drop the fades on every migrated dialog.
  // Declared before the early return -- hooks must run unconditionally.
  const scrollRef = useScrollFade<HTMLDivElement>();

  if (!open) return null;

  return createPortal(
    <>
      <Scrim layer={layer} onClick={onClose} />
      {/* Outer wrapper centers and carries the stacking; the panel then runs at
          position:relative / z-index:auto. pointer-events-none lets clicks fall
          through to the Scrim beneath, which is what closes on outside-click. */}
      <div
        className="fixed inset-0 flex items-center justify-center p-4 pointer-events-none"
        style={{ zIndex: CONTENT_Z[layer] }}
      >
        <OverlayPanel
          ref={panelRef}
          layer={layer}
          destructive={destructive}
          role="dialog"
          aria-modal={true}
          aria-label={title ?? aria['aria-label']}
          className={`w-full flex flex-col overflow-hidden pointer-events-auto ${className}`.trim()}
          style={{
            position: 'relative',
            zIndex: 'auto',
            maxWidth: DIALOG_WIDTHS[size],
            maxHeight,
            ...(minHeight ? { minHeight } : {}),
          }}
        >
          {title && (
            // h2, matching SettingsPopup. Section labels inside the body are h3
            // (K1), so an h3 title would announce them as its siblings rather
            // than its children.
            <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-fg">{title}</h2>
                {subtitle && <p className="text-3xs text-fg-muted mt-0.5">{subtitle}</p>}
              </div>
              <div className="flex items-center gap-1">
                {headerActions}
                <CloseButton onClick={onClose} label={`Close ${title}`} />
              </div>
            </div>
          )}
          {scrollBody ? (
            // Unpadded scroll region so the fade pseudo-elements sit flush with
            // the panel edge; padding lives on the inner track.
            <div ref={scrollRef} className="scroll-fade flex-1">
              <div className="px-4 py-4 space-y-5">{children}</div>
            </div>
          ) : (
            children
          )}
        </OverlayPanel>
      </div>
    </>,
    document.body,
  );
}
