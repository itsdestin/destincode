// ProjectDetailOverlay — shared centered detail host for Project View (Task 2.4).
// Generic, content-agnostic shell: a scrim + large centered panel. The header
// carries the title (left) plus a `tools` slot for content-specific action
// buttons and the close button (right); an optional `meta` strip sits below the
// header (bg-well) for content-specific metadata; the body slot scrolls. Layout
// matches the prototype's renderDetail() (header → meta strip → body). Reused by
// the artifact viewer (Task 2.4), the conversation preview (Task 3.2), and the
// context editor (Task 4.4) — so it MUST NOT bake in any artifact-specific logic;
// each consumer supplies its own `tools` / `meta` / body.
import React from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { useEscClose } from '../../hooks/use-esc-close';
import { CloseIcon } from './icons';

interface ProjectDetailOverlayProps {
  title: React.ReactNode;
  onClose: () => void;
  // Content-specific action buttons rendered in the header, left of the close
  // button (e.g. Edit/Save, Reveal, Copy path, Resume). Omit for a chrome-only
  // header.
  tools?: React.ReactNode;
  // Optional meta strip below the header (e.g. "N messages · 2d ago · read-only").
  // The strip is only rendered when this is provided.
  meta?: React.ReactNode;
  children: React.ReactNode;
}

export function ProjectDetailOverlay({ title, onClose, tools, meta, children }: ProjectDetailOverlayProps) {
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
        {/* Header: title (left) + tools + close (right). */}
        <header className="flex items-center justify-between gap-3 px-4 py-3 border-b border-edge shrink-0">
          <span className="text-[15px] font-semibold text-fg truncate min-w-0">{title}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {tools}
            <button
              type="button"
              className="ml-1 text-fg-dim hover:text-fg w-7 h-7 inline-flex items-center justify-center shrink-0"
              onClick={onClose}
              title="Close"
              aria-label="Close"
            >
              <CloseIcon size={17} />
            </button>
          </div>
        </header>

        {/* Meta strip — only when the consumer supplies metadata. */}
        {meta != null && (
          <div className="flex items-center gap-2 px-4 py-1.5 text-[11.5px] text-fg-muted border-b border-edge-dim bg-well shrink-0">
            {meta}
          </div>
        )}

        {/* Scrollable body slot */}
        <div className="flex-1 overflow-auto min-h-0">{children}</div>
      </OverlayPanel>
    </>
  );
}
