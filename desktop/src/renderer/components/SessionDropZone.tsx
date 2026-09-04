// The chat area as a drop target for a session pill — 'html-drag' model only
// (Linux/Wayland; session-drag-model.ts has the measurements).
//
// WHY this exists: a labelled, discoverable target. Releasing the pill over the
// bare desktop opens a new window too (SessionStrip.handleDragEnd), but that
// gesture is invisible until tried; this box says what dropping here does. In
// the SOURCE window: "Open in a new window". In ANOTHER window: "Move here" —
// which also closes the old gap where a drop on another window's chat area
// made a THIRD window instead of landing in that one. Destin, 2026-09-04: keep
// the dashed outline.
//
// The zone is invisible until a session drag is over this window's chat area,
// so reordering in the strip never shows it. The label is decided from
// whether THIS window started the drag (module state, session-drag-model.ts):
// the browser withholds the payload until the drop, so it cannot be read.
import { useCallback, useEffect, useState } from 'react';
import type { SessionInfo } from '../../shared/types';
import { chooseTearOffModel, dragCarriesSession, readSessionDrag, localSessionDrag } from '../session-drag-model';

export function SessionDropZone({ sessions }: { sessions: SessionInfo[] }) {
  const enabled = chooseTearOffModel((window as any).claude?.platformFacts) === 'html-drag';
  // A session drag is somewhere over this window: mount the (transparent) zone
  // so it can receive its own dragover. Set from a document-level dragenter,
  // because the zone cannot receive anything before it exists.
  const [armed, setArmed] = useState(false);
  // The drag is over the zone itself: show it.
  const [hot, setHot] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const onEnter = (e: DragEvent) => { if (dragCarriesSession(e.dataTransfer)) setArmed(true); };
    // Leaving the window: dragleave with no relatedTarget. Also the end of any
    // drag, from either side, and a safety net for a drag the window never saw
    // end (the compositor cancelled it while the pointer was elsewhere).
    const onLeave = (e: DragEvent) => { if (!e.relatedTarget) { setArmed(false); setHot(false); } };
    const disarm = () => { setArmed(false); setHot(false); };
    document.addEventListener('dragenter', onEnter);
    document.addEventListener('dragleave', onLeave);
    document.addEventListener('drop', disarm);
    document.addEventListener('dragend', disarm);
    return () => {
      document.removeEventListener('dragenter', onEnter);
      document.removeEventListener('dragleave', onLeave);
      document.removeEventListener('drop', disarm);
      document.removeEventListener('dragend', disarm);
    };
  }, [enabled]);

  const mine = localSessionDrag();
  // Chrome's rule: a window's only session cannot be torn off — that would
  // close this window and open an identical one. No zone at all, so the pill
  // simply goes back; the strip's menu says why with a disabled item.
  const inert = !!mine && mine.lone;

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!dragCarriesSession(e.dataTransfer) || inert) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setHot(true);
  }, [inert]);
  const onDragLeave = useCallback(() => setHot(false), []);
  const onDrop = useCallback((e: React.DragEvent) => {
    const sessionId = readSessionDrag(e.dataTransfer);
    if (!sessionId || inert) return;
    e.preventDefault();
    e.stopPropagation();
    setHot(false);
    setArmed(false);
    const det = (window as any).claude?.detach;
    if (sessions.some((s) => s.id === sessionId)) {
      // Our own pill: a new window. The compositor places it (there are no
      // coordinates to ask for on Wayland).
      det?.openDetached?.({ sessionId });
    } else {
      // Another window's pill: main resolves the source from its registry; the
      // message carries no source, so it cannot move a session we were never
      // offered.
      det?.dragAdopt?.({ sessionId });
    }
  }, [sessions, inert]);

  if (!enabled || !armed || inert) return null;
  const label = mine ? 'Open in a new window' : 'Move here';
  return (
    <div
      data-session-drop-zone
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      // Over the chat, under the header (.header-bar is h-10): the strip must
      // keep receiving its own drops, for reorder and adopt.
      className="absolute inset-x-0 top-10 bottom-0 z-40"
    >
      {hot && (
        <div className="absolute inset-3 rounded-2xl outline-dashed outline-2 -outline-offset-2 outline-accent/70 bg-accent/10 flex items-center justify-center pointer-events-none">
          <span className="px-3 py-1.5 rounded-full bg-panel text-fg-2 text-sm font-medium shadow">{label}</span>
        </div>
      )}
    </div>
  );
}
