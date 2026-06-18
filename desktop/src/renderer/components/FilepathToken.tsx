import { useArtifactOptional } from '../state/ArtifactContext';
import type { ArtifactRecord } from '../../shared/artifacts/types';

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

// Build the appendVersion args for "artifactifying" a clicked path that isn't
// tracked or discovered anywhere (e.g. a file Claude created via a Bash/python
// script, or one in a temp dir outside the project). Mirrors the internal-vs-
// external logic the App.tsx artifact tracker uses for tool-use events: a path
// under cwd is internal (relative path); anything else is external (basename +
// absolute path). Relative clicked paths are resolved against cwd first.
function buildArtifactifyArgs(clickedPath: string, cwd: string): {
  path: string; kind: 'internal' | 'external'; absolutePath: string | null;
  type: 'read'; author: 'user';
} {
  const norm = clickedPath.replace(/\\/g, '/');
  const isAbs = /^[a-zA-Z]:\//.test(norm) || norm.startsWith('/');
  const cwdFwd = cwd.replace(/\\/g, '/').replace(/\/+$/, '');
  const absFwd = isAbs ? norm : `${cwdFwd}/${norm.replace(/^\.\//, '')}`;
  const absLower = absFwd.toLowerCase();
  const rootLower = cwdFwd.toLowerCase();
  const isInternal = absLower === rootLower || absLower.startsWith(rootLower + '/');
  if (isInternal) {
    const rel = absLower === rootLower ? '' : absFwd.slice(cwdFwd.length + 1);
    return { path: rel, kind: 'internal', absolutePath: null, type: 'read', author: 'user' };
  }
  const basename = absFwd.split('/').pop() || absFwd;
  return { path: basename, kind: 'external', absolutePath: absFwd, type: 'read', author: 'user' };
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

  // Suffix-tolerant path match: Claude may reference a file relative to a
  // subdirectory (`desktop/src/x.ts`) while the artifact is stored relative to the
  // project root (`youcoded/desktop/src/x.ts`), so match either direction's tail.
  const normalised = path.replace(/\\/g, '/');
  const matches = (a: ArtifactRecord) => {
    const aPath = (a.kind === 'internal' ? a.path : a.absolutePath) ?? '';
    const aPathNorm = aPath.replace(/\\/g, '/');
    return (
      aPathNorm === normalised ||
      normalised.endsWith('/' + aPathNorm) ||
      aPathNorm.endsWith('/' + normalised)
    );
  };

  const onClick = async () => {
    // No provider (buddy window / sandbox) → nothing to open. Bail quietly.
    if (!artifactCtx) return;
    const { state, dispatch } = artifactCtx;

    // Clicking a file in chat ALWAYS opens the artifact viewer — NEVER Project
    // View. Open the drawer first so there's an immediate response regardless of
    // how the lookup below resolves.
    dispatch({ type: 'DRAWER_OPENED', sessionId });

    // 1. Already in this session's live list? Select it.
    const sessMatch = (state.sessionArtifacts[sessionId] ?? []).find(matches);
    if (sessMatch) {
      dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: sessMatch.id });
      return;
    }

    // 2. Not in this session — resolve against the WHOLE project: every tracked
    //    artifact (from any session, including deleted) plus on-disk files. Inject
    //    the match into the session list so the drawer can display it. This is why
    //    a file Claude edited in a prior session — or one that's just on disk —
    //    still opens instead of dead-ending.
    const cwd = state.sessionCwd?.[sessionId];
    if (!cwd) return; // drawer stays on the list; nothing to resolve without a root
    try {
      // Try ARTIFACTS first (tracked, the common case — Claude edited the file).
      // listProject is artifacts-only now, so fall back to ALL FILES (on-disk docs)
      // for a path Claude only read/mentioned but never edited. Either way it
      // opens in the artifact viewer, never Project View.
      const [projRes, filesRes] = await Promise.all([
        (window.claude as any).artifacts.listProject(cwd),
        (window.claude as any).artifacts.listAllFiles(cwd),
      ]);
      const projMatch: ArtifactRecord | undefined =
        (projRes?.ok ? (projRes.artifacts ?? []) : []).find(matches)
        ?? (filesRes?.ok ? (filesRes.files ?? []) : []).find(matches);
      if (projMatch) {
        dispatch({ type: 'SESSION_ARTIFACT_UPSERTED', sessionId, artifact: projMatch });
        dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: projMatch.id });
        return;
      }

      // 3. Nothing matched anywhere — ARTIFACTIFY the clicked path. If a file is
      //    visible as a pill in chat, clicking it should always open it, no matter
      //    how it was created (Bash/python script output, untracked read) or where
      //    it lives (temp dir outside the project). appendVersion records it in the
      //    sidecar (author 'user', type 'read'); we then refresh the session list
      //    and select the new entry. This is the only path that PERSISTS a brand-
      //    new artifact, so the file also appears in the Session Drawer afterward.
      const args = buildArtifactifyArgs(path, cwd);
      await (window.claude as any).artifacts.appendVersion(cwd, sessionId, args);
      const refreshed = await (window.claude as any).artifacts.listSession(sessionId, cwd);
      if (refreshed?.ok && Array.isArray(refreshed.artifacts)) {
        dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: refreshed.artifacts });
        const added = (refreshed.artifacts as ArtifactRecord[]).find(matches);
        if (added) dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: added.id });
      }
    } catch { /* leave the drawer on its list */ }
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
