import type { ArtifactViewProps } from './types';

export function BinaryFallback({ path, absolutePath }: ArtifactViewProps) {
  const openExternally = () => {
    // Open with the OS default app via shell.openPath (HTML→browser, etc.).
    (window.claude as any).shell?.openPath?.(absolutePath);
  };
  return (
    <div className="flex flex-col items-center justify-center h-full p-8 text-fg-muted">
      <p className="mb-4">Cannot preview this file type.</p>
      <p className="mb-4 font-mono text-sm">{path}</p>
      <button
        className="px-4 py-2 rounded bg-accent text-on-accent"
        onClick={openExternally}
      >
        Open Externally
      </button>
    </div>
  );
}
