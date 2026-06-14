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
import { useTheme } from '../../state/theme-context';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import type { PastSession } from '../../../shared/types';
import type { ContextFile, ContextScope } from '../../../shared/project-context-types';
import { ArtifactsTab } from './tabs/ArtifactsTab';
import { ConversationsTab } from './tabs/ConversationsTab';
import { ContextTab } from './tabs/ContextTab';
import { ConversationPreview } from './ConversationPreview';
import { ProjectHero } from './ProjectHero';
import { ProjectSwitcher } from './ProjectSwitcher';
import { HowContextWorksPopup } from './HowContextWorksPopup';
import { ContextEditorOverlay } from './ContextEditorOverlay';

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

// Inline lucide-style tab icons (stroke currentColor) for the segmented control.
function GridIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}
function ChatIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function DocIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
    </svg>
  );
}
function SearchGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}

interface ProjectViewProps {
  // Threaded from App: starts a new conversation in the given cwd.
  onNewConversation: (cwd: string) => void;
  onResumeConversation: (sessionId: string, projectSlug: string, projectPath: string) => void;
}

export function ProjectView(props: ProjectViewProps) {
  const { state, dispatch } = useArtifact();
  // Artifact filter toggles live in the shared theme context (also read by the
  // SessionDrawer). The seg-row chips here toggle them; ArtifactsTab reads them.
  const {
    hideCodeAndConfigs, setHideCodeAndConfigs,
    showDeletedArtifacts, setShowDeletedArtifacts,
  } = useTheme();
  const [projects, setProjects] = useState<CentralIndexProject[]>([]);
  const [activeProject, setActiveProject] = useState<CentralIndexProject | null>(null);
  const [tab, setTab] = useState<TabId>('artifacts');
  // Artifacts search query (lifted out of ArtifactsTab so it can sit on the
  // shared seg-row next to the segmented control, matching the design).
  const [artifactSearch, setArtifactSearch] = useState('');
  // Bumped after "Add external file" so ArtifactsTab re-loads its list without
  // owning the add flow (the toolbar lives up here now).
  const [refreshKey, setRefreshKey] = useState(0);

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

  // Context tab selection state. The ContextTab bubbles a clicked file (to edit)
  // or a clicked group's (i) info button (to explain the scope) up to here. The
  // editor + info popup themselves are built by Tasks 4.4 / 4.3 — these setters
  // are stored-but-not-yet-rendered for now (intentional; noUnusedLocals is off).
  const [editingContext, setEditingContext] = useState<ContextFile | null>(null);
  const [infoScope, setInfoScope] = useState<ContextScope | null>(null);

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
    // Reset immediately so the PREVIOUS project's repo/stats don't linger while
    // the new project's data loads — fixes the belated appear/disappear of the
    // GitHub outlink (and stale counts) when switching projects.
    setHeroStats({ artifacts: 0, conversations: 0, contextFiles: 0, activeLabel: '…' });
    setHeroRepo(null);
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

  // Add an external file to the active project, then trigger an ArtifactsTab
  // reload. window.claude.dialog.openFile() returns a string[] of paths.
  const addExternal = async () => {
    if (!activeProject) return;
    const paths: string[] = await (window.claude as any).dialog.openFile();
    if (!paths || paths.length === 0) return;
    await Promise.all(
      paths.map((p) => (window.claude as any).artifacts.includeExternal(activeProject.path, p)),
    );
    setRefreshKey((k) => k + 1);
  };

  // Unified segmented control: icon + label + live count per tab.
  const SEGMENTS: { id: TabId; label: string; icon: React.ReactNode; count: number }[] = [
    { id: 'artifacts', label: 'Artifacts', icon: <GridIcon />, count: heroStats.artifacts },
    { id: 'conversations', label: 'Conversations', icon: <ChatIcon />, count: heroStats.conversations },
    { id: 'context', label: 'Context', icon: <DocIcon />, count: heroStats.contextFiles },
  ];

  return (
    <div className="fixed inset-0 bg-canvas z-[8000] flex flex-col">
      {/* Header: title + global search + Esc·Close */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-edge shrink-0">
        <h2 className="text-base font-semibold text-fg shrink-0">Projects</h2>
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
        {/* Main column — hero + segmented control + active tab. There is no
            project rail anymore; switching projects goes through the palette
            (ProjectSwitcher) opened from the hero name, and project removal
            lives on the palette rows. */}
        <main className="flex-1 flex flex-col overflow-hidden min-w-0">
          {/* Chrome: hero + seg-row, centered to a comfortable reading width to
              match the prototype (the tab body below shares the same max-width). */}
          <div className="w-full max-w-[1100px] mx-auto px-4 pt-4 shrink-0 flex flex-col gap-4">
            {activeProject ? (
              <ProjectHero
                project={activeProject}
                stats={heroStats}
                repo={heroRepo}
                onOpenSwitcher={() => setSwitcherOpen(true)}
                onNewConversation={props.onNewConversation}
              />
            ) : (
              <div className="text-sm text-fg-muted">Select a project to view its artifacts.</div>
            )}

            {/* Seg-row: unified segmented control (left) + the active tab's
                search/filter controls (right), on one row — matches the design. */}
            <div className="flex items-center justify-between gap-3 flex-wrap">
              {/* Unified segmented control: one rounded-full pill holding all three
                  segments (icon + label + count). Accent used ONCE — the active seg. */}
              <div
                className="flex items-center gap-1 p-1 layer-surface !rounded-full"
                style={{ boxShadow: 'none' }}
              >
                {SEGMENTS.map((s) => {
                  const active = tab === s.id;
                  return (
                    <button
                      key={s.id}
                      type="button"
                      className={`px-3.5 py-1.5 rounded-full text-[13px] font-medium inline-flex items-center gap-2 transition-colors ${
                        active
                          ? 'bg-accent text-on-accent'
                          : 'text-fg-2 hover:text-fg hover:bg-inset'
                      }`}
                      onClick={() => setTab(s.id)}
                    >
                      {s.icon}
                      {s.label}
                      <span className={`text-[11px] ${active ? 'opacity-80' : 'text-fg-muted'}`}>
                        {s.count}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Right controls — artifacts tab only (search + filter chips +
                  add-external). Conversations/Context have no toolbar in v1. */}
              {tab === 'artifacts' && activeProject && (
                <div className="flex items-center gap-2">
                  {/* Compact search field (theme rounded-md), matches the prototype. */}
                  <div className="flex items-center gap-2 bg-inset border border-edge rounded-md px-3 py-1.5 w-[220px]">
                    <span className="text-fg-muted shrink-0"><SearchGlyph size={15} /></span>
                    <input
                      type="text"
                      placeholder="Search artifacts…"
                      value={artifactSearch}
                      onChange={(e) => setArtifactSearch(e.target.value)}
                      className="bg-transparent outline-none text-[13px] text-fg w-full placeholder:text-fg-muted"
                    />
                  </div>
                  {/* Filter chips — rounded-full, accent fill when active. */}
                  <button
                    type="button"
                    className={`px-3 py-1 rounded-full text-[12.5px] transition-colors ${
                      hideCodeAndConfigs
                        ? 'bg-accent text-on-accent'
                        : 'bg-inset text-fg-2 border border-edge hover:text-fg hover:border-edge-dim'
                    }`}
                    onClick={() => setHideCodeAndConfigs(!hideCodeAndConfigs)}
                    title={hideCodeAndConfigs
                      ? 'Showing Documents and Mockups only. Click to show all.'
                      : 'Showing all files. Click to hide code & configs.'}
                  >
                    Hide code &amp; configs
                  </button>
                  <button
                    type="button"
                    className={`px-3 py-1 rounded-full text-[12.5px] transition-colors ${
                      showDeletedArtifacts
                        ? 'bg-accent text-on-accent'
                        : 'bg-inset text-fg-2 border border-edge hover:text-fg hover:border-edge-dim'
                    }`}
                    onClick={() => setShowDeletedArtifacts(!showDeletedArtifacts)}
                    title={showDeletedArtifacts
                      ? 'Including deleted files in the grid. Click to hide them.'
                      : 'Hiding deleted files. Click to include them.'}
                  >
                    Show deleted
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1 rounded-full text-[12.5px] bg-inset text-fg-2 border border-edge hover:text-fg hover:border-edge-dim transition-colors"
                    onClick={addExternal}
                    title="Add an external file to this project"
                  >
                    + Add file
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Tab routing — shares the centered max-width with the chrome above. */}
          <div className="flex-1 overflow-hidden min-h-0 w-full max-w-[1100px] mx-auto">
            {activeProject && tab === 'artifacts' && (
              <ArtifactsTab project={activeProject} search={artifactSearch} refreshKey={refreshKey} />
            )}
            {activeProject && tab === 'conversations' && (
              <ConversationsTab project={activeProject} onOpenPreview={setPreviewSession} />
            )}
            {previewSession && activeProject && (
              <ConversationPreview
                project={activeProject}
                session={previewSession}
                onClose={() => setPreviewSession(null)}
                onResume={(s) => {
                  // WHY: resume closes Project View and launches/resumes the session
                  // (handled by the App-threaded prop), then drops the preview.
                  props.onResumeConversation(s.sessionId, s.projectSlug, s.projectPath);
                  setPreviewSession(null);
                }}
              />
            )}
            {activeProject && tab === 'context' && (
              <ContextTab
                project={activeProject}
                onEditFile={setEditingContext}
                onOpenInfo={setInfoScope}
              />
            )}
            {/* How-context-works teaching popup. Map the clicked scope to an
                initial tab: memory → Memory page, project/global → Overview
                (the broad→specific stack covers both). */}
            {infoScope && (
              <HowContextWorksPopup
                initialTab={infoScope === 'memory' ? 'memory' : 'overview'}
                onClose={() => setInfoScope(null)}
              />
            )}
            {/* Context editor overlay — view/edit an agent-context file with a
                blast-radius warning (amber + save-confirm for global files,
                neutral + direct save for project files). */}
            {editingContext && activeProject && (
              <ContextEditorOverlay
                project={activeProject}
                file={editingContext}
                onClose={() => setEditingContext(null)}
              />
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
          onDeleteProject={(p) => setDeletingProject(p)}
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
