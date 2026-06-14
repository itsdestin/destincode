// ProjectDetailOverlay — shared centered detail host for Project View (Task 2.4).
// Generic, content-agnostic shell: a scrim + large centered panel with a thin
// header (title + close) and a scrollable body slot. Reused by the artifact
// viewer (Task 2.4), the conversation preview (Task 3.2), and the context
// editor (Task 4.4) — so it MUST NOT bake in any artifact-specific logic.
import React from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';

interface ProjectDetailOverlayProps {
  title: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
}

export function ProjectDetailOverlay({ title, onClose, children }: ProjectDetailOverlayProps) {
  // ESC-close via the centralized LIFO stack (see docs/PITFALLS.md → Keyboard
  // Routing). `true` because the overlay is only mounted while it should be
  // dismissible — mounting/unmounting is the open/close gate.
  useEscClose(true, onClose);

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        className="fixed inset-2 sm:inset-8 md:inset-16 flex flex-col"
        role="dialog"
        aria-modal
      >
        {/* Thin header: title (left) + close (right) */}
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-edge shrink-0">
          <div className="font-mono text-xs text-fg-2 truncate flex-1 min-w-0">
            {title}
          </div>
          <button
            type="button"
            className="text-fg-muted hover:text-fg px-1 shrink-0"
            onClick={onClose}
            title="Close"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Scrollable body slot */}
        <div className="flex-1 overflow-auto min-h-0">{children}</div>
      </OverlayPanel>
    </>
  );
}
