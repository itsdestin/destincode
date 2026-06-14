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
import { ProjectDetailOverlay } from '../ProjectDetailOverlay';

// ProjectView keeps its own artifact selection separate from any chat session's
// drawer, keyed under this reserved sessionId in activeArtifactBySession.
const PV_SESSION = 'project-view';

// Human "kind" label for a card (Document / Image / Code / Config), derived from
// the shared categorizer — matches the prototype's artCard second line.
function kindLabel(p: string): string {
  const c = categorizeArtifact(p);
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'File';
}

export function ArtifactsTab({
  project,
  search,
  refreshKey,
}: {
  project: CentralIndexProject;
  search: string;     // lifted to ProjectView — lives on the shared seg-row now
  refreshKey: number; // bumped by ProjectView after "+ Add file" to force a reload
}) {
  const { state, dispatch } = useArtifact();
  const pvActiveId = state.activeArtifactBySession[PV_SESSION] ?? null;
  // Read-only here: the toggle chips that SET these live on the ProjectView seg-row.
  const { hideCodeAndConfigs, showDeletedArtifacts } = useTheme();
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);

  // Load artifacts whenever the active project changes, or after an add-external
  // (refreshKey bump from ProjectView).
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
  }, [project.id, refreshKey]);

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
  const refreshArtifacts = () => {
    (window.claude as any).artifacts.listProject(project.id).then((r: any) => {
      if (r && r.ok) setArtifacts(r.artifacts);
    });
  };

  const activeArtifact = pvActiveId ? artifacts.find((a) => a.id === pvActiveId) : undefined;

  return (
    <div className="relative flex flex-col h-full overflow-hidden px-4 pt-4 pb-4 gap-3 min-w-0">
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
              // Fixed h-44 (PITFALL: without a fixed card height the thumbnail
              // flex-shrinks to zero in a short grid row, collapsing cards into
              // blank pills). The thumbnail is flex-1 to fill the space above the
              // filename/kind; both text lines are shrink-0 so the card stays uniform.
              className={`layer-surface !rounded-lg relative flex flex-col h-44 overflow-hidden text-left transition-transform duration-200 hover:scale-[1.02] ${
                isActive ? 'border-accent' : ''
              } ${isDeleted ? 'opacity-60' : ''}`}
              onClick={() => dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId: PV_SESSION, artifactId: a.id })}
              title={isDeleted ? `${a.path}\nDeleted (file is no longer on disk)` : a.path}
            >
              {/* Mini pre-render (image/text/html). flex-1 fills the space above
                  the filename/kind in the fixed-height card. */}
              <ArtifactThumbnail
                artifact={a}
                projectPath={project.path}
                className={`flex-1 min-h-0 w-full border-b border-edge-dim ${isDeleted ? 'grayscale' : ''}`}
              />
              {/* "deleted" word badge — anchored top-right of the thumbnail.
                  Plain word, no glyph (the ✕/●◐○ language is disliked). */}
              {isDeleted && (
                <span
                  className="absolute top-2 right-2 px-1.5 py-0.5 text-[10px] font-semibold bg-canvas/80 border border-edge rounded text-fg-2"
                  aria-label="Deleted"
                >
                  deleted
                </span>
              )}
              <span className={`px-2.5 pt-2 pb-0.5 text-[12px] font-mono truncate w-full text-fg-2 shrink-0 ${isDeleted ? 'line-through' : ''}`}>
                {filename}
              </span>
              <span className="px-2.5 pb-2.5 text-[10.5px] text-fg-muted shrink-0">
                {kindLabel(a.path)}
              </span>
            </button>
          );
        })}
      </div>

      {/* Selected-artifact detail — rendered in the shared centered overlay
          (Task 2.4). Same load/view/edit/exclude behavior as the prior inline
          detail; only the presentation changed (full-bleed → centered overlay). */}
      {activeArtifact && (
        <ArtifactDetail
          artifact={activeArtifact}
          project={project}
          onRefreshArtifacts={refreshArtifacts}
        />
      )}
    </div>
  );
}

// ─── ArtifactDetail ───────────────────────────────────────────────────────────
// Selected-artifact detail, now hosted in the shared centered ProjectDetailOverlay
// (Task 2.4) instead of a full-bleed inline pane. Uses the shared
// ActiveArtifactView with the same props as before. The Exclude action lives in
// a small action row inside the overlay body so it stays reachable.

interface DetailProps {
  artifact: ArtifactRecord;
  project: CentralIndexProject;
  onRefreshArtifacts: () => void;
}

function ArtifactDetail({ artifact, project, onRefreshArtifacts }: DetailProps) {
  const { dispatch } = useArtifact();
  const [content, setContent] = useState<string | null>(null);

  const handleClose = () => dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION });

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
    handleClose();
    onRefreshArtifacts();
  };

  return (
    <ProjectDetailOverlay title={artifact.path} onClose={handleClose}>
      {/* Fill the overlay body as a flex column: fixed action row + viewer that
          owns its own scroll (so the generic overlay body doesn't double-scroll). */}
      <div className="flex flex-col h-full">
        {/* Action row: Exclude (moved here from the old inline header so it stays
            reachable inside the content-agnostic overlay shell). */}
        <div className="flex items-center justify-end px-3 py-1.5 border-b border-edge shrink-0">
          <button
            type="button"
            className="px-2 py-1 rounded-sm border border-edge hover:bg-inset transition-colors text-xs"
            onClick={handleExclude}
            title="Exclude this file from artifact tracking"
          >
            Exclude
          </button>
        </div>

        {/* Content viewer — fills the remaining overlay body. */}
        <div className="flex-1 min-h-0 overflow-hidden">
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
    </ProjectDetailOverlay>
  );
}
