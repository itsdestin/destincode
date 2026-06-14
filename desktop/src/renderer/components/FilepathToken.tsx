import { useArtifactOptional } from '../state/ArtifactContext';

interface Props {
  path: string;
  sessionId: string;
}

// Inline SVG glyphs (not emoji) so the icon inherits `currentColor` and matches
// the app's lucide-style iconography. Image files get the picture glyph; every
// other type gets the document glyph.
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

function FileGlyph({ ext }: { ext: string }) {
  const common = {
    width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const, className: 'text-fg-dim shrink-0',
  };
  if (IMAGE_EXTS.has(ext)) {
    return (
      <svg {...common}>
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <circle cx="9" cy="9" r="2" />
        <path d="m21 15-3.5-3.5L11 18" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

export function FilepathToken({ path, sessionId }: Props) {
  // Optional: the buddy window / sandbox render this without ArtifactProvider.
  // When absent, the pill still renders (so prose isn't disrupted) but the
  // click is a no-op — there's no drawer to open in those roots.
  const artifactCtx = useArtifactOptional();
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  // Basename only inline — the full path lives in the title tooltip. Keeps prose
  // calm when Claude references deep paths mid-sentence.
  const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;

  const onClick = async () => {
    // No provider (buddy window / sandbox) → nothing to open. Bail quietly.
    if (!artifactCtx) return;
    const { state, dispatch } = artifactCtx;
    // 1. Session-current artifact? Match by the stored path or absolutePath.
    //    For internal artifacts, `a.path` is relative to the project root;
    //    we match against the text-detected path's suffix as a best-effort heuristic.
    const sessArtifacts = state.sessionArtifacts[sessionId] ?? [];
    const normalised = path.replace(/\\/g, '/');
    const sessMatch = sessArtifacts.find((a) => {
      const aPath = (a.kind === 'internal' ? a.path : a.absolutePath) ?? '';
      const aPathNorm = aPath.replace(/\\/g, '/');
      return (
        aPathNorm === normalised ||
        normalised.endsWith('/' + aPathNorm) ||
        aPathNorm.endsWith('/' + normalised)
      );
    });
    if (sessMatch) {
      dispatch({ type: 'DRAWER_OPENED', sessionId });
      dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: sessMatch.id });
      return;
    }
    // 2. Otherwise: pivot to Project View. (Task 7 builds the actual
    //    focused-on-path behavior; for now opening Project View is enough.)
    dispatch({ type: 'PROJECT_VIEW_OPENED' });
  };

  return (
    <button
      type="button"
      // B4 recessed pill: sits on --well with a hairline --edge border so it
      // lifts out of the bg-inset chat bubble. (Before this, the chip was also
      // bg-inset — same color as the bubble, so it read as flat text, not a
      // clickable file.) Monospace basename keeps the "this is a file" signal.
      className="group inline-flex items-center gap-1.5 align-middle px-2 py-0.5 rounded-md bg-well border border-edge hover:border-fg-muted transition-colors"
      onClick={onClick}
      title={path}
    >
      <FileGlyph ext={ext} />
      <span className="font-mono text-[0.85em] text-fg group-hover:underline underline-offset-2 decoration-fg-muted">
        {name}
      </span>
    </button>
  );
}
