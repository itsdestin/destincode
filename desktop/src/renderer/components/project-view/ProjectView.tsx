// ProjectView — full-screen overlay shell for the project browser (Task 2.1 redesign).
// Opened by the Projects button in HeaderBar (or via dispatch({ type: 'PROJECT_VIEW_OPENED' })).
// Renders nothing when state.projectViewOpen is false.
// z-[8000]: below SessionStrip dropdown (9000) but above all other overlays (L2 = 61).
//
// This file is the composed SHELL: header + project list + segmented tab control +
// tab routing. The artifact grid lives in tabs/FilesTab; Conversations/Context
// tabs are filled by later tasks. The project-deletion modal + project list stay
// here (project-scoped). The "+ Add external file" affordance moved into
// FilesTab (artifact-scoped) since it operates on the active project's artifacts.
import React, { useEffect, useRef, useState } from 'react';
import { useArtifact } from '../../state/ArtifactContext';
import { useTheme } from '../../state/theme-context';
import { useEscClose } from '../../hooks/use-esc-close';
import { Scrim, OverlayPanel } from '../overlays/Overlay';
import { formatRelativeTime } from '../../utils/format-time';
import type { CentralIndexProject } from '../../../shared/artifacts/types';
import type { PastSession } from '../../../shared/types';
import type { ContextFile, ContextGroup, ContextScope } from '../../../shared/project-context-types';

// Enriched session shape returned by project:list-conversations (preview only —
// see project-conversations.ts for why there's no message count).
type ConversationSummary = PastSession & { preview?: string };
import { FilesTab } from './tabs/FilesTab';
import { ConversationsTab } from './tabs/ConversationsTab';
import { ContextTab } from './tabs/ContextTab';
import { ConversationPreview } from './ConversationPreview';
import { ProjectHero } from './ProjectHero';
import { ProjectSwitcher } from './ProjectSwitcher';
import { HowContextWorksPopup } from './HowContextWorksPopup';
import { ContextEditorOverlay } from './ContextEditorOverlay';

type TabId = 'artifacts' | 'allfiles' | 'conversations' | 'context';

// Live hero stats, computed from the project:* / artifacts:* IPC (not the stale
// stats.artifactCount). null repo means the project folder has no git remote.
// CORE PRINCIPLE: `artifacts` (Claude-authored) and `files` (all on-disk docs)
// are DISTINCT counts — never the same number.
interface HeroStats {
  artifacts: number;
  files: number;
  conversations: number;
  contextFiles: number;
  activeLabel: string;
}
interface HeroRepo { webUrl?: string; owner?: string; name?: string }


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
function FolderTabIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
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
  // SessionDrawer). The seg-row chips here toggle them; FilesTab reads them.
  const {
    showDeletedArtifacts, setShowDeletedArtifacts,
  } = useTheme();
  const [projects, setProjects] = useState<CentralIndexProject[]>([]);
  const [activeProject, setActiveProject] = useState<CentralIndexProject | null>(null);
  const [tab, setTab] = useState<TabId>('artifacts');
  // Artifacts search query (lifted out of FilesTab so it can sit on the
  // shared seg-row next to the segmented control, matching the design).
  const [artifactSearch, setArtifactSearch] = useState('');
  // Bumped after "Add external file" so FilesTab re-loads its list without
  // owning the add flow (the toolbar lives up here now).
  const [refreshKey, setRefreshKey] = useState(0);
  // Bumped by FilesTab after an in-tab sidecar mutation (exclude) so the hero
  // counts refetch WITHOUT forcing a FilesTab reload (which would reset the
  // breadcrumb + selection). refreshKey and countsKey both feed the hero
  // effect; only refreshKey feeds FilesTab.
  const [countsKey, setCountsKey] = useState(0);

  // Hero data (recomputed when the active project changes).
  const [heroStats, setHeroStats] = useState<HeroStats>({
    artifacts: 0, files: 0, conversations: 0, contextFiles: 0, activeLabel: '—',
  });
  const [heroRepo, setHeroRepo] = useState<HeroRepo | null>(null);

  // Lifted, per-project-cached tab data. Both the hero counts and the tab bodies
  // read these, so conversations/context are fetched ONCE per project switch
  // (not once for the hero AND once for the tab) and re-selecting a project or
  // toggling tabs is instant. null = still loading for the active project.
  const convCache = useRef<Map<string, ConversationSummary[]>>(new Map());
  const ctxCache = useRef<Map<string, ContextGroup[]>>(new Map());
  // Which project the hero effect last ran for — lets a counts refresh (same
  // project) skip the reset-to-zero that a real project switch needs.
  const prevHeroProjectRef = useRef<string | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[] | null>(null);
  const [context, setContext] = useState<ContextGroup[] | null>(null);

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
  // or a clicked group's (i) info button (to explain the scope) up to here;
  // ContextEditorOverlay / HowContextWorksPopup render them below.
  const [editingContext, setEditingContext] = useState<ContextFile | null>(null);
  const [infoScope, setInfoScope] = useState<ContextScope | null>(null);

  // ESC closes the browser via the shared LIFO stack — the header button is
  // labeled "Esc / Close", so the key must actually work. Child overlays
  // (detail, switcher, editor, delete modal) register later → they pop first.
  useEscClose(state.projectViewOpen, () => dispatch({ type: 'PROJECT_VIEW_CLOSED' }));
  // The delete-confirm modal takes Esc priority while open (registered after
  // the browser's own handler because it mounts later — LIFO).
  useEscClose(!!deletingProject, () => { setDeletingProject(null); setAlsoDeleteSidecar(false); });

  // Load the projects index whenever the view is opened. Hooks MUST run before
  // any early return — Rules of Hooks. Don't move below the projectViewOpen guard
  // or React throws "Rendered more hooks than during the previous render".
  useEffect(() => {
    if (!state.projectViewOpen) return;
    // Fresh data each time the browser is opened — the caches only de-duplicate
    // within a single open session (project switches / tab toggles), so clear
    // them on open so newly-created conversations/context show up.
    convCache.current.clear();
    ctxCache.current.clear();
    let cancelled = false;
    // Phase 1: fast list (sidecar-only counts) so the list/switcher appears
    // instantly and a project is selected without waiting on disk scans.
    (window.claude as any).artifacts.listProjectsIndex().then((res: any) => {
      if (cancelled || !res?.ok) return;
      setProjects(res.projects);
      // Auto-select the first project if nothing is selected (or the
      // previously-selected project is no longer in the list).
      setActiveProject((prev) => {
        // Match by PATH, not id: a synth (saved-folder) project's id is its
        // canonical path until it gains a central-index entry, at which point
        // its id changes to a real ULID — matching by path keeps the selection
        // stable across that promotion.
        if (prev && res.projects.some((p: CentralIndexProject) => p.path === prev.path)) return prev;
        return res.projects.length > 0 ? res.projects[0] : null;
      });
      // Phase 2: real file + conversation counts (on-disk discovery + a global
      // session scan) merged in when ready — progressively enhances the switcher's
      // "files · chats" hint without blocking the initial render.
      (window.claude as any).artifacts.listProjectsIndex({ withCounts: true }).then((res2: any) => {
        if (cancelled || !res2?.ok) return;
        setProjects(res2.projects);
      });
    });
    return () => { cancelled = true; };
  }, [state.projectViewOpen]);

  // Compute hero data + tab data whenever the active project changes. The four
  // IPC calls run in PARALLEL (Promise.all) so first paint waits on the slowest,
  // not the sum. Conversations + context are fetched-or-reused-from-cache once
  // and feed BOTH the hero counts AND the tab bodies (no duplicate fetch). A
  // `cancelled` flag guards against the project switching mid-flight.
  useEffect(() => {
    if (!activeProject) {
      setHeroStats({ artifacts: 0, files: 0, conversations: 0, contextFiles: 0, activeLabel: '—' });
      setHeroRepo(null);
      setConversations(null);
      setContext(null);
      return;
    }
    let cancelled = false;
    const { id, path } = activeProject;
    // Reset ONLY when the project actually changed — a refreshKey/countsKey
    // bump (Add file, exclude) refetches the counts in place without flashing
    // the hero back to zeros or re-seeding the tab data.
    const projectChanged = prevHeroProjectRef.current !== id;
    prevHeroProjectRef.current = id;
    if (projectChanged) {
      // Reset immediately so the PREVIOUS project's repo/stats don't linger while
      // the new project's data loads. Seed tab data from cache (instant) or null
      // (shows the tab's "Loading…" until the fetch resolves).
      setHeroStats({ artifacts: 0, files: 0, conversations: 0, contextFiles: 0, activeLabel: '…' });
      setHeroRepo(null);
      setConversations(convCache.current.get(id) ?? null);
      setContext(ctxCache.current.get(id) ?? null);
    }

    // Cache-or-fetch helpers — the cache makes re-selecting a project / toggling
    // tabs instant; the bounded head-read in listProjectConversations keeps the
    // first fetch cheap (no full-transcript parse per session).
    const getConversations = async (): Promise<ConversationSummary[]> => {
      const cached = convCache.current.get(id);
      if (cached) return cached;
      try {
        const res = await (window.claude as any).project.listConversations(path);
        const list: ConversationSummary[] = res?.ok ? (res.conversations ?? []) : [];
        convCache.current.set(id, list);
        return list;
      } catch { return []; }
    };
    const getContext = async (): Promise<ContextGroup[]> => {
      const cached = ctxCache.current.get(id);
      if (cached) return cached;
      try {
        const res = await (window.claude as any).project.listContext(path);
        const groups: ContextGroup[] = res?.ok ? (res.groups ?? []) : [];
        ctxCache.current.set(id, groups);
        return groups;
      } catch { return []; }
    };
    // Live artifact count — delegates to the main-process countVisibleArtifacts
    // helper (via listProject withCount) so the hero, the segment badge, and the
    // project-switcher row all show the SAME number. The helper returns exactly
    // what the Artifacts tab shows with "Show deleted" OFF: non-deleted tracked
    // files that still exist on disk (orphans excluded) plus on-disk discovered
    // docs. No more renderer-side recomputation that could drift from the switcher.
    const getArtifactCount = async (): Promise<number> => {
      try {
        const res = await (window.claude as any).artifacts.listProject(id, { withCount: true });
        return typeof res?.visibleCount === 'number' ? res.visibleCount : 0;
      } catch { return 0; }
    };
    // ALL FILES count — the project folder's on-disk documents (DISTINCT from the
    // artifact count). Shares main's discovery cache with the All files tab, so
    // this and the tab don't double-scan.
    const getAllFilesCount = async (): Promise<number> => {
      try {
        const res = await (window.claude as any).artifacts.listAllFiles(id);
        return res?.ok && Array.isArray(res.files) ? res.files.length : 0;
      } catch { return 0; }
    };

    (async () => {
      const [convs, ctxGroups, artifactCount, fileCount, repoRes] = await Promise.all([
        getConversations(),
        getContext(),
        getArtifactCount(),
        getAllFilesCount(),
        (window.claude as any).project.repoInfo(path).catch(() => null),
      ]);
      if (cancelled) return;

      // Feed the tab bodies.
      setConversations(convs);
      setContext(ctxGroups);

      // Hero counts (live — NOT the stale stored stats.artifactCount).
      const conversationCount = convs.length;
      const newest = convs[0]?.lastModified; // listPastSessions is newest-first
      const activeLabel = typeof newest === 'number' ? formatRelativeTime(newest) : 'never';
      const contextFiles = ctxGroups.reduce((acc, g) => acc + (g.files?.length ?? 0), 0);
      const repo: HeroRepo | null = repoRes?.hasRepo && repoRes.webUrl
        ? { webUrl: repoRes.webUrl, owner: repoRes.owner, name: repoRes.name }
        : null;

      setHeroStats({
        artifacts: artifactCount,
        files: fileCount,
        conversations: conversationCount,
        contextFiles,
        activeLabel,
      });
      setHeroRepo(repo);
    })();
    return () => { cancelled = true; };
    // refreshKey (Add file) + countsKey (in-tab exclude) re-run this to keep the
    // hero/segment counts LIVE — the redesign's core promise. Conversations and
    // context come back from the per-project cache on those refreshes (instant).
  }, [activeProject?.id, activeProject?.path, refreshKey, countsKey]);

  if (!state.projectViewOpen) return null;

  // Add a project = add a saved folder. The project list IS the saved-folders
  // store (youcoded-folders.json) now, so a real add flow exists: browse for a
  // folder → folders.add → refresh the list and select it. (An earlier v1
  // comment said no register flow existed — that predated the saved-folders
  // refactor.)
  const handleAddProject = async () => {
    setSwitcherOpen(false);
    try {
      const folder: string | null = await (window.claude as any).dialog.openFolder();
      if (!folder) return;
      await (window.claude as any).folders.add(folder);
      const res = await (window.claude as any).artifacts.listProjectsIndex({ withCounts: true });
      if (res?.ok) {
        setProjects(res.projects);
        // Select the newly-added folder (match by path suffix-insensitively via
        // the canonical path the index builder stores).
        const added = res.projects.find(
          (p: CentralIndexProject) => p.path.replace(/\\/g, '/').toLowerCase() === folder.replace(/\\/g, '/').toLowerCase()
        );
        if (added) setActiveProject(added);
      }
    } catch { /* dialog unavailable (remote/Android) — leave the list as-is */ }
  };

  const confirmDelete = async () => {
    if (!deletingProject) return;
    // The project list IS the saved-folders store now, so "Remove" removes the
    // folder from that store (which also drops it from the new-session folder
    // picker). Optionally wipe the artifact-history sidecar + any index entry.
    await (window.claude as any).folders.remove(deletingProject.path);
    if (alsoDeleteSidecar) {
      await (window.claude as any).artifacts.deleteProject(deletingProject.id, true).catch(() => {});
    }
    // Refresh project list after removal.
    const res = await (window.claude as any).artifacts.listProjectsIndex({ withCounts: true });
    if (res && res.ok) {
      setProjects(res.projects);
      // If we removed the active project, select the first remaining one.
      setActiveProject((prev) =>
        prev?.path === deletingProject.path ? (res.projects[0] ?? null) : prev
      );
    }
    setDeletingProject(null);
    setAlsoDeleteSidecar(false);
  };

  // Add an external file to the active project, then trigger an FilesTab
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
  // CORE PRINCIPLE: Artifacts (Claude-authored) and All files (everything on disk)
  // are separate sections with separate counts.
  const SEGMENTS: { id: TabId; label: string; icon: React.ReactNode; count: number }[] = [
    { id: 'artifacts', label: 'Artifacts', icon: <GridIcon />, count: heroStats.artifacts },
    { id: 'allfiles', label: 'All files', icon: <FolderTabIcon />, count: heroStats.files },
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

              {/* Right controls for the two file sections. Search applies to both.
                  Mode-specific chips: "Show deleted" + "Add file" belong to the
                  Artifacts (tracked) section; "Hide code & configs" declutters the
                  All files browser. Conversations/Context have no toolbar in v1. */}
              {(tab === 'artifacts' || tab === 'allfiles') && activeProject && (
                <div className="flex items-center gap-2">
                  {/* Compact search field (theme rounded-md), matches the prototype. */}
                  <div className="flex items-center gap-2 bg-inset border border-edge rounded-md px-3 py-1.5 w-[220px]">
                    <span className="text-fg-muted shrink-0"><SearchGlyph size={15} /></span>
                    <input
                      type="text"
                      placeholder={tab === 'allfiles' ? 'Search files…' : 'Search artifacts…'}
                      value={artifactSearch}
                      onChange={(e) => setArtifactSearch(e.target.value)}
                      className="bg-transparent outline-none text-[13px] text-fg w-full placeholder:text-fg-muted"
                    />
                  </div>
                  {/* Show deleted + Add file — Artifacts (tracked) section only.
                      All files has no filter chips: it shows every file, so its
                      badge count always matches what's on screen (and is always a
                      superset of Artifacts). */}
                  {tab === 'artifacts' && (
                    <>
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
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Tab routing — shares the centered max-width with the chrome above. */}
          <div className="flex-1 overflow-hidden min-h-0 w-full max-w-[1100px] mx-auto">
            {activeProject && tab === 'artifacts' && (
              <FilesTab project={activeProject} search={artifactSearch} refreshKey={refreshKey} mode="artifacts" onMutated={() => setCountsKey((k) => k + 1)} />
            )}
            {activeProject && tab === 'allfiles' && (
              <FilesTab project={activeProject} search={artifactSearch} refreshKey={refreshKey} mode="allfiles" onMutated={() => setCountsKey((k) => k + 1)} />
            )}
            {activeProject && tab === 'conversations' && (
              <ConversationsTab conversations={conversations} onOpenPreview={setPreviewSession} />
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
                groups={context}
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

      {/* Project deletion confirmation modal — L3 (destructive confirmation)
          via the shared overlay primitives so scrim/surface/z-index come from
          theme tokens; Esc is handled by the useEscClose above. */}
      {deletingProject && (
        <>
          <Scrim layer={3} onClick={() => { setDeletingProject(null); setAlsoDeleteSidecar(false); }} />
          <OverlayPanel
            layer={3}
            destructive
            role="dialog"
            aria-modal={true}
            aria-label="Remove project"
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 p-6 max-w-md w-[calc(100%-2rem)]"
          >
            <h3 className="text-lg font-semibold mb-2 text-fg">Remove project</h3>
            <p className="mb-3 text-sm text-fg">
              Remove "<span className="font-medium">{deletingProject.name}</span>" from YouCoded?
            </p>
            <p className="text-sm text-fg-muted mb-3">
              The folder and its files are NOT deleted — this only removes it from your
              YouCoded folders, so it also disappears from the new-session folder picker.
              You can add it back anytime with "Add a project" in the project switcher.
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
          </OverlayPanel>
        </>
      )}
    </div>
  );
}
