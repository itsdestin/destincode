import { getPlatform } from '../../platform';
import { Button } from '../ui';
import { EDIT_MAX_BYTES, FULL_READ_MAX_BYTES } from '../../../shared/artifacts/editable-path-policy';

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Shown above a text viewer that is holding only the first EDIT_MAX_BYTES of a
 * larger file.
 *
 * It is a flex SIBLING of the viewer box (shrink-0), exactly like the conflict
 * and save-error banners already are — deliberately NOT `sticky`, and NOT
 * wrapped in a new scroll container. The viewer box owns the only scroll
 * context, so a banner outside it cannot scroll away, which is the whole
 * requirement: a partial view that looks complete after two screens of
 * scrolling is the failure mode of this approach.
 *
 * States a size because the size is information the user can act on — never as
 * the reason the app "won't" do something (docs/error-message-standards.md).
 */
export function PartialFileBanner({ sizeBytes, onLoadFull, onOpenExternally }: {
  sizeBytes: number;
  onLoadFull: () => void;
  onOpenExternally: () => void;
}) {
  const canLoadFull = sizeBytes <= FULL_READ_MAX_BYTES;
  // shell.openPath is desktop-only — the remote shim stubs it as a no-op and
  // Android has no handler, so the button would silently do nothing there.
  // Offering a button that does nothing is worse than offering none.
  const isElectron = getPlatform() === 'electron';
  return (
    <div className="shrink-0 flex items-center gap-3 p-3 text-sm border-b border-border bg-bg-2 text-fg-2">
      <span>Showing the first {mb(EDIT_MAX_BYTES)} of {mb(sizeBytes)}. Read-only.</span>
      {canLoadFull && <Button size="sm" onClick={onLoadFull}>Load the whole file</Button>}
      {!canLoadFull && isElectron && (
        <Button size="sm" onClick={onOpenExternally}>Open in default app</Button>
      )}
    </div>
  );
}
