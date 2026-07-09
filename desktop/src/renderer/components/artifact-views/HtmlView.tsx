import type { ArtifactViewProps } from './types';

// HtmlView — full-size interactive preview of an HTML artifact.
//
// Renders the file's content inline via `srcDoc` (the app's CSP blocks loading a
// `file://` document into an iframe, so we feed the already-read HTML string the
// same way the card thumbnail does). `allow-scripts` lets self-contained mockups
// (incl. Tailwind-CDN pages) render and run; we omit `allow-same-origin` so the
// frame stays an opaque origin and can't script the app. Artifacts are the
// user's own generated files, so script execution for a faithful preview is the
// right trade-off. Caveat of srcDoc: pages that pull in *relative* local assets
// (sibling CSS/images) won't resolve those — self-contained pages render fully.
export function HtmlView({ content }: ArtifactViewProps) {
  if (content === null) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-fg-muted">
        Loading…
      </div>
    );
  }
  return (
    <iframe
      srcDoc={content}
      sandbox="allow-scripts allow-popups allow-forms"
      className="w-full h-full border-0 bg-white"
      title="HTML preview"
    />
  );
}
