// ProjectView — full-screen overlay showing all projects and their artifacts.
// Opened by the Projects button in HeaderBar (or via dispatch({ type: 'PROJECT_VIEW_OPENED' })).
// Renders nothing when state.projectViewOpen is false.
// z-[8000]: below SessionStrip dropdown (9000) but above all other overlays (L2 = 61).
import { useEffect, useState } from 'react';
import { useArtifact } from '../state/ArtifactContext';
import type { CentralIndexProject, ArtifactRecord } from '../../shared/artifacts/types';

export function ProjectView() {
  const { state, dispatch } = useArtifact();
  const [projects, setProjects] = useState<CentralIndexProject[]>([]);
  const [activeProject, setActiveProject] = useState<CentralIndexProject | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  const [search, setSearch] = useState('');

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
  }, [activeProject?.id]);

  if (!state.projectViewOpen) return null;

  // Filter to active (non-deleted) artifacts matching the search query.
  const filtered = artifacts.filter((a) =>
    a.status !== 'deleted' &&
    (!search || a.path.toLowerCase().includes(search.toLowerCase()))
  );

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
            <button
              key={p.id}
              type="button"
              className={`w-full text-left px-2 py-2 rounded-sm transition-colors ${
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
          ))}

          {/* Placeholder — Add external folder lands in Task 7.3 */}
          <button
            type="button"
            className="mt-2 w-full px-2 py-1.5 border border-edge rounded-sm text-xs text-fg-muted hover:bg-inset hover:text-fg transition-colors"
            onClick={() => alert('Add external folder — coming in Task 7.3')}
          >
            + Add external folder
          </button>
        </aside>

        {/* Main panel — artifact grid */}
        <main className="flex-1 flex flex-col overflow-hidden p-4 gap-3">
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
              return (
                <button
                  key={a.id}
                  type="button"
                  className="flex flex-col items-center p-3 border border-edge rounded-sm hover:bg-inset transition-colors min-h-[90px] text-left"
                  onClick={() => {
                    // Detail-pane wiring lands in Task 7.2; for now set the
                    // active artifact so downstream subscribers can react.
                    dispatch({ type: 'ACTIVE_ARTIFACT_SET', artifactId: a.id });
                  }}
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
      </div>
    </div>
  );
}
