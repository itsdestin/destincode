// ArtifactsTab — the artifact grid + toolbar for one project, extracted from the
// old monolithic ProjectView (Task 2.1). Preserves the original load/orphan/filter
// logic byte-for-byte; the only behavioral changes are visual (cards now use
// .layer-surface) and the deleted glyph badge is now a plain word "deleted"
// (the ●◐○ / ✕ glyph language is disliked — plain words instead).
import React, { useEffect, useMemo, useState } from 'react';
import { useArtifact } from '../../../state/ArtifactContext';
import { useTheme } from '../../../state/theme-context';
import type { CentralIndexProject, ArtifactRecord } from '../../../../shared/artifacts/types';
import { ActiveArtifactView } from '../../artifact-views/ActiveArtifactView';
import { ArtifactThumbnail } from '../../ArtifactThumbnail';
import { categorizeArtifact } from '../../../../shared/artifacts/categorization';

// ProjectView keeps its own artifact selection separate from any chat session's
// drawer, keyed under this reserved sessionId in activeArtifactBySession.
const PV_SESSION = 'project-view';

export function ArtifactsTab({ project }: { project: CentralIndexProject }) {
  const { state, dispatch } = useArtifact();
  const pvActiveId = state.activeArtifactBySession[PV_SESSION] ?? null;
  const { hideCodeAndConfigs, setHideCodeAndConfigs, showDeletedArtifacts, setShowDeletedArtifacts } = useTheme();
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [search, setSearch] = useState('');

  // Load artifacts whenever the active project changes.
  useEffect(() => {
    let cancelled = false;
    (window.claude as any).artifacts.listProject(project.id).then((res: any) => {
      if (cancelled) return;
      if (res && res.ok) setArtifacts(res.artifacts);
      else setArtifacts([]);
    });
    // Clear the active artifact when the project switches so the detail pane
    // doesn't carry stale content from the previous project.
    dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION });
    return () => { cancelled = true; };
  }, [project.id]);

  // Existence check: fold "file not on disk" into the deleted UI state alongside
  // sidecar-tracked delete versions. Re-runs whenever the artifact list changes.
  const [orphanIds, setOrphanIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (artifacts.length === 0) { setOrphanIds(new Set()); return; }
    let cancelled = false;
    const ids = artifacts.map((a) => a.id);
    (window.claude as any).artifacts.checkExistence(project.path, ids)
      .then((res: any) => {
        if (cancelled || !res?.ok) return;
        setOrphanIds(new Set(res.missingIds ?? []));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [project.path, artifacts]);

  // Filter the artifact grid.
  const filtered = useMemo(
    () => artifacts.filter((a) => {
      const isDeleted = a.status === 'deleted' || orphanIds.has(a.id);
      if (isDeleted && !showDeletedArtifacts) return false;
      if (hideCodeAndConfigs && categorizeArtifact(a.path) !== 'document') return false;
      if (search && !a.path.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    }),
    [artifacts, hideCodeAndConfigs, showDeletedArtifacts, orphanIds, search],
  );
  // Counts for tooltip hints — total deleted (any cause).
  const deletedCount = useMemo(
    () => artifacts.filter((a) => a.status === 'deleted' || orphanIds.has(a.id)).length,
    [artifacts, orphanIds],
  );

  const refreshArtifacts = () => {
    (window.claude as any).artifacts.listProject(project.id).then((r: any) => {
      if (r && r.ok) setArtifacts(r.artifacts);
    });
  };

  // window.claude.dialog.openFile() returns Promise<string[]> (array of paths).
  const addExternal = async () => {
    const paths: string[] = await (window.claude as any).dialog.openFile();
    if (!paths || paths.length === 0) return;
    await Promise.all(
      paths.map((p: string) =>
        (window.claude as any).artifacts.includeExternal(project.path, p)
      )
    );
    refreshArtifacts();
  };

  const activeArtifact = pvActiveId ? artifacts.find((a) => a.id === pvActiveId) : undefined;

  return (
    <div className="relative flex flex-col h-full overflow-hidden p-4 gap-3 min-w-0">
      {/* Toolbar: search + filter toggles + add-external */}
      <div className="flex items-center gap-2 shrink-0">
        <input
          type="text"
          placeholder="Search artifacts…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 px-3 py-1.5 text-sm bg-inset rounded-sm border border-edge placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {/* Filter toggles — shared preferences w/ SessionDrawer.
            Hide code & configs defaults ON. Show deleted defaults OFF.
            Plain-word toggle state (no ☑/☐ glyph language). */}
        <button
          type="button"
          className={`flex items-center gap-1.5 px-2 py-1.5 rounded-sm border text-xs transition-colors shrink-0 ${
            hideCodeAndConfigs
              ? 'bg-inset border-edge text-fg'
              : 'border-edge text-fg-muted hover:text-fg hover:bg-inset'
          }`}
          onClick={() => setHideCodeAndConfigs(!hideCodeAndConfigs)}
          title={hideCodeAndConfigs
            ? 'Showing Documents and Mockups only. Click to show all.'
            : 'Showing all files. Click to hide code & configs.'}
        >
          <span>Hide code &amp; configs</span>
        </button>
        <button
          type="button"
          className={`flex items-center gap-1.5 px-2 py-1.5 rounded-sm border text-xs transition-colors shrink-0 ${
            showDeletedArtifacts
              ? 'bg-inset border-edge text-fg'
              : 'border-edge text-fg-muted hover:text-fg hover:bg-inset'
          }`}
          onClick={() => setShowDeletedArtifacts(!showDeletedArtifacts)}
          title={showDeletedArtifacts
            ? 'Including deleted files in the grid. Click to hide them.'
            : `Hiding deleted files${deletedCount > 0 ? ` — ${deletedCount} hidden in this project` : ''}. Click to include them.`}
        >
          <span>Show deleted</span>
          {!showDeletedArtifacts && deletedCount > 0 && (
            <span className="text-fg-muted">+{deletedCount}</span>
          )}
        </button>
        <button
          type="button"
          className="px-2 py-1.5 border border-edge rounded-sm text-xs text-fg-muted hover:bg-inset hover:text-fg transition-colors shrink-0"
          onClick={addExternal}
        >
          + Add external file
        </button>
      </div>

      {filtered.length === 0 && (
        <p className="text-sm text-fg-muted">
          {search
            ? 'No artifacts match your search.'
            : 'This project has no artifacts to show under the current filters. Try toggling "Hide code & configs" or "Show deleted" above.'}
        </p>
      )}

      <div className="flex-1 overflow-auto grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 content-start">
        {filtered.map((a) => {
          const filename = a.path.split('/').pop() ?? a.path;
          const isActive = pvActiveId === a.id;
          const isDeleted = a.status === 'deleted' || orphanIds.has(a.id);
          return (
            // Fixed height (h-44) + shrink-0 children → every card is the same
            // size and always shows its thumbnail + name. Without this the
            // h-28 thumbnail could be flex-shrunk to nothing in a grid row,
            // which collapsed cards into blank/nameless pills.
            // Restyled to .layer-surface (selection shown by border-accent outline).
            <button
              key={a.id}
              type="button"
              className={`layer-surface relative flex flex-col h-44 p-2 transition-colors text-left overflow-hidden ${
                isActive ? 'border-accent' : 'hover:bg-inset'
              } ${isDeleted ? 'opacity-60' : ''}`}
              onClick={() => dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId: PV_SESSION, artifactId: a.id })}
              title={isDeleted ? `${a.path}\nDeleted (file is no longer on disk)` : a.path}
            >
              {/* Mini pre-render of the file (image/text/html) or ext-letter fallback */}
              <ArtifactThumbnail
                artifact={a}
                projectPath={project.path}
                className={`h-28 w-full rounded-sm mb-2 shrink-0 ${isDeleted ? 'grayscale' : ''}`}
              />
              {/* "deleted" word badge — anchored top-right of the thumbnail.
                  Plain word, no glyph (the ✕/●◐○ language is disliked). */}
              {isDeleted && (
                <span
                  className="absolute top-3 right-3 px-1.5 py-0.5 text-[10px] font-semibold bg-canvas/80 border border-edge rounded text-fg-2"
                  aria-label="Deleted"
                >
                  deleted
                </span>
              )}
              <div className={`text-xs truncate w-full text-fg-2 shrink-0 ${isDeleted ? 'line-through' : ''}`}>
                {filename}
              </div>
            </button>
          );
        })}
      </div>

      {/* Selected-artifact inline detail. Rendered full-bleed within this tab.
          TODO(Task 2.4): replace this inline detail with the shared centered
          ProjectDetailOverlay. Kept functional now so the build works and the
          feature isn't broken between tasks. */}
      {activeArtifact && (
        <InlineArtifactDetail
          artifact={activeArtifact}
          project={project}
          onRefreshArtifacts={refreshArtifacts}
        />
      )}
    </div>
  );
}

// ─── InlineArtifactDetail ─────────────────────────────────────────────────────
// Inline right-pane detail for the selected artifact, mirroring the old
// ProjectViewDetailPane. Uses the shared ActiveArtifactView with the same props.
// TODO(Task 2.4): replace with the shared centered ProjectDetailOverlay.

interface DetailProps {
  artifact: ArtifactRecord;
  project: CentralIndexProject;
  onRefreshArtifacts: () => void;
}

function InlineArtifactDetail({ artifact, project, onRefreshArtifacts }: DetailProps) {
  const { dispatch } = useArtifact();
  const [content, setContent] = useState<string | null>(null);

  // Load file content whenever the selected artifact changes.
  useEffect(() => {
    let cancelled = false;
    setContent(null);
    (window.claude as any).artifacts.get(project.path, artifact.id).then((res: any) => {
      if (cancelled) return;
      if (res && res.ok) setContent(res.content ?? null);
    });
    return () => { cancelled = true; };
  }, [artifact.id, project.path]);

  const handleExclude = async () => {
    // Use absolutePath for external artifacts, relative path (internal) gets
    // canonicalized by the EXCLUDE handler's canonicalize() call.
    const canonicalPath = artifact.kind === 'internal'
      ? artifact.path
      : artifact.absolutePath!;
    await (window.claude as any).artifacts.exclude(project.path, canonicalPath);
    dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION });
    onRefreshArtifacts();
  };

  return (
    // Full-bleed overlay over the tab body. z-[10] keeps it above the grid but
    // below the ProjectView overlay's own chrome.
    <div className="absolute inset-0 z-10 bg-canvas flex flex-col">
      {/* Pane header: artifact path + close button */}
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-edge shrink-0">
        <span
          className="font-mono text-xs truncate flex-1 text-fg-2"
          title={artifact.path}
        >
          {artifact.path}
        </span>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          <button
            type="button"
            className="px-2 py-1 rounded-sm border border-edge hover:bg-inset transition-colors text-xs"
            onClick={handleExclude}
            title="Exclude this file from artifact tracking"
          >
            Exclude
          </button>
          <button
            type="button"
            className="text-fg-muted hover:text-fg px-1"
            onClick={() => dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION })}
            title="Close detail"
            aria-label="Close detail"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Content viewer */}
      <div className="flex-1 overflow-hidden">
        <ActiveArtifactView
          artifact={artifact}
          content={content}
          projectRoot={project.path}
          projectId={project.id}
          projectName={project.name}
          sessionId="project-view"
          onContentChange={setContent}
        />
      </div>
    </div>
  );
}
