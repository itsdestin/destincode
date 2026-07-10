// desktop/src/renderer/components/ImportProjectModal.tsx
// Consent + name-confirm modal shared by BOTH spec-§3 import flows (row action
// and folder-picker). The move is consequence-gated: the copy spells out that
// the folder itself MOVES (old path stops existing) before anything happens.
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';

interface Props {
  sourcePath: string;
  defaultName: string;
  onClose: () => void;
  /** Called with the new project path after a successful import */
  onDone: (newPath: string) => void;
}

export default function ImportProjectModal({ sourcePath, defaultName, onClose, onDone }: Props) {
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Honesty rule (spec decision 6): when global Sync is off, every sync
  // promise softens. This modal is reached from the Project View hero's "Turn
  // on sync" button DIRECTLY (not only via AddProjectModal), so it must carry
  // the note itself. null = unknown (Android has no syncspaces handlers) → no
  // note, matching AddProjectModal's convention.
  const [syncEnabled, setSyncEnabled] = useState<boolean | null>(null);
  // Post-success state: when the move produced warnings we keep the modal open
  // to show them (closing instantly would hide "delete the old copy manually").
  const [doneWarnings, setDoneWarnings] = useState<string[] | null>(null);
  const [donePath, setDonePath] = useState<string | null>(null);

  // cancelledRef — prevent setState after unmount for the async import chain
  // (mirrors RatingSubmitModal): if the modal is closed while the move is in
  // flight, the late resolve must not setState on an unmounted component.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    // Fetch Sync's on/off state so the honesty note can render. catch → null
    // (unknown) shows no note — same convention AddProjectModal uses.
    (window as any).claude.syncSpaces.status()
      .then((s: any) => { if (!cancelledRef.current) setSyncEnabled(!!s?.enabled); })
      .catch(() => { if (!cancelledRef.current) setSyncEnabled(null); });
    return () => { cancelledRef.current = true; };
  }, []);

  // In-flight latch — a ref, not state, because held-Enter key-repeat can fire
  // confirm() twice BEFORE the `busy` re-render lands, and the folder move is
  // non-idempotent (a second concurrent call would race the first).
  const inFlightRef = useRef(false);

  // After a successful move, EVERY dismissal path (ESC, Scrim click, Done
  // button) must go through onDone so the parent reconciles the folder list —
  // the old path no longer exists on disk. Only the pre-move state may cancel
  // via plain onClose.
  const dismiss = doneWarnings && donePath ? () => onDone(donePath) : onClose;

  // ESC is gated on !busy so it matches the Scrim/Cancel guards — dismissing
  // mid-move would unmount the modal and lose the success/warnings handoff.
  useEscClose(!busy, dismiss);

  const confirm = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    // Ref latch catches double-fires that land before the busy state re-renders.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setError(null);
    // try/catch: on Android the shim has no syncspaces handlers and rejects
    // after 30s — surface inline, never as an unhandled rejection.
    try {
      const r = await (window as any).claude.syncSpaces.importProject(sourcePath, trimmed);
      if (cancelledRef.current) return;
      if (r?.ok) {
        if (r.warnings?.length) { setDoneWarnings(r.warnings); setDonePath(r.path); }
        else onDone(r.path);
      } else {
        setError(r?.error ?? 'Could not move the folder');
      }
    } catch (err: any) {
      if (cancelledRef.current) return;
      setError(String(err?.message ?? err));
    } finally {
      inFlightRef.current = false;
      if (!cancelledRef.current) setBusy(false);
    }
  }, [name, busy, sourcePath, onDone]);

  // Same note copy/styling AddProjectModal uses — shown only in the pre-move
  // consent state (once the move succeeds the folder IS in the sync home).
  const syncOffNote = syncEnabled === false && (
    <div className="mt-3 rounded-md border border-edge bg-inset px-3 py-2 text-xs text-fg-dim" role="note">
      <span className="text-fg-2 font-medium">Sync is currently turned off.</span>{' '}
      This project will start syncing once you turn on Sync in Settings.
    </div>
  );

  return (
    <>
      <Scrim layer={2} onClick={busy ? undefined : dismiss} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal
        aria-labelledby="import-project-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[26rem] max-w-[calc(100vw-2rem)] p-4"
      >
        {doneWarnings ? (
          <>
            <div id="import-project-title" className="text-sm font-medium text-fg">Folder moved</div>
            <div className="mt-2 text-xs text-fg-2">The folder now lives at <span className="text-fg break-all">{donePath}</span> and will sync across your devices. A couple of things need your attention:</div>
            <ul className="mt-2 space-y-1 text-xs text-fg-dim list-disc pl-4">
              {doneWarnings.map((w, i) => <li key={i}>{w}</li>)}
            </ul>
            <div className="mt-4 flex justify-end">
              <button onClick={() => onDone(donePath!)} className="text-sm px-3 py-1 rounded bg-accent text-on-accent">Done</button>
            </div>
          </>
        ) : (
          <>
            <div id="import-project-title" className="text-sm font-medium text-fg">Move and sync this folder?</div>
            <div className="mt-2 text-xs text-fg-2">
              YouCoded will <span className="text-fg">move</span> <span className="break-all">{sourcePath}</span> to{' '}
              <span className="text-fg break-all">~/YouCoded/Projects/{name.trim() || '…'}/</span> so it can sync across your devices.
            </div>
            <div className="mt-1 text-xs text-fg-dim">
              The folder itself moves — anything pointing at the old location (shortcuts, open terminals, editors) will need the new path.
            </div>
            <label className="block mt-3 text-[10px] uppercase tracking-wide text-fg-muted">Project name</label>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void confirm(); }}
              className="mt-1 w-full bg-inset text-fg text-sm rounded px-2 py-1 border border-edge-dim focus:border-accent outline-none"
              autoFocus
            />
            {error && <div role="alert" className="mt-2 text-xs text-red-500">{error}</div>}
            {syncOffNote}
            <div className="mt-4 flex justify-end gap-2">
              <button onClick={onClose} disabled={busy} className="text-sm px-3 py-1 rounded text-fg-dim hover:text-fg hover:bg-inset transition-colors">Cancel</button>
              <button onClick={() => void confirm()} disabled={busy || !name.trim()} className="text-sm px-3 py-1 rounded bg-accent text-on-accent disabled:opacity-50">
                {busy ? 'Moving…' : 'Move and sync'}
              </button>
            </div>
          </>
        )}
      </OverlayPanel>
    </>
  );
}
