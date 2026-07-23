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
import type { FileTypeGroup } from '../../../shared/artifacts/categorization';
import type { FileSortKey } from './tabs/FilesTab';

// Enriched session shape returned by project:list-conversations (preview only —
// see project-conversations.ts for why there's no message count).
type ConversationSummary = PastSession & { preview?: string };
import { FilesTab } from './tabs/FilesTab';
import { ConversationsTab } from './tabs/ConversationsTab';
import { ContextTab } from './tabs/ContextTab';
import { ConversationPreview } from './ConversationPreview';
import { ProjectHero, formatFileCount } from './ProjectHero';
import { ProjectSwitcher } from './ProjectSwitcher';
import { syncDotFor, findSpaceFor, lastSyncedLabel, type SyncStatusData } from '../sync-dot-state';
import AddProjectModal from './AddProjectModal';
import ImportProjectModal from '../ImportProjectModal';
import { FileFilterPopover } from './FileFilterPopover';
import { HowContextWorksPopup } from './HowContextWorksPopup';
import { ContextEditorOverlay } from './ContextEditorOverlay';

type TabId = 'artifacts' | 'allfiles' | 'conversations' | 'context';

// Live hero stats, computed from the project:* / artifacts:* IPC (not the stale
// stats.artifactCount). null repo means the project folder has no git remote.
// CORE PRINCIPLE: `artifacts` (Claude-authored) and `files` (all on-disk docs)
// are DISTINCT counts — never the same number.
interface HeroStats {
  artifacts: number;
  // null = gated root (home dir / drive root — no scan runs, no number).
  files: number | null;
  // Discovery hit a cap — render "N+" so a sample never poses as exact.
  filesTruncated?: boolean;
  conversations: number;
  contextFiles: number;
  activeLabel: string;
}
interface HeroRepo { webUrl?: string; owner?: string; name?: string }


// Shared lucide-style glyphs live in ./icons.tsx (previously each file carried
// its own copies of the same paths). GridIcon is the one glyph unique to this
// file — the Artifacts segment icon.
import { InfoIcon, ChatIcon, FolderIcon, DocIcon } from './icons';
import { Button, Checkbox, SearchFilterPill } from '../ui';

function GridIcon({ size = 15 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" />
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
  // Type filter + sort for the two file tabs — lifted here (like search) so they
  // live on the seg-row and survive Artifacts ↔ All files toggles. These are
  // EXPLICIT, visible controls the user sets — the badge counts stay folder
  // totals, so a filtered grid never silently redefines what "N files" means.
  // Multi-select type filter; EMPTY set = all types (Destin, 2026-07-23).
  const [types, setTypes] = useState<ReadonlySet<FileTypeGroup>>(() => new Set());
  const [fileSort, setFileSort] = useState<FileSortKey>('name');
  // Filter popover (behind the sliders icon in the search pill). Click-outside
  // is handled HERE with a wrapper ref that contains both the trigger and the
  // popover — putting it inside the popover would race the trigger's own click
  // (mousedown-close then click-reopen).
  const [filterOpen, setFilterOpen] = useState(false);
  const filterWrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!filterOpen) return;
    const onDown = (e: MouseEvent) => {
      if (filterWrapRef.current && !filterWrapRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [filterOpen]);
  // Close the popover when the active tab changes — its trigger belongs to the
  // file tabs, and leaving it open across a tab switch would strand it.
  useEffect(() => { setFilterOpen(false); }, [tab]);
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

  // Project switcher palette state (rendered at the bottom of this component).
  const [switcherOpen, setSwitcherOpen] = useState(false);

  // Selected conversation for the preview overlay — the ConversationsTab
  // bubbles a click up; <ConversationPreview> renders it below.
  const [previewSession, setPreviewSession] = useState<PastSession | null>(null);

  // Project deletion modal state.
  const [deletingProject, setDeletingProject] = useState<CentralIndexProject | null>(null);
  const [alsoDeleteSidecar, setAlsoDeleteSidecar] = useState(false);

  // Per-project sync state (spec §4) — feeds the hero sync line + switcher dots.
  const [syncStatus, setSyncStatus] = useState<SyncStatusData | null>(null);
  // Unified "Add a project" modal (replaces the old direct folder-picker flow).
  const [addOpen, setAddOpen] = useState(false);
  // Turn-on-sync consent modal for the ACTIVE project (hero button).
  const [turnOnSyncFor, setTurnOnSyncFor] = useState<{ path: string; name: string } | null>(null);

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
      // Filters describe ONE project's grid — a stale query/type from the last
      // project silently hiding the new project's files is a confusion trap.
      // Sort is a preference, not a filter, so it persists.
      setArtifactSearch('');
      setTypes(new Set());
      setFilterOpen(false);
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
    // ALL FILES count — the project folder's on-disk files (DISTINCT from the
    // artifact count). Shares main's discovery cache with the All files tab, so
    // this and the tab don't double-scan. Gated roots (home dir / drive root)
    // return { gated } with NO scan → null here → the stat renders "—".
    const getAllFilesCount = async (): Promise<{ count: number | null; truncated: boolean }> => {
      try {
        const res = await (window.claude as any).artifacts.listAllFiles(id);
        if (res?.gated) return { count: null, truncated: false };
        return res?.ok && Array.isArray(res.files)
          ? { count: res.files.length, truncated: !!res.truncated }
          : { count: 0, truncated: false };
      } catch { return { count: 0, truncated: false }; }
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
        files: fileCount.count,
        filesTruncated: fileCount.truncated || undefined,
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

  // Per-project sync state for the hero + switcher dots. Refetched whenever the
  // view opens, the project list refreshes (add/exclude), or the active project
  // changes. catch → null (Android has no syncspaces handlers; the UI simply
  // shows no sync affordances when status is unavailable).
  useEffect(() => {
    if (!state.projectViewOpen) return;
    let cancelled = false;
    (window.claude as any).syncSpaces.status()
      .then((s: SyncStatusData) => { if (!cancelled) setSyncStatus(s); })
      .catch(() => { if (!cancelled) setSyncStatus(null); });
    return () => { cancelled = true; };
  }, [state.projectViewOpen, refreshKey, countsKey, activeProject?.path]);

  // Live refresh: "Sync now"/background syncs must update the hero line + dots
  // live; the open-gated fetch alone goes stale (the red→green flip and "Last
  // synced" would sit frozen until the next view-open). The sync engine
  // broadcasts synced/error events on the syncspaces:event push channel —
  // refetch status() on each, trailing-debounced 500ms to coalesce bursts (one
  // sync can emit several events back-to-back). Cleanup drops BOTH the
  // subscription and any pending timer so a late tick can't setState after
  // close/unmount. catch → null, same convention as the fetch above.
  useEffect(() => {
    if (!state.projectViewOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let listChanged = false; // a coalesced 'projects-changed' arrived this batch
    const unsubscribe = (window.claude as any).syncSpaces.onEvent((e: any) => {
      // 'projects-changed' means the managed-project SET changed (a project was
      // materialized/stopped by cross-device discovery) — refetch the project
      // LIST too, not just the sync-status dots (2026-07-13 dogfood fix). Without
      // this, a project synced from another device wouldn't appear in Project
      // View until it was closed and reopened.
      if (e?.type === 'projects-changed') listChanged = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        (window.claude as any).syncSpaces.status()
          .then((s: SyncStatusData) => { if (!cancelled) setSyncStatus(s); })
          .catch(() => { if (!cancelled) setSyncStatus(null); });
        if (listChanged) {
          listChanged = false;
          (window.claude as any).artifacts.listProjectsIndex({ withCounts: true })
            .then((res: any) => {
              if (cancelled || !res?.ok) return;
              setProjects(res.projects);
              // Keep the current selection stable across the refresh (match by
              // path — a synth project's id becomes a ULID once it gains an index
              // entry). Return the FRESH matching object, not the stale `prev`, so
              // the selected project's own counts/displayName/state update too.
              // Auto-select the first project only if nothing is selected yet.
              setActiveProject((prev) => {
                if (prev) {
                  return res.projects.find((p: CentralIndexProject) => p.path === prev.path) ?? prev;
                }
                return res.projects.length > 0 ? res.projects[0] : null;
              });
            })
            .catch(() => { /* next natural refresh recovers the list */ });
        }
      }, 500);
    });
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [state.projectViewOpen]);

  if (!state.projectViewOpen) return null;

  // Add a project = open the unified AddProjectModal (spec §3). It routes to
  // create-new / keep-in-place / move+sync itself — this just opens it (and
  // closes the switcher so the two overlays don't stack).
  const handleAddProject = () => {
    setSwitcherOpen(false);
    setAddOpen(true);
  };

  // Shared post-add handler for EVERY successful add path (create / keep /
  // move+sync) AND the hero's turn-on-sync flow: refresh the project list and
  // select the project at its (possibly new) path. Match by PATH — a synth
  // project's id is its path until it gains a central-index entry.
  const handleAdded = async (path: string) => {
    setAddOpen(false);
    setTurnOnSyncFor(null);
    // try/catch: the modals are already closed by the time this runs, so a
    // listProjectsIndex rejection would otherwise float as an unhandled
    // rejection with no UI to land in. Swallow it — the next natural refresh
    // (view re-open / refreshKey bump) recovers the list.
    try {
      const res = await (window.claude as any).artifacts.listProjectsIndex({ withCounts: true });
      if (res?.ok) {
        setProjects(res.projects);
        const added = res.projects.find(
          (p: CentralIndexProject) => p.path.replace(/\\/g, '/').toLowerCase() === path.replace(/\\/g, '/').toLowerCase()
        );
        if (added) setActiveProject(added);
      }
    } catch (err) {
      console.warn('post-add project list refresh failed', err);
    }
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
  // are separate sections with separate counts. All-files renders via
  // formatFileCount: "N", "N+" (truncated sample), or "—" (gated root, no scan).
  const SEGMENTS: { id: TabId; label: string; icon: React.ReactNode; count: string }[] = [
    { id: 'artifacts', label: 'Artifacts', icon: <GridIcon />, count: String(heroStats.artifacts) },
    { id: 'allfiles', label: 'All files', icon: <FolderIcon />, count: formatFileCount(heroStats.files, heroStats.filesTruncated) },
    { id: 'conversations', label: 'Conversations', icon: <ChatIcon />, count: String(heroStats.conversations) },
    { id: 'context', label: 'Context', icon: <DocIcon />, count: String(heroStats.contextFiles) },
  ];

  // Per-active-project sync props for the hero. `dot` is null when syncStatus is
  // unavailable (Android / status() rejected) → hero renders no sync line. The
  // error message is the latest 'error' engine event for this space (friendly-
  // error contract), surfaced only in the red state.
  const heroDot = activeProject ? syncDotFor(activeProject.path, syncStatus) : null;
  const heroSpace = activeProject ? findSpaceFor(activeProject.path, syncStatus) : null;
  const heroSync = heroDot
    ? {
        dot: heroDot,
        spaceId: heroSpace?.id ?? null,
        lastSynced: heroSpace ? lastSyncedLabel(heroSpace.id, syncStatus) : null,
        errorMessage: heroDot.color === 'red'
          ? [...(syncStatus?.recentEvents ?? [])].reverse()
              .find((e) => e.spaceId === heroSpace?.id && e.type === 'error')?.message ?? null
          : null,
        // Review #4: a stopped project must read as a permanent detach, not as
        // the global sync-off state, and must not re-offer "Stop syncing".
        stopped: (heroSpace as any)?.state === 'stopped',
      }
    : null;

  return (
    <div className="fixed inset-0 bg-canvas z-[8000] flex flex-col">
      {/* Header: title + global search + Esc·Close */}
      <header className="flex items-center gap-3 px-4 py-2.5 border-b border-edge shrink-0">
        <h2 className="text-base font-semibold text-fg shrink-0">Projects</h2>
        <div className="flex-1" />
        <Button
          variant="ghost"
          className="shrink-0"
          onClick={() => dispatch({ type: 'PROJECT_VIEW_CLOSED' })}
          title="Close Projects"
          aria-label="Close Projects"
        >
          <span className="text-[10px] tracking-wider uppercase">Esc</span>
          <span>Close</span>
        </Button>
      </header>

      <div className="flex-1 flex overflow-hidden">
        {/* Main column — hero + segmented control + active tab. There is no
            project rail anymore; switching projects goes through the palette
            (ProjectSwitcher) opened from the hero name, and project removal
            lives on the palette rows. */}
        {/* Narrow scrolls as ONE page: the hero scrolls away and the tab
            content keeps going, so a phone isn't stuck reading files through a
            ~200px slot under a hero that never moves. sm+ keeps the fixed-chrome
            layout (hero pinned, body scrolls independently) — there's vertical
            room for it there, and it's the design the view was built around. */}
        <main className="flex-1 flex flex-col max-sm:overflow-y-auto sm:overflow-hidden min-w-0">
          {/* Chrome: hero + seg-row, centered to a comfortable reading width to
              match the prototype (the tab body below shares the same max-width). */}
          {/* px-2 on narrow: stacked gutters (this px-4 plus the hero's own p-5)
              ate 18% of a 390px viewport before any content rendered. */}
          <div className="w-full max-w-[1100px] mx-auto px-2 sm:px-4 pt-4 shrink-0 flex flex-col gap-3 sm:gap-4">
            {activeProject ? (
              <ProjectHero
                project={activeProject}
                displayName={(heroSpace as any)?.displayName ?? null}
                stats={heroStats}
                repo={heroRepo}
                onOpenSwitcher={() => setSwitcherOpen(true)}
                onNewConversation={props.onNewConversation}
                sync={heroSync}
                onTurnOnSync={() => setTurnOnSyncFor({ path: activeProject.path, name: activeProject.name })}
                onSyncNow={(spaceId) => { void (window.claude as any).syncSpaces.syncNow(spaceId); }}
                onRenamed={async () => {
                  // try/catch + slash/case-normalized match — same conventions
                  // as handleAdded (exact === path compare is a latent Windows
                  // drive-case/slash footgun).
                  try {
                    const res = await (window.claude as any).artifacts.listProjectsIndex({ withCounts: true });
                    if (res?.ok) {
                      setProjects(res.projects);
                      const cur = res.projects.find(
                        (p: CentralIndexProject) => p.path.replace(/\\/g, '/').toLowerCase() === activeProject.path.replace(/\\/g, '/').toLowerCase()
                      );
                      if (cur) setActiveProject(cur);
                    }
                  } catch (err) {
                    console.warn('post-rename project list refresh failed', err);
                  }
                }}
                canRemove={!heroSpace}
                onRemove={() => setDeletingProject(activeProject)}
              />
            ) : (
              <div className="text-sm text-fg-muted">Select a project to view its artifacts.</div>
            )}

            {/* Seg-row: unified segmented control (left) + the active tab's
                search/filter controls (right), on one row — matches the design. */}
            {/* Sticky on narrow so the tab switcher survives scrolling down
                through a long file list — without it, page-scroll would carry
                the tabs off-screen and you'd have to scroll back up to switch. */}
            <div className="flex items-center justify-between gap-3 flex-wrap max-sm:sticky max-sm:top-0 max-sm:z-10 max-sm:bg-canvas max-sm:py-2">
              {/* Unified segmented control: one rounded-full pill holding all three
                  segments (icon + label + count). Accent used ONCE — the active seg. */}
              {/* All four segments at full width, no scrolling: below 640px the
                  INACTIVE segments drop to icon-only and the active one keeps
                  its label + count. Labelled, the four total ~500px
                  ("Conversations" alone is ~168px), which overflowed a phone
                  and put Context out of reach entirely. Three ~35px icons plus
                  one labelled segment fits inside ~374px with room to spare.
                  overflow-x-auto stays as a backstop for a very long label at a
                  very small width; it should not normally engage. */}
              <div
                className="flex items-center gap-1 p-1 layer-surface !rounded-full max-sm:w-full max-w-full overflow-x-auto no-scrollbar"
                style={{ boxShadow: 'none' }}
              >
                {SEGMENTS.map((s) => {
                  const active = tab === s.id;
                  const isFileTab = s.id === 'artifacts' || s.id === 'allfiles';
                  return (
                    <button
                      key={s.id}
                      type="button"
                      // Active segment absorbs the leftover width on narrow so
                      // the pill spans the screen exactly; inactive ones stay
                      // at their icon width. title= carries the label for the
                      // icon-only state (aria-label does the same for AT).
                      className={`shrink-0 ${active ? 'max-sm:flex-1 max-sm:min-w-0' : ''} px-2.5 sm:px-3.5 py-1.5 rounded-full text-[13px] font-medium inline-flex items-center justify-center gap-1.5 sm:gap-2 transition-colors ${
                        active
                          ? 'bg-accent text-on-accent'
                          : 'text-fg-2 hover:text-fg hover:bg-inset'
                      }`}
                      onClick={() => setTab(s.id)}
                      title={s.label}
                      aria-label={s.label}
                      aria-current={active ? 'page' : undefined}
                    >
                      <span className="shrink-0 inline-flex">{s.icon}</span>
                      {/* Label + count collapse to nothing on an inactive
                          segment below 640px — that's what buys the room for
                          all four to fit without scrolling. */}
                      <span className={`truncate ${active ? '' : 'max-sm:hidden'}`}>{s.label}</span>
                      <span className={`text-[11px] shrink-0 ${active ? 'opacity-80' : 'text-fg-muted max-sm:hidden'}`}>
                        {s.count}
                      </span>
                      {/* (i) hover explainer for the Artifacts vs All files split —
                          rendered INSIDE the active file-tab segment (next to the
                          label + count, per the design) so the answer to "why is
                          this file in both tabs?" lives right where the question
                          arises. Hover icon per the app's (i) convention. */}
                      {active && isFileTab && (
                        <span
                          className="opacity-75 hover:opacity-100 inline-flex items-center cursor-help transition-opacity"
                          title={'Artifacts are files Claude created or edited in this project (plus any you pin with “+ Add file”). All files shows everything in the folder — Claude’s files included, so a file can appear in both.'}
                          aria-label="What is the difference between Artifacts and All files?"
                        >
                          <InfoIcon size={13} />
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>

              {/* Right controls for the two file sections. ONE rounded-full search
                  pill (same shape language as the segmented control) with the
                  sliders icon inside its right edge — ALL filter/sort options
                  (type, sort, Show deleted) live behind it in FileFilterPopover.
                  Only "+ Add file" (an action, not a filter) stays visible.
                  Conversations/Context have no toolbar in v1. */}
              {/* Narrow: search + Add file take their own full-width row under
                  the segments (the parent's flex-wrap does the rest). A hard
                  260px pill plus "+ Add file" was ~363px in a 358px content
                  box, so this row alone overflowed the viewport. */}
              {(tab === 'artifacts' || tab === 'allfiles') && activeProject && (
                <div className="w-full sm:w-auto flex items-center gap-2">
                  <SearchFilterPill
                    ref={filterWrapRef}
                    className="flex-1 sm:flex-none sm:w-[260px]"
                    value={artifactSearch}
                    onChange={setArtifactSearch}
                    placeholder={tab === 'allfiles' ? 'Search files…' : 'Search artifacts…'}
                    inputAriaLabel={tab === 'allfiles' ? 'Search files' : 'Search artifacts'}
                    /* Filters active BEYOND the default view (type + Show deleted).
                       Sort is a preference, so it isn't counted — the badge only
                       signals "filters narrowed this" while the popover is shut. */
                    activeFilters={(types.size > 0 ? 1 : 0) + (tab === 'artifacts' && showDeletedArtifacts ? 1 : 0)}
                    filterOpen={filterOpen}
                    onToggleFilter={() => setFilterOpen((o) => !o)}
                  >
                    {filterOpen && (
                      <FileFilterPopover
                        types={types}
                        onTypesChange={setTypes}
                        sortBy={fileSort}
                        onSortBy={setFileSort}
                        showDeleted={showDeletedArtifacts}
                        onShowDeleted={setShowDeletedArtifacts}
                        showDeletedAvailable={tab === 'artifacts'}
                        onClose={() => setFilterOpen(false)}
                      />
                    )}
                  </SearchFilterPill>
                  {/* Was a pill (rounded-full). Spec decision 65 keeps pills only
                      for floating overlay affordances — this sits in a toolbar row,
                      so it takes the app's standard button radius. */}
                  {tab === 'artifacts' && (
                    <Button
                      variant="secondary"
                      className="shrink-0"
                      onClick={addExternal}
                      title="Add an external file to this project"
                    >
                      + Add file
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Tab routing — shares the centered max-width with the chrome above. */}
          {/* max-sm:flex-none + overflow-visible: in the narrow page-scroll
              model this must take its NATURAL height and let the page scroll,
              not clamp itself to the viewport and scroll internally. */}
          <div className="flex-1 overflow-hidden min-h-0 w-full max-w-[1100px] mx-auto max-sm:flex-none max-sm:overflow-visible">
            {activeProject && tab === 'artifacts' && (
              <FilesTab project={activeProject} search={artifactSearch} types={types} sortBy={fileSort} refreshKey={refreshKey} mode="artifacts" onMutated={() => setCountsKey((k) => k + 1)} onClearSearch={() => setArtifactSearch('')} />
            )}
            {activeProject && tab === 'allfiles' && (
              <FilesTab project={activeProject} search={artifactSearch} types={types} sortBy={fileSort} refreshKey={refreshKey} mode="allfiles" onMutated={() => setCountsKey((k) => k + 1)} onClearSearch={() => setArtifactSearch('')} />
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
          syncStatus={syncStatus}
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
            {/* Change 39/§1.4: the consent Checkbox primitive (its one intended
                site). Row is a clickable div (a <label> can't associate with a
                button), so the whole row toggles like the old label did. The
                Checkbox is wrapped in a stopPropagation span so its OWN click
                fires exactly one toggle instead of double-firing via the row. */}
            <div
              className="flex items-center gap-2 mb-4 text-sm cursor-pointer text-fg"
              onClick={() => setAlsoDeleteSidecar((v) => !v)}
            >
              <span onClick={(e) => e.stopPropagation()}>
                <Checkbox
                  checked={alsoDeleteSidecar}
                  onChange={setAlsoDeleteSidecar}
                  aria-label="Also delete .youcoded/artifacts.json (artifact history)"
                />
              </span>
              Also delete <code className="font-mono text-xs bg-inset px-1 rounded">.youcoded/artifacts.json</code> (artifact history)
            </div>
            <div className="flex gap-2 justify-end">
              <Button
                variant="secondary"
                size="lg"
                onClick={() => { setDeletingProject(null); setAlsoDeleteSidecar(false); }}
              >
                Cancel
              </Button>
              {/* Was a raw Tailwind bg-red-600. Spec decision 59: that stock red
                  isn't the app's destructive colour and doesn't follow themes —
                  the `danger` variant uses the theme's own destructive token. */}
              <Button variant="danger" size="lg" onClick={confirmDelete}>
                Remove
              </Button>
            </div>
          </OverlayPanel>
        </>
      )}

      {/* Unified add-project flow (spec §3). Routes create-new / keep-in-place /
          move+sync itself; handleAdded refreshes + selects on any success. */}
      {addOpen && (
        <AddProjectModal onClose={() => setAddOpen(false)} onAdded={(p) => void handleAdded(p)} />
      )}
      {/* Turn-on-sync for the ACTIVE project (hero button) — the consent+move
          modal, seeded with the project's current path + name. */}
      {turnOnSyncFor && (
        <ImportProjectModal
          sourcePath={turnOnSyncFor.path}
          defaultName={turnOnSyncFor.name}
          onClose={() => setTurnOnSyncFor(null)}
          onDone={(p) => void handleAdded(p)}
        />
      )}
    </div>
  );
}
