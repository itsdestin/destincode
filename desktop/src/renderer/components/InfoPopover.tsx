import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Reusable "(i)" info popover for settings surfaces. A small circle-i button
// that click-toggles a portaled panel with plain-language explanatory content.
// Click-based (not hover) so the popup semantics are explicit and it works on
// touch; portaled to document.body so it escapes the settings popup's own
// overflow/scroll container. Closes on outside-click and ESC.
//
// Styling matches SkipPermissionsInfoTooltip's panel (bg-panel/border-edge/
// shadow) so the app's info bubbles read consistently. Used by the Model
// Providers popup to explain what each engine/provider is.
export function InfoPopover({
  label,
  title,
  children,
  className = '',
}: {
  /** Accessible name for the trigger (e.g. "About OpenRouter"). */
  label: string;
  /** Optional bold heading rendered at the top of the panel. */
  title?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Anchor the panel to the button. Measured after open so the DOM node exists.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    // Centre horizontally on the button, drop just below it.
    setPos({ x: rect.left + rect.width / 2, y: rect.bottom + 6 });
  }, [open]);

  // Close on outside-click and ESC while open.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (btnRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } };
    // Capture phase so we settle before the settings popup's own ESC handler.
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        aria-label={label}
        aria-expanded={open}
        className={`inline-flex items-center justify-center shrink-0 text-fg-muted hover:text-fg transition-colors ${className}`}
      >
        <svg className="w-3.5 h-3.5 opacity-60 hover:opacity-100 transition-opacity" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden>
          <circle cx="12" cy="12" r="9" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v5" />
          <circle cx="12" cy="8" r="0.5" fill="currentColor" />
        </svg>
      </button>

      {open && createPortal(
        <div
          ref={panelRef}
          style={{ left: pos.x, top: pos.y, transform: 'translateX(-50%)' }}
          // Above the L2 settings popup (z-61) so the bubble is never trapped
          // behind the panel it explains.
          className="fixed z-[9999] w-72 max-w-[calc(100vw-1.5rem)]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="bg-panel border border-edge rounded-lg shadow-lg p-3 text-left">
            {title && <p className="text-xs font-semibold text-fg mb-1.5">{title}</p>}
            <div className="text-[11px] text-fg-2 leading-snug space-y-2">{children}</div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}
