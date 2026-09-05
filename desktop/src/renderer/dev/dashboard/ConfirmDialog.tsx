import { Button, Dialog } from '../../components/ui';

// Wraps the shared Dialog shell, which is how every other confirm flow in this
// codebase does it (DiscardConfirmDialog, UnsavedChangesDialog, CloseSessionPrompt).
// `layer={3}` is the critical layer: a heavier scrim, sitting above ordinary
// popups so a spend confirmation cannot get lost behind the thing it confirms.
export function ConfirmDialog({ open, title, body, confirmLabel, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} layer={3}>
      <p className="whitespace-pre-line text-sm text-fg-2">{body}</p>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
        <Button variant="danger" size="sm" onClick={onConfirm}>{confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
