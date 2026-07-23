// L3 destructive confirm for the git surface (spec section 5). Uses the shared
// overlay primitives — never a hand-rolled bg-black/40 (react-renderer rule).
// The copy states EXACTLY what happens; the failure path (surfaced by the
// caller) carries real git stderr.
import React, { useEffect } from 'react';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { Button } from '../ui';

export interface DiscardConfirmDialogProps {
  fileName: string;
  /** true = HEAD has no committed copy (untracked OR staged-new) — the file
   *  goes to the OS trash instead of being restored from HEAD */
  willTrash: boolean;
  onConfirm: () => void;  // caller runs git.discard and closes
  onCancel: () => void;
}

export function DiscardConfirmDialog({ fileName, willTrash, onConfirm, onCancel }: DiscardConfirmDialogProps) {
  // Capture-phase Escape = cancel, same pattern as UnsavedChangesDialog — the
  // drawer's own ESC cascade must not fire underneath an open dialog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [onCancel]);

  return (
    <Scrim layer={3} onClick={onCancel} className="flex items-center justify-center">
      <OverlayPanel
        layer={3}
        destructive
        role="alertdialog"
        aria-modal
        aria-label={willTrash ? 'Delete file' : 'Discard changes'}
        className="p-4 max-w-sm w-full mx-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-medium text-fg mb-1">
          {willTrash ? `Move “${fileName}” to the system trash?` : `Restore “${fileName}” to its last committed state?`}
        </div>
        <div className="text-sm text-fg-2 mb-4 break-all">
          {willTrash
            ? 'Git has no committed copy of this file. It goes to the trash, not permanent deletion.'
            : 'Your uncommitted edits to this file will be lost. Staged and unstaged changes are both restored from HEAD.'}
        </div>
        <div className="flex gap-2 justify-end">
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button variant="danger" onClick={onConfirm}>{willTrash ? 'Delete file' : 'Discard changes'}</Button>
        </div>
      </OverlayPanel>
    </Scrim>
  );
}
