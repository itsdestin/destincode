import type { ArtifactViewProps } from './types';
import { getPlatform } from '../../platform';

export function BinaryFallback({ path, absolutePath }: ArtifactViewProps) {
  // shell.openPath is desktop-only — the remote shim stubs it as a no-op and
  // Android has no handler, so showing the button there would silently do
  // nothing. Gate on the platform like SessionDrawer's toolbar does.
  const isElectron = getPlatform() === 'electron';
  const openExternally = () => {
    // Open with the OS default app via shell.openPath (HTML→browser, etc.).
    (window.claude as any).shell?.openPath?.(absolutePath);
  };
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-fg-muted">
      <p className="mb-4">Cannot preview this file type.</p>
      <p className="mb-4 font-mono text-sm">{path}</p>
      {isElectron && (
        <button
          className="px-4 py-2 rounded bg-accent text-on-accent"
          onClick={openExternally}
        >
          Open Externally
        </button>
      )}
    </div>
  );
}
