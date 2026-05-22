// ProjectView — full-screen overlay showing all projects and their artifacts.
// Opened by the Projects button in HeaderBar (or via dispatch({ type: 'PROJECT_VIEW_OPENED' })).
// Renders nothing when state.projectViewOpen is false.
// z-[8000]: below SessionStrip dropdown (9000) but above all other overlays (L2 = 61).
// Task 7.2: right-column detail pane (ProjectViewDetailPane) shows artifact content.
// Task 7.3: project deletion confirmation modal + real add-external-file picker.
import React, { useEffect, useState } from 'react';
import { useArtifact } from '../state/ArtifactContext';
import type { CentralIndexProject, ArtifactRecord } from '../../shared/artifacts/types';
import { ActiveArtifactView } from './artifact-views/ActiveArtifactView';

export function ProjectView() {
  const { state, dispatch } = useArtifact();
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
    dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED' });
  }, [activeProject?.id]);

  if (!state.projectViewOpen) return null;

  // Filter to active (non-deleted) artifacts matching the search query.
  const filtered = artifacts.filter((a) =>
    a.status !== 'deleted' &&
    (!search || a.path.toLowerCase().includes(search.toLowerCase()))
  );

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
                  : 'This project has no artifacts yet.'
                : 'Select a project to view its artifacts.'}
            </p>
          )}

          <div className="flex-1 overflow-auto grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3 content-start">
            {filtered.map((a) => {
              const filename = a.path.split('/').pop() ?? a.path;
              const ext = filename.includes('.')
                ? filename.split('.').pop()!.toUpperCase()
                : '—';
              const isActive = state.activeArtifactId === a.id;
              return (
                <button
                  key={a.id}
                  type="button"
                  className={`flex flex-col items-center p-3 border rounded-sm transition-colors min-h-[90px] text-left ${
                    isActive
                      ? 'border-accent bg-inset'
                      : 'border-edge hover:bg-inset'
                  }`}
                  onClick={() => dispatch({ type: 'ACTIVE_ARTIFACT_SET', artifactId: a.id })}
                  title={a.path}
                >
                  <div className="text-xl font-mono text-fg-muted mb-2">{ext}</div>
                  <div className="text-xs truncate w-full text-center text-fg-2">
                    {filename}
                  </div>
                </button>
              );
            })}
          </div>
        </main>

        {/* Right detail pane — shown when an artifact is selected (Task 7.2) */}
        {state.activeArtifactId && (() => {
          const activeArtifact = artifacts.find((a) => a.id === state.activeArtifactId);
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
    dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED' });
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
          onClick={() => dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED' })}
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
