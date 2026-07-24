import React from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { CloseButton } from './ui';

/**
 * The centered settings sub-popup (change 30).
 *
 * Seven of these were hand-rolled in SettingsPanel.tsx — Sound, Appearance,
 * Buddy Floater, Remote Access, Session Defaults, Package Tier, Connect to
 * Desktop — each repeating the identical portal + <Scrim layer={2}> + a
 * `layer-surface fixed z-[61]` panel centered with the same transform trick, and
 * each with its OWN hand-drawn ✕. The ledger read this as "seven OverlayPanel
 * swaps"; it is really one shell used seven times, which is why it lives here
 * instead of being inlined seven more times.
 *
 * Two things it fixes beyond the dedup:
 *  - `z-[61]` was a raw literal duplicating Overlay.tsx's CONTENT_Z[2]. Layer
 *    numbers now come from one place (design rule 11).
 *  - The seven `<button>✕</button>` copies become <CloseButton>, so they pick up
 *    the standard hover + focus ring and an accessible name they mostly lacked.
 *
 * Header is optional. Callers that own their whole surface (Appearance hands the
 * panel to ThemeScreen; Remote Access swaps in SettingsExplainer) pass no title
 * and render their own chrome.
 */

export type SettingsPopupProps = {
  open: boolean;
  onClose: () => void;
  /** Omit to render children with no header — the caller supplies its own. */
  title?: string;
  /** Controls rendered to the LEFT of the close button (e.g. an (i) button). */
  headerActions?: React.ReactNode;
  /** CSS width, e.g. `min(380px, 88vw)`. Required — the seven differ. */
  width: string;
  /** Fixed height, e.g. `min(600px, 80vh)`. Wins over maxHeight when set. */
  height?: string;
  /** Defaults to 80vh, which is what six of the seven used. */
  maxHeight?: string;
  /** The caller's outside-click ref. Every one of these popups wires its own. */
  panelRef?: React.Ref<HTMLDivElement>;
  /** Extra classes on the panel (e.g. `flex flex-col`). */
  className?: string;
  children: React.ReactNode;
};

export function SettingsPopup({
  open,
  onClose,
  title,
  headerActions,
  width,
  height,
  maxHeight = '80vh',
  panelRef,
  className = '',
  children,
}: SettingsPopupProps) {
  if (!open) return null;

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        ref={panelRef}
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-label={title}
        className={`fixed ${className}`.trim()}
        style={{
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          width,
          // A fixed height and a max-height are mutually exclusive here: the two
          // callers that set `height` want the panel to fill regardless of
          // content, the rest want it to hug content up to a ceiling.
          ...(height ? { height } : { maxHeight }),
        }}
      >
        {title && (
          // h2 for all seven. One of them (Package Tier) was an h3, which gave
          // screen readers a heading outline implying it nested under the
          // others — they are siblings, so they announce at the same level.
          <div className="flex items-center justify-between px-4 py-3 border-b border-edge shrink-0">
            <h2 className="text-sm font-bold text-fg">{title}</h2>
            <div className="flex items-center gap-1">
              {headerActions}
              <CloseButton onClick={onClose} label={`Close ${title}`} />
            </div>
          </div>
        )}
        {children}
      </OverlayPanel>
    </>,
    document.body,
  );
}
