import { useArtifact } from '../state/ArtifactContext';

interface Props {
  path: string;
  sessionId: string;
}

const EXT_ICON: Record<string, string> = {
  md: '📝', markdown: '📝', txt: '📄',
  pdf: '📕', docx: '📘', xlsx: '📗',
  png: '🖼', jpg: '🖼', jpeg: '🖼', gif: '🖼', webp: '🖼',
};

export function FilepathToken({ path, sessionId }: Props) {
  const { state, dispatch } = useArtifact();
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const icon = EXT_ICON[ext] ?? '📎';

  const onClick = async () => {
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
      dispatch({ type: 'DRAWER_OPENED' });
      dispatch({ type: 'ACTIVE_ARTIFACT_SET', artifactId: sessMatch.id });
      return;
    }
    // 2. Otherwise: pivot to Project View. (Task 7 builds the actual
    //    focused-on-path behavior; for now opening Project View is enough.)
    dispatch({ type: 'PROJECT_VIEW_OPENED' });
  };

  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 px-2 py-1 min-h-[28px] rounded bg-inset text-fg font-mono text-[0.9em] hover:bg-inset/80"
      onClick={onClick}
      title={path}
    >
      <span>{icon}</span>
      <span>{path}</span>
    </button>
  );
}
