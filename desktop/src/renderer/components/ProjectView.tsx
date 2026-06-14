// ProjectView — full-screen overlay showing all projects and their artifacts.
// Opened by the Projects button in HeaderBar (or via dispatch({ type: 'PROJECT_VIEW_OPENED' })).
// Renders nothing when state.projectViewOpen is false.
// z-[8000]: below SessionStrip dropdown (9000) but above all other overlays (L2 = 61).
// Task 7.2: right-column detail pane (ProjectViewDetailPane) shows artifact content.
// Task 7.3: project deletion confirmation modal + real add-external-file picker.
import React, { useEffect, useMemo, useState } from 'react';
import { useArtifact } from '../state/ArtifactContext';
import { useTheme } from '../state/theme-context';
import type { CentralIndexProject, ArtifactRecord } from '../../shared/artifacts/types';
import { ActiveArtifactView } from './artifact-views/ActiveArtifactView';
import { ArtifactThumbnail } from './ArtifactThumbnail';
import { categorizeArtifact } from '../../shared/artifacts/categorization';

// ProjectView keeps its own artifact selection separate from any chat session's
// drawer, keyed under this reserved sessionId in activeArtifactBySession.
const PV_SESSION = 'project-view';

export function ProjectView() {
  const { state, dispatch } = useArtifact();
  const pvActiveId = state.activeArtifactBySession[PV_SESSION] ?? null;
  const { hideCodeAndConfigs, setHideCodeAndConfigs, showDeletedArtifacts, setShowDeletedArtifacts } = useTheme();
  const [projects, setProjects] = useState<CentralIndexProject[]>([]);
  const [activeProject, setActiveProject] = useState<CentralIndexProject | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [search, setSearch] = useState('');

  // Task 7.3: project deletion modal state
  const [deletingProject, setDeletingProject] = useState<CentralIndexProject | null>(null);
  const [alsoDeleteSidecar, setAlsoDeleteSidecar] = useState(false);

  // Load the projects index whenever the view is opened.
  useEffect(() => {
    if (!state.projectViewOpen) return;
    (window.claude as any).artifacts.listProjectsIndex().then((res: any) => {
      if (res && res.ok) {
        setProjects(res.projects);
        // Auto-select the first project if nothing is currently selected
        // (or the previously-selected project is no longer in the list).
        setActiveProject((prev) => {
          if (prev && res.projects.some((p: CentralIndexProject) => p.id === prev.id)) return prev;
          return res.projects.length > 0 ? res.projects[0] : null;
        });
      }
    });
  }, [state.projectViewOpen]);

  // Load artifacts whenever the active project changes.
  useEffect(() => {
    if (!activeProject) { setArtifacts([]); return; }
    (window.claude as any).artifacts.listProject(activeProject.id).then((res: any) => {
      if (res && res.ok) setArtifacts(res.artifacts);
      else setArtifacts([]);
    });
    // Clear the active artifact when the project switches so the detail pane
    // doesn't carry stale content from the previous project.
    dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION });
  }, [activeProject?.id]);

  // Existence check: fold "file not on disk" into the deleted UI state alongside
  // sidecar-tracked delete versions. Re-runs whenever the artifact list changes.
  const [orphanIds, setOrphanIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!activeProject || artifacts.length === 0) { setOrphanIds(new Set()); return; }
    let cancelled = false;
    const ids = artifacts.map((a) => a.id);
    (window.claude as any).artifacts.checkExistence(activeProject.path, ids)
      .then((res: any) => {
        if (cancelled || !res?.ok) return;
        setOrphanIds(new Set(res.missingIds ?? []));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [activeProject?.path, artifacts]);

  // Filter the artifact grid. Hooks MUST run before any early return — Rules of
  // Hooks. Don't move these below the projectViewOpen guard or React throws
  // "Rendered more hooks than during the previous render" the first time the
  // view is opened.
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
  // Counts for tooltip hints — total non-deleted, total deleted (any cause).
  const deletedCount = useMemo(
    () => artifacts.filter((a) => a.status === 'deleted' || orphanIds.has(a.id)).length,
    [artifacts, orphanIds],
  );

  if (!state.projectViewOpen) return null;

  // ── Task 7.3: project deletion ───────────────────────────────────────────
  const confirmDelete = async () => {
    if (!deletingProject) return;
    await (window.claude as any).artifacts.deleteProject(deletingProject.id, alsoDeleteSidecar);
    // Refresh project list after deletion
    const res = await (window.claude as any).artifacts.listProjectsIndex();
    if (res && res.ok) {
      setProjects(res.projects);
      // If we deleted the active project, select the first remaining one
      setActiveProject((prev) =>
        prev?.id === deletingProject.id
          ? (res.projects[0] ?? null)
          : prev
      );
    }
    setDeletingProject(null);
    setAlsoDeleteSidecar(false);
  };

  // ── Task 7.3: add external file ──────────────────────────────────────────
  // window.claude.dialog.openFile() returns Promise<string[]> (array of paths).
  const addExternal = async () => {
    if (!activeProject) {
      alert('Select a project first');
      return;
    }
    const paths: string[] = await (window.claude as any).dialog.openFile();
    if (!paths || paths.length === 0) return;
    // Include each selected file as an external artifact
    await Promise.all(
      paths.map((p: string) =>
        (window.claude as any).artifacts.includeExternal(activeProject.path, p)
      )
    );
    // Refresh artifact list
    const res = await (window.claude as any).artifacts.listProject(activeProject.id);
    if (res && res.ok) setArtifacts(res.artifacts);
  };

  return (
    <div className="fixed inset-0 bg-canvas z-[8000] flex flex-col">
      <header className="flex items-center justify-between px-3 py-2 border-b border-edge shrink-0">
        <h2 className="text-base font-semibold">Projects</h2>
        <div className="flex items-center gap-2">
          {/* Filter toggles — shared preferences w/ SessionDrawer.
              Hide code & configs defaults ON. Show deleted defaults OFF. */}
          <button
            type="button"
            className={`flex items-center gap-1.5 px-2 py-1 rounded-sm border text-xs transition-colors ${
              hideCodeAndConfigs
                ? 'bg-inset border-edge text-fg'
                : 'border-edge text-fg-muted hover:text-fg hover:bg-inset'
            }`}
            onClick={() => setHideCodeAndConfigs(!hideCodeAndConfigs)}
            title={hideCodeAndConfigs
              ? 'Showing Documents and Mockups only. Click to show all.'
              : 'Showing all files. Click to hide code & configs.'}
          >
            <span className="text-sm leading-none">{hideCodeAndConfigs ? '☑' : '☐'}</span>
            <span>Hide code &amp; configs</span>
          </button>
          <button
            type="button"
            className={`flex items-center gap-1.5 px-2 py-1 rounded-sm border text-xs transition-colors ${
              showDeletedArtifacts
                ? 'bg-inset border-edge text-fg'
                : 'border-edge text-fg-muted hover:text-fg hover:bg-inset'
            }`}
            onClick={() => setShowDeletedArtifacts(!showDeletedArtifacts)}
            title={showDeletedArtifacts
              ? 'Including deleted files in the grid. Click to hide them.'
              : `Hiding deleted files${deletedCount > 0 ? ` — ${deletedCount} hidden in this project` : ''}. Click to include them.`}
          >
            <span className="text-sm leading-none">{showDeletedArtifacts ? '☑' : '☐'}</span>
            <span>Show deleted</span>
            {!showDeletedArtifacts && deletedCount > 0 && (
              <span className="text-fg-muted">+{deletedCount}</span>
            )}
          </button>
          <button
            type="button"
            className="p-1 rounded-sm hover:bg-inset transition-colors text-fg-muted hover:text-fg shrink-0"
            onClick={() => dispatch({ type: 'PROJECT_VIEW_CLOSED' })}
            title="Close"
            aria-label="Close Projects"
          >
            {/* ✕ close icon */}
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar — project list */}
        <aside className="w-[220px] shrink-0 border-r border-edge overflow-y-auto p-2 flex flex-col gap-1">
          <h3 className="text-[10px] font-semibold text-fg-muted uppercase tracking-wide px-2 py-1">
            Projects
          </h3>

          {projects.length === 0 && (
            <p className="text-xs text-fg-muted px-2 py-2 leading-relaxed">
              No projects yet. Start a session in a folder to create one.
            </p>
          )}

          {projects.map((p) => (
            // WHY: `group` enables hover-revealed delete button via group-hover:opacity-100
            <div key={p.id} className="group relative">
              <button
                type="button"
                className={`w-full text-left px-2 py-2 rounded-sm transition-colors pr-7 ${
                  activeProject?.id === p.id
                    ? 'bg-inset text-fg'
                    : 'hover:bg-inset text-fg-2'
                }`}
                onClick={() => setActiveProject(p)}
              >
                <div className="font-medium text-sm truncate">{p.name}</div>
                <div className="text-[11px] text-fg-muted">
                  {p.stats.artifactCount} artifact{p.stats.artifactCount === 1 ? '' : 's'}
                </div>
              </button>
              {/* Delete button — hover-revealed to avoid visual clutter */}
              <button
                type="button"
                className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 transition-opacity text-fg-muted hover:text-fg px-1 py-0.5 rounded text-xs"
                title={`Remove ${p.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  setDeletingProject(p);
                }}
              >
                ×
              </button>
            </div>
          ))}

          {/* Task 7.3: real file-picker for adding external files */}
          <button
            type="button"
            className="mt-2 w-full px-2 py-1.5 border border-edge rounded-sm text-xs text-fg-muted hover:bg-inset hover:text-fg transition-colors"
            onClick={addExternal}
          >
            + Add external file
          </button>
        </aside>

        {/* Main panel — artifact grid */}
        <main className="flex-1 flex flex-col overflow-hidden p-4 gap-3 min-w-0">
          <input
            type="text"
            placeholder="Search artifacts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full px-3 py-1.5 text-sm bg-inset rounded-sm border border-edge placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />

          {filtered.length === 0 && (
            <p className="text-sm text-fg-muted">
              {activeProject
                ? search
                  ? 'No artifacts match your search.'
                  : 'This project has no artifacts to show under the current filters. Try toggling "Hide code & configs" or "Show deleted" above.'
                : 'Select a project to view its artifacts.'}
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
                <button
                  key={a.id}
                  type="button"
                  className={`relative flex flex-col h-44 p-2 border rounded-sm transition-colors text-left overflow-hidden ${
                    isActive
                      ? 'border-accent bg-inset'
                      : 'border-edge hover:bg-inset'
                  } ${isDeleted ? 'opacity-60' : ''}`}
                  onClick={() => dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId: PV_SESSION, artifactId: a.id })}
                  title={isDeleted ? `${a.path}\nDeleted (file is no longer on disk)` : a.path}
                >
                  {/* Mini pre-render of the file (image/text/html) or ext-letter fallback */}
                  <ArtifactThumbnail
                    artifact={a}
                    projectPath={activeProject?.path ?? ''}
                    className={`h-28 w-full rounded-sm mb-2 shrink-0 ${isDeleted ? 'grayscale' : ''}`}
                  />
                  {/* "Deleted" overlay badge — anchored top-right of the thumbnail */}
                  {isDeleted && (
                    <span
                      className="absolute top-3 right-3 px-1.5 py-0.5 text-[10px] font-semibold bg-canvas/80 border border-edge rounded text-fg-2"
                      aria-label="Deleted"
                    >
                      ✕ deleted
                    </span>
                  )}
                  <div className={`text-xs truncate w-full text-fg-2 shrink-0 ${isDeleted ? 'line-through' : ''}`}>
                    {filename}
                  </div>
                </button>
              );
            })}
          </div>
        </main>

        {/* Right detail pane — shown when an artifact is selected (Task 7.2) */}
        {pvActiveId && (() => {
          const activeArtifact = artifacts.find((a) => a.id === pvActiveId);
          if (!activeArtifact || !activeProject) return null;
          return (
            <ProjectViewDetailPane
              artifact={activeArtifact}
              project={activeProject}
              onRefreshArtifacts={() => {
                (window.claude as any).artifacts.listProject(activeProject.id).then((r: any) => {
                  if (r && r.ok) setArtifacts(r.artifacts);
                });
              }}
            />
          );
        })()}
      </div>

      {/* Task 7.3: project deletion confirmation modal */}
      {deletingProject && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9000]"
          onClick={() => setDeletingProject(null)}
        >
          <div
            className="bg-panel p-6 rounded max-w-md w-full mx-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-2">Remove project</h3>
            <p className="mb-3 text-sm">
              Remove "<span className="font-medium">{deletingProject.name}</span>" from YouCoded?
            </p>
            <p className="text-sm text-fg-muted mb-3">
              The project folder and its files will NOT be deleted. You can re-discover
              this project by launching a session in that folder again.
            </p>
            <label className="flex items-center gap-2 mb-4 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={alsoDeleteSidecar}
                onChange={(e) => setAlsoDeleteSidecar(e.target.checked)}
              />
              Also delete <code className="font-mono text-xs bg-inset px-1 rounded">.youcoded/artifacts.json</code> (artifact history)
            </label>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                className="px-3 py-1.5 rounded border border-edge hover:bg-inset text-sm transition-colors"
                onClick={() => { setDeletingProject(null); setAlsoDeleteSidecar(false); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 text-sm transition-colors"
                onClick={confirmDelete}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── ProjectViewDetailPane ────────────────────────────────────────────────────
// Right-column detail pane for ProjectView. Shows the selected artifact's content
// via the shared ActiveArtifactView component (same one used by SessionDrawer).

interface DetailPaneProps {
  artifact: ArtifactRecord;
  project: CentralIndexProject;
  onRefreshArtifacts: () => void;
}

function ProjectViewDetailPane({ artifact, project, onRefreshArtifacts }: DetailPaneProps) {
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
    // Refresh the artifact list so the excluded artifact disappears from the grid
    onRefreshArtifacts();
  };

  return (
    <aside className="w-[360px] border-l border-edge overflow-hidden flex flex-col shrink-0">
      {/* Pane header: artifact path + close button */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-edge shrink-0">
        <span
          className="font-mono text-xs truncate flex-1 text-fg-2"
          title={artifact.path}
        >
          {artifact.path}
        </span>
        <button
          type="button"
          className="text-fg-muted hover:text-fg px-1 shrink-0 ml-1"
          onClick={() => dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION })}
          title="Close detail"
        >
          ×
        </button>
      </div>

      {/* Action bar */}
      <div className="flex gap-1.5 px-2 py-1.5 border-b border-edge shrink-0 text-xs">
        <button
          type="button"
          className="px-2 py-1 rounded border border-edge hover:bg-inset transition-colors"
          onClick={handleExclude}
          title="Exclude this file from artifact tracking"
        >
          Exclude
        </button>
        {/* Move-to-other-project deferred to a later task */}
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
    </aside>
  );
}
