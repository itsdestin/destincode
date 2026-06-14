// ProjectView — full-screen overlay shell for the project browser (Task 2.1 redesign).
// Opened by the Projects button in HeaderBar (or via dispatch({ type: 'PROJECT_VIEW_OPENED' })).
// Renders nothing when state.projectViewOpen is false.
// z-[8000]: below SessionStrip dropdown (9000) but above all other overlays (L2 = 61).
//
// This file is the composed SHELL: header + project list + segmented tab control +
// tab routing. The artifact grid lives in tabs/ArtifactsTab; Conversations/Context
// tabs are filled by later tasks. The project-deletion modal + project list stay
// here (project-scoped). The "+ Add external file" affordance moved into
// ArtifactsTab (artifact-scoped) since it operates on the active project's artifacts.
import React, { useEffect, useState } from 'react';
import { useArtifact } from '../../state/ArtifactContext';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import type { PastSession } from '../../../shared/types';
import { ArtifactsTab } from './tabs/ArtifactsTab';
import { ConversationsTab } from './tabs/ConversationsTab';
import { ProjectHero } from './ProjectHero';
import { ProjectSwitcher } from './ProjectSwitcher';

type TabId = 'artifacts' | 'conversations' | 'context';

// Live hero stats, computed from the project:* / artifacts:* IPC (not the stale
// stats.artifactCount). null repo means the project folder has no git remote.
interface HeroStats {
  artifacts: number;
  conversations: number;
  contextFiles: number;
  activeLabel: string;
}
interface HeroRepo { webUrl?: string; owner?: string; name?: string }

// Relative-time formatter for the hero "active <when>" stat. Mirrors the
// epoch-ms formatter in ResumeBrowser.tsx (kept inline to avoid coupling the
// project-view subtree to a chat component's internal helper).
function formatRelativeTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(epochMs).toLocaleDateString();
}

interface ProjectViewProps {
  // Threaded from App: starts a new conversation in the given cwd.
  onNewConversation: (cwd: string) => void;
  onResumeConversation: (sessionId: string, projectSlug: string, projectPath: string) => void;
}

export function ProjectView(props: ProjectViewProps) {
  const { state, dispatch } = useArtifact();
  const [projects, setProjects] = useState<CentralIndexProject[]>([]);
  const [activeProject, setActiveProject] = useState<CentralIndexProject | null>(null);
  const [tab, setTab] = useState<TabId>('artifacts');
  const [search, setSearch] = useState('');

  // Hero data (recomputed when the active project changes).
  const [heroStats, setHeroStats] = useState<HeroStats>({
    artifacts: 0, conversations: 0, contextFiles: 0, activeLabel: '—',
  });
  const [heroRepo, setHeroRepo] = useState<HeroRepo | null>(null);

  // Project switcher palette state. Nothing renders it yet — wired in Task 2.3.
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Selected conversation for the preview overlay. Stored here so the
  // ConversationsTab can bubble a click up; the actual <ConversationPreview>
  // overlay is built in Task 3.2.
  const [previewSession, setPreviewSession] = useState<PastSession | null>(null);

  // Project deletion modal state.
  const [deletingProject, setDeletingProject] = useState<CentralIndexProject | null>(null);
  const [alsoDeleteSidecar, setAlsoDeleteSidecar] = useState(false);

  // Load the projects index whenever the view is opened. Hooks MUST run before
  // any early return — Rules of Hooks. Don't move below the projectViewOpen guard
  // or React throws "Rendered more hooks than during the previous render".
  useEffect(() => {
    if (!state.projectViewOpen) return;
    (window.claude as any).artifacts.listProjectsIndex().then((res: any) => {
      if (res && res.ok) {
        setProjects(res.projects);
        // Auto-select the first project if nothing is selected (or the
        // previously-selected project is no longer in the list).
        setActiveProject((prev) => {
          if (prev && res.projects.some((p: CentralIndexProject) => p.id === prev.id)) return prev;
          return res.projects.length > 0 ? res.projects[0] : null;
        });
      }
    });
  }, [state.projectViewOpen]);

  // Compute hero data whenever the active project changes. All four stats come
  // from independent IPC calls; a `cancelled` flag guards against the project
  // switching mid-flight (a late response must not overwrite the new project's).
  useEffect(() => {
    if (!activeProject) {
      setHeroStats({ artifacts: 0, conversations: 0, contextFiles: 0, activeLabel: '—' });
      setHeroRepo(null);
      return;
    }
    let cancelled = false;
    const path = activeProject.path;
    const id = activeProject.id;
    (async () => {
      // Conversations: count of project-filtered past sessions (sorted newest-first).
      let conversations = 0;
      let activeLabel = 'never';
      try {
        const res = await (window.claude as any).project.listConversations(path);
        const list = res?.conversations ?? [];
        conversations = list.length;
        // active <when>: most-recent conversation's lastModified (epoch ms).
        const newest = list[0]?.lastModified;
        if (typeof newest === 'number') activeLabel = formatRelativeTime(newest);
      } catch { /* leave defaults */ }

      // Context files: sum of group sizes from the context discovery.
      let contextFiles = 0;
      try {
        const res = await (window.claude as any).project.listContext(path);
        const groups = res?.groups ?? [];
        contextFiles = groups.reduce(
          (acc: number, g: { files?: unknown[] }) => acc + (g.files?.length ?? 0), 0);
      } catch { /* leave 0 */ }

      // Artifacts: WHY live count of non-deleted artifacts from the sidecar — the
      // stored stats.artifactCount is seeded to 0 and almost always stale.
      let artifacts = 0;
      try {
        const res = await (window.claude as any).artifacts.listProject(id);
        const list = res?.artifacts ?? [];
        artifacts = list.filter((a: { status?: string }) => a.status !== 'deleted').length;
      } catch { /* leave 0 */ }

      // Repo: only surface when there's a real web URL to outlink to.
      let repo: HeroRepo | null = null;
      try {
        const res = await (window.claude as any).project.repoInfo(path);
        if (res?.hasRepo && res.webUrl) {
          repo = { webUrl: res.webUrl, owner: res.owner, name: res.name };
        }
      } catch { /* leave null */ }

      if (cancelled) return;
      setHeroStats({ artifacts, conversations, contextFiles, activeLabel });
      setHeroRepo(repo);
    })();
    return () => { cancelled = true; };
  }, [activeProject?.id, activeProject?.path]);

  if (!state.projectViewOpen) return null;

  // Add-a-project (v1): a project only enters the index once a session runs in
  // its folder, so there's no folder-register flow to kick off here. The switcher
  // shows its own inline "start a session in a folder to add it" hint on click,
  // so this is intentionally a no-op (closing the palette would hide the hint).
  // Don't invent a folder-registration path.
  const handleAddProject = () => {
    /* no-op — ProjectSwitcher surfaces the inline hint itself */
  };

  const confirmDelete = async () => {
    if (!deletingProject) return;
    await (window.claude as any).artifacts.deleteProject(deletingProject.id, alsoDeleteSidecar);
    // Refresh project list after deletion.
    const res = await (window.claude as any).artifacts.listProjectsIndex();
    if (res && res.ok) {
      setProjects(res.projects);
      // If we deleted the active project, select the first remaining one.
      setActiveProject((prev) =>
        prev?.id === deletingProject.id ? (res.projects[0] ?? null) : prev
      );
    }
    setDeletingProject(null);
    setAlsoDeleteSidecar(false);
  };

  // Filter the project list by the global search box (matches name + path).
  const q = search.trim().toLowerCase();
  const visibleProjects = q
    ? projects.filter((p) =>
        p.name.toLowerCase().includes(q) || p.path.toLowerCase().includes(q))
    : projects;

  const SEGMENTS: { id: TabId; label: string }[] = [
    { id: 'artifacts', label: 'Artifacts' },
    { id: 'conversations', label: 'Conversations' },
    { id: 'context', label: 'Context' },
  ];

  return (
    <div className="fixed inset-0 bg-canvas z-[8000] flex flex-col">
      {/* Header: title + global search + Esc·Close */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-edge shrink-0">
        <h2 className="text-base font-semibold text-fg shrink-0">Projects</h2>
        <input
          type="text"
          placeholder="Search projects…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 max-w-md px-3 py-1.5 text-sm bg-inset rounded-sm border border-edge placeholder:text-fg-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <div className="flex-1" />
        <button
          type="button"
          className="flex items-center gap-1.5 px-2 py-1 rounded-sm text-xs text-fg-muted hover:text-fg hover:bg-inset transition-colors shrink-0"
          onClick={() => dispatch({ type: 'PROJECT_VIEW_CLOSED' })}
          title="Close Projects"
          aria-label="Close Projects"
        >
          <span className="text-[10px] tracking-wider uppercase">Esc</span>
          <span>Close</span>
        </button>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar — project list */}
        <aside className="w-[220px] shrink-0 border-r border-edge overflow-y-auto p-2 flex flex-col gap-1">
          <h3 className="text-[10px] font-semibold text-fg-muted uppercase tracking-wider px-2 py-1">
            Projects
          </h3>

          {visibleProjects.length === 0 && (
            <p className="text-xs text-fg-muted px-2 py-2 leading-relaxed">
              {q
                ? 'No projects match your search.'
                : 'No projects yet. Start a session in a folder to create one.'}
            </p>
          )}

          {visibleProjects.map((p) => (
            // WHY: `group` enables hover-revealed delete button via group-hover.
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
              {/* Delete button — hover-revealed to avoid visual clutter. */}
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
        </aside>

        {/* Main column — hero + segmented control + active tab */}
        <main className="flex-1 flex flex-col overflow-hidden min-w-0">
          {activeProject ? (
            <div className="px-4 pt-4 pb-3 shrink-0">
              <ProjectHero
                project={activeProject}
                stats={heroStats}
                repo={heroRepo}
                onOpenSwitcher={() => setSwitcherOpen(true)}
                onNewConversation={props.onNewConversation}
              />
            </div>
          ) : (
            <div className="px-4 pt-4 pb-3 border-b border-edge shrink-0 text-sm text-fg-muted">
              Select a project to view its artifacts.
            </div>
          )}

          {/* Segmented control — accent used ONCE per view (the active chip). */}
          <div className="px-4 py-3 shrink-0">
            <div className="inline-flex items-center gap-1.5">
              {SEGMENTS.map((s) => {
                const active = tab === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    className={`px-3 py-1 rounded-full text-xs transition-colors ${
                      active
                        ? 'bg-accent text-on-accent'
                        : 'bg-inset text-fg-2 border border-edge hover:text-fg'
                    }`}
                    onClick={() => setTab(s.id)}
                  >
                    {s.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tab routing */}
          <div className="flex-1 overflow-hidden min-h-0">
            {activeProject && tab === 'artifacts' && (
              <ArtifactsTab project={activeProject} />
            )}
            {activeProject && tab === 'conversations' && (
              <ConversationsTab project={activeProject} onOpenPreview={setPreviewSession} />
            )}
            {/* TODO(Task 3.2): render <ConversationPreview> when previewSession is set */}
            {tab === 'context' && (
              <div className="p-6 text-fg-muted">Coming in a later task</div>
            )}
          </div>
        </main>
      </div>

      {/* Project switcher (command palette) — Task 2.3. */}
      {switcherOpen && (
        <ProjectSwitcher
          projects={projects}
          activeId={activeProject?.id ?? null}
          onSelect={(p) => { setActiveProject(p); setSwitcherOpen(false); }}
          onClose={() => setSwitcherOpen(false)}
          onAddProject={handleAddProject}
        />
      )}

      {/* Project deletion confirmation modal */}
      {deletingProject && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9000]"
          onClick={() => setDeletingProject(null)}
        >
          <div
            className="layer-surface p-6 max-w-md w-full mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold mb-2 text-fg">Remove project</h3>
            <p className="mb-3 text-sm text-fg">
              Remove "<span className="font-medium">{deletingProject.name}</span>" from YouCoded?
            </p>
            <p className="text-sm text-fg-muted mb-3">
              The project folder and its files will NOT be deleted. You can re-discover
              this project by launching a session in that folder again.
            </p>
            <label className="flex items-center gap-2 mb-4 text-sm cursor-pointer text-fg">
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
                className="px-3 py-1.5 rounded-sm border border-edge hover:bg-inset text-sm transition-colors"
                onClick={() => { setDeletingProject(null); setAlsoDeleteSidecar(false); }}
              >
                Cancel
              </button>
              <button
                type="button"
                className="px-3 py-1.5 rounded-sm bg-red-600 text-white hover:bg-red-700 text-sm transition-colors"
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
