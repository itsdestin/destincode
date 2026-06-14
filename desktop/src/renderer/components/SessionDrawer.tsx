// SessionDrawer — slide-in panel listing artifacts collected during a session.
// Layout (B2 "push sidebar"): the selected artifact's content takes the full
// panel width; a collapsible/pinnable list pushes the content narrower when
// open. A per-file top bar offers click-to-rename (the filename itself is the
// trigger), copy, download, and expand-to-fullscreen.
//
// History: Task 6.x scaffolded a fixed 180px-list + viewer split. This file
// replaced that split with the push-sidebar layout (2026-06).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useArtifact } from '../state/ArtifactContext';
import { useTheme } from '../state/theme-context';
import { useEscClose } from '../hooks/use-esc-close';
import { ActiveArtifactView, type ActiveArtifactHandle } from './artifact-views/ActiveArtifactView';
import { ContentFindBar } from './ContentFindBar';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { categorizeArtifact } from '../../shared/artifacts/categorization';
import { getPlatform } from '../platform';

type SortKey = 'recent' | 'name' | 'type';

interface Props {
  sessionId: string;
  projectRoot: string;
  projectId: string;
  projectName: string;
}

// ── Small inline icon helper (lucide-style, inherits currentColor) ──
const PATHS: Record<string, string> = {
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  // Link icon — "Copy path" (distinct from copying contents).
  link: 'M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71',
  // Folder — "Reveal in folder".
  folder: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  expand: 'M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3',
  shrink: 'M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3',
  pencil: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z',
  // Square-pen — distinct from the filename rename pencil; this edits contents.
  editdoc: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z',
  check: 'M20 6 9 17l-5-5',
  close: 'M18 6 6 18M6 6l12 12',
};
function Ic({ name, size = 15 }: { name: keyof typeof PATHS | string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      {PATHS[name].split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
    </svg>
  );
}

function IconBtn({ name, title, onClick, active }: { name: string; title: string; onClick: () => void; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={`w-7 h-7 rounded-md inline-flex items-center justify-center shrink-0 border transition-colors ${
        active ? 'text-fg bg-well border-edge' : 'text-fg-dim border-transparent hover:text-fg hover:bg-well hover:border-edge'
      }`}
    >
      <Ic name={name} />
    </button>
  );
}

export function SessionDrawer({ sessionId, projectRoot, projectId, projectName }: Props) {
  const { state, dispatch } = useArtifact();
  const { hideCodeAndConfigs, setHideCodeAndConfigs, showDeletedArtifacts, setShowDeletedArtifacts } = useTheme();
  const allArtifacts = state.sessionArtifacts[sessionId] ?? [];

  // Existence check (unchanged): mark artifacts whose file is gone as orphans,
  // folded into the "deleted" UI state alongside explicit delete versions.
  const [orphanIds, setOrphanIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!state.drawerOpen || allArtifacts.length === 0 || !projectRoot) {
      setOrphanIds(new Set());
      return;
    }
    let cancelled = false;
    const ids = allArtifacts.map((a) => a.id);
    (window.claude as any).artifacts.checkExistence(projectRoot, ids)
      .then((res: any) => {
        if (cancelled || !res?.ok) return;
        setOrphanIds(new Set(res.missingIds ?? []));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [state.drawerOpen, allArtifacts.length, projectRoot]);

  const artifacts = useMemo(() => {
    return allArtifacts.filter((a) => {
      if (hideCodeAndConfigs && categorizeArtifact(a.path) !== 'document') return false;
      const isDeleted = a.status === 'deleted' || orphanIds.has(a.id);
      if (isDeleted && !showDeletedArtifacts) return false;
      return true;
    });
  }, [allArtifacts, hideCodeAndConfigs, showDeletedArtifacts, orphanIds]);
  const hiddenCount = allArtifacts.length - artifacts.length;
  const deletedCount = useMemo(
    () => allArtifacts.filter((a) => a.status === 'deleted' || orphanIds.has(a.id)).length,
    [allArtifacts, orphanIds],
  );
  const active = artifacts.find((a) => a.id === state.activeArtifactId);
  const [content, setContent] = useState<string | null>(null);

  useEffect(() => {
    if (!active) { setContent(null); return; }
    let cancelled = false;
    (window.claude as any).artifacts.get(projectRoot, active.id).then((res: any) => {
      if (cancelled) return;
      if (res && res.ok) setContent(res.content ?? null);
    });
    return () => { cancelled = true; };
  }, [active?.id, projectRoot]);

  // ── B2 panel UI state ──
  // The list stays open once toggled; it closes on the ☰ toggle, on selecting an
  // artifact, or on entering edit mode. (No pin — that was removed by request.)
  const [listOpen, setListOpen] = useState(false);  // push list shown
  const expanded = state.drawerExpanded;             // fill-the-region (shared, drives ChatView)
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  // Guards against the Enter-then-blur double-commit (both fire on the input).
  const renameActiveRef = useRef(false);
  // Edit control is owned by ActiveArtifactView; the header drives it through
  // this ref + mirrors its state so the toolbar can swap pencil ↔ save/cancel.
  const editRef = useRef<ActiveArtifactHandle>(null);
  const [editState, setEditState] = useState<{ isEditable: boolean; editing: boolean }>({ isEditable: false, editing: false });
  // Content pane node — the list collapses when the user engages the artifact
  // here (clicks into it or scrolls it), not when they merely preview by
  // clicking list rows.
  const contentRef = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLDivElement>(null);
  const [findOpen, setFindOpen] = useState(false);     // Ctrl+F find-in-document
  const [searchQuery, setSearchQuery] = useState('');  // filter the artifact list
  const [sortBy, setSortBy] = useState<SortKey>('recent');
  const isElectron = getPlatform() === 'electron';

  // No selection → force the list visible so the user can pick something.
  const showList = !active ? true : listOpen;

  // ── Rename: the filename itself is the trigger ──
  const startRename = useCallback(() => {
    if (!active) return;
    setRenameDraft(baseName(active.path));
    renameActiveRef.current = true;
    setRenaming(true);
  }, [active]);

  const cancelRename = useCallback(() => {
    renameActiveRef.current = false;
    setRenaming(false);
  }, []);

  const commitRename = useCallback(async () => {
    if (!renameActiveRef.current || !active) return;
    renameActiveRef.current = false;
    setRenaming(false);
    const next = renameDraft.trim();
    if (!next || next === baseName(active.path)) return; // unchanged / empty → no-op
    const res = await (window.claude as any).artifacts.rename(projectRoot, active.id, next);
    if (res?.ok) {
      // Re-list from the (now-updated) sidecar so the header + list show the new name.
      const r = await (window.claude as any).artifacts.listSession(sessionId, projectRoot);
      if (r?.ok && Array.isArray(r.artifacts)) {
        dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: r.artifacts });
      }
    } else {
      // name-taken / invalid — keep the old name. (A toast surface is a follow-up.)
      console.warn('[SessionDrawer] rename failed:', res?.error);
    }
  }, [active, renameDraft, projectRoot, sessionId, dispatch]);

  // Absolute on-disk path of the active artifact (for copy-path + reveal).
  const absolutePath = active
    ? (active.kind === 'internal' ? `${projectRoot}/${active.path}` : (active.absolutePath ?? active.path))
    : '';

  // ── Toolbar actions ──
  const handleCopyPath = useCallback(() => {
    if (absolutePath) navigator.clipboard?.writeText(absolutePath).catch(() => {});
  }, [absolutePath]);

  const handleReveal = useCallback(() => {
    if (absolutePath) (window.claude as any).shell?.showItemInFolder?.(absolutePath);
  }, [absolutePath]);

  // Rows to render: the filtered set, narrowed by the search box and sorted.
  // Search/sort affect ONLY the rendered list — not `artifacts`, which still
  // backs the active-artifact lookup (so searching never hides the open file).
  const listedArtifacts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const arr = q
      ? artifacts.filter((a) => (a.path.split('/').pop() ?? a.path).toLowerCase().includes(q))
      : artifacts.slice();
    arr.sort((a, b) => {
      if (sortBy === 'name') return fileNameOf(a).localeCompare(fileNameOf(b));
      if (sortBy === 'type') return (extOf(fileNameOf(a)).localeCompare(extOf(fileNameOf(b))) || fileNameOf(a).localeCompare(fileNameOf(b)));
      return (b.lastModified || '').localeCompare(a.lastModified || ''); // recent first
    });
    return arr;
  }, [artifacts, searchQuery, sortBy]);

  // Collapse the list once the user actually engages the previewed artifact:
  // a click into the content pane or a scroll within it. Scroll is captured
  // (third arg true) because the real scroll happens on an inner overflow
  // container, and scroll events don't bubble. Wheel covers the case where the
  // user spins the wheel before the scroll position moves.
  useEffect(() => {
    if (!listOpen) return;
    const node = contentRef.current;
    if (!node) return;
    const close = () => setListOpen(false);
    node.addEventListener('mousedown', close);
    node.addEventListener('wheel', close, { passive: true });
    node.addEventListener('scroll', close, true);
    return () => {
      node.removeEventListener('mousedown', close);
      node.removeEventListener('wheel', close);
      node.removeEventListener('scroll', close, true);
    };
  }, [listOpen]);

  // Ctrl/Cmd+F opens find-in-document — but only when the pointer is over the
  // drawer, so it doesn't hijack Ctrl+F while the user is working in the chat.
  useEffect(() => {
    if (!state.drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        if (active && asideRef.current?.matches(':hover')) {
          e.preventDefault();
          setFindOpen(true);
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [state.drawerOpen, active]);

  // ── ESC / back: rename → find → edit → expand → list → active → drawer ──
  const handleBack = useCallback(() => {
    if (renameActiveRef.current) { cancelRename(); return; }
    if (findOpen) { setFindOpen(false); return; }
    if (editState.editing) { editRef.current?.cancelEdit(); return; }
    if (expanded) { dispatch({ type: 'DRAWER_EXPAND_TOGGLED' }); return; }
    if (listOpen) { setListOpen(false); return; }
    if (state.activeArtifactId) { dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED' }); return; }
    dispatch({ type: 'DRAWER_CLOSED' });
  }, [findOpen, editState.editing, expanded, listOpen, state.activeArtifactId, dispatch, cancelRename]);

  useEscClose(state.drawerOpen, handleBack);

  if (!state.drawerOpen) return null;

  // ── List column (shared by the no-selection and push-sidebar layouts) ──
  const listInner = (
    <>
      <div className="flex items-center justify-between px-3 py-2 border-b border-edge shrink-0">
        <span className="font-semibold text-sm">Artifacts ({listedArtifacts.length})</span>
        {!active && (
          <button
            className="text-fg-muted hover:text-fg px-1 text-base leading-none"
            onClick={() => dispatch({ type: 'DRAWER_CLOSED' })}
            title="Close drawer"
          >×</button>
        )}
      </div>
      {/* Search + sort */}
      <div className="flex items-center gap-1.5 px-2 py-1.5 border-b border-edge-dim shrink-0">
        <input
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search files"
          className="flex-1 min-w-0 bg-canvas border border-edge rounded text-[11px] text-fg px-2 py-1 outline-none focus:border-fg-muted"
        />
        <select
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as SortKey)}
          title="Sort artifacts"
          className="bg-canvas border border-edge rounded text-[11px] text-fg-2 px-1 py-1 outline-none cursor-pointer"
        >
          <option value="recent">Recent</option>
          <option value="name">Name</option>
          <option value="type">Type</option>
        </select>
      </div>
      <FilterToggles
        hideCodeAndConfigs={hideCodeAndConfigs}
        setHideCodeAndConfigs={setHideCodeAndConfigs}
        showDeletedArtifacts={showDeletedArtifacts}
        setShowDeletedArtifacts={setShowDeletedArtifacts}
        deletedCount={deletedCount}
      />
      <div className="flex-1 overflow-y-auto">
        {listedArtifacts.length === 0 ? (
          <div className="p-3 text-xs text-fg-muted">
            {searchQuery.trim()
              ? <>No files match “{searchQuery.trim()}”.</>
              : hideCodeAndConfigs && hiddenCount > 0
                ? <>No documents yet — {hiddenCount} code/config file{hiddenCount === 1 ? '' : 's'} hidden. Toggle off above to view all.</>
                : <>No artifacts yet. Files Claude writes or edits in this session will appear here.</>}
          </div>
        ) : (
          listedArtifacts.map((a) => (
            <ArtifactListItem
              key={a.id}
              artifact={a}
              isActive={state.activeArtifactId === a.id}
              isDeleted={a.status === 'deleted' || orphanIds.has(a.id)}
              onSelect={() => {
                // Preview-on-click: set the active artifact but KEEP the list open
                // so the user can click across artifacts to preview them. The list
                // collapses only when they engage the content pane (see the
                // contentRef effect: click into it or scroll it).
                dispatch({ type: 'ACTIVE_ARTIFACT_SET', artifactId: a.id });
                setListOpen(true);
              }}
            />
          ))
        )}
      </div>
    </>
  );

  // Expanded just fills the framed-shell content region (ChatView hides the chat
  // pane via the .drawer-expanded class) — the header/input chrome stay put.
  const asideClass = expanded
    ? 'flex-1 min-w-0 h-full flex flex-col bg-inset'
    : 'w-[480px] h-full flex flex-col bg-inset shrink-0';

  // No selection → the whole drawer is the list (nothing to view yet).
  if (!active) {
    return <aside ref={asideRef} className={asideClass}>{listInner}</aside>;
  }

  const info = statusInfo(active, active.status === 'deleted' || orphanIds.has(active.id));
  const fileName = active.path.split('/').pop() ?? active.path;

  return (
    <aside ref={asideRef} className={asideClass}>
      {/* top bar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-edge shrink-0">
        <IconBtn name="list" title={listOpen ? 'Hide list' : 'Show list'} active={listOpen} onClick={() => setListOpen((v) => !v)} />
        {renaming ? (
          <div className="flex items-center gap-2 min-w-0 px-1">
            <span className="inline-flex items-center border border-accent rounded-md overflow-hidden">
              <input
                autoFocus
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(); } }}
                className="bg-canvas text-fg text-[13px] font-semibold px-2 py-1 w-[150px] outline-none"
              />
              <span className="text-[12px] text-fg-muted font-mono px-2">{extOf(fileName)}</span>
            </span>
          </div>
        ) : (
          <button
            type="button"
            onClick={startRename}
            title="Click to rename"
            className="group flex items-center gap-1.5 min-w-0 px-2 py-1 rounded-md cursor-text hover:bg-well transition-colors"
          >
            <span className="text-[13px] font-semibold text-fg truncate decoration-dotted underline-offset-[3px] group-hover:underline group-hover:decoration-fg-muted">
              {fileName}
            </span>
            <span className="text-fg-muted opacity-0 group-hover:opacity-100 shrink-0"><Ic name="pencil" size={12} /></span>
          </button>
        )}
        <div className="flex-1" />
        {/* Edit contents — pencil to start; ✓ / ✕ while editing. Driven via editRef. */}
        {editState.editing ? (
          <>
            <IconBtn name="check" title="Save changes" active onClick={() => editRef.current?.saveEdit()} />
            <IconBtn name="close" title="Cancel editing" onClick={() => editRef.current?.cancelEdit()} />
          </>
        ) : (
          editState.isEditable && (
            <IconBtn
              name="editdoc"
              title="Edit contents"
              onClick={() => { editRef.current?.startEdit(); setListOpen(false); }}
            />
          )
        )}
        <span className="w-px h-[18px] bg-edge mx-0.5" />
        <IconBtn name="link" title="Copy path" onClick={handleCopyPath} />
        {isElectron && <IconBtn name="folder" title="Reveal in folder" onClick={handleReveal} />}
        <IconBtn name={expanded ? 'shrink' : 'expand'} title={expanded ? 'Shrink panel' : 'Expand panel'} active={expanded} onClick={() => dispatch({ type: 'DRAWER_EXPAND_TOGGLED' })} />
        <IconBtn name="close" title="Close" onClick={() => dispatch({ type: 'DRAWER_CLOSED' })} />
      </div>

      {/* metadata strip */}
      <div className="flex items-center gap-2 px-3.5 py-1 text-[11px] text-fg-muted border-b border-edge-dim bg-well shrink-0">
        <span className="text-fg-dim">{info.glyph}</span>
        <span>{info.word}</span>
        <span className="text-fg-faint">·</span>
        <span>{formatRelativeTime(active.lastModified)}</span>
        {content !== null && <><span className="text-fg-faint">·</span><span>{formatSize(content)}</span></>}
      </div>

      {/* body: push list + content */}
      <div className="flex-1 flex min-h-0">
        <div
          className={`shrink-0 overflow-hidden bg-well transition-[width] duration-200 flex flex-col ${
            showList ? 'w-[210px] border-r border-edge' : 'w-0'
          }`}
        >
          {/* keep the list mounted (width-collapsed) so toggling is instant */}
          <div className="w-[210px] flex flex-col h-full">{listInner}</div>
        </div>
        {/* Positioning parent for the find bar. contentRef is the INNER div so
            the find bar (a sibling) isn't itself walked by the search. */}
        <div className="flex-1 min-w-0 overflow-hidden relative">
          {findOpen && (
            <ContentFindBar
              containerRef={contentRef}
              resetKey={active.id}
              onClose={() => setFindOpen(false)}
            />
          )}
          <div ref={contentRef} className="h-full overflow-hidden">
            <ActiveArtifactView
              ref={editRef}
              artifact={active}
              content={content}
              projectRoot={projectRoot}
              projectId={projectId}
              projectName={projectName}
              sessionId={sessionId}
              onContentChange={setContent}
              controlsInHeader
              onEditStateChange={setEditState}
            />
          </div>
        </div>
      </div>
    </aside>
  );
}

// ─── Filter toggles (extracted so both layouts share them) ───────────────────

function FilterToggles({
  hideCodeAndConfigs, setHideCodeAndConfigs, showDeletedArtifacts, setShowDeletedArtifacts, deletedCount,
}: {
  hideCodeAndConfigs: boolean; setHideCodeAndConfigs: (v: boolean) => void;
  showDeletedArtifacts: boolean; setShowDeletedArtifacts: (v: boolean) => void;
  deletedCount: number;
}) {
  return (
    <div className="shrink-0 border-b border-edge">
      <button
        type="button"
        className={`w-full text-left px-2 py-1.5 text-[11px] border-t border-edge-dim flex items-center justify-between transition-colors ${
          hideCodeAndConfigs ? 'bg-inset text-fg' : 'text-fg-muted hover:text-fg hover:bg-inset'
        }`}
        onClick={() => setHideCodeAndConfigs(!hideCodeAndConfigs)}
        title={hideCodeAndConfigs ? 'Showing Documents and Mockups only. Click to show all.' : 'Showing all files. Click to hide code & configs.'}
      >
        <span className="flex items-center gap-1.5">
          <span className="text-sm leading-none">{hideCodeAndConfigs ? '☑' : '☐'}</span>
          <span>Hide code &amp; configs</span>
        </span>
      </button>
      <button
        type="button"
        className={`w-full text-left px-2 py-1.5 text-[11px] border-t border-edge-dim flex items-center justify-between transition-colors ${
          showDeletedArtifacts ? 'bg-inset text-fg' : 'text-fg-muted hover:text-fg hover:bg-inset'
        }`}
        onClick={() => setShowDeletedArtifacts(!showDeletedArtifacts)}
        title={showDeletedArtifacts ? 'Including deleted files in the list. Click to hide them.' : `Hiding deleted files${deletedCount > 0 ? ` — ${deletedCount} hidden` : ''}. Click to include them.`}
      >
        <span className="flex items-center gap-1.5">
          <span className="text-sm leading-none">{showDeletedArtifacts ? '☑' : '☐'}</span>
          <span>Show deleted</span>
        </span>
        {!showDeletedArtifacts && deletedCount > 0 && <span className="text-fg-muted">+{deletedCount}</span>}
      </button>
    </div>
  );
}

// ─── ArtifactListItem ────────────────────────────────────────────────────────

interface ListItemProps {
  artifact: ArtifactRecord;
  isActive: boolean;
  isDeleted: boolean;
  onSelect: () => void;
}

function ArtifactListItem({ artifact, isActive, isDeleted, onSelect }: ListItemProps) {
  const glyph = statusInfo(artifact, isDeleted).glyph;
  const relTime = formatRelativeTime(artifact.lastModified);
  const fileName = artifact.path.split('/').pop() ?? artifact.path;

  return (
    <button
      className={`w-full text-left px-2 py-2 hover:bg-inset border-b border-edge-dim transition-colors ${
        isActive ? 'bg-inset' : ''
      } ${isDeleted ? 'opacity-50' : ''}`}
      onClick={onSelect}
      title={isDeleted ? 'Deleted (file is no longer on disk)' : undefined}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-fg-muted shrink-0 text-xs">{glyph}</span>
        <span className={`font-mono text-xs truncate flex-1 ${isDeleted ? 'line-through' : ''}`}>{fileName}</span>
      </div>
      <div className="text-[10px] text-fg-muted ml-3">{relTime}</div>
    </button>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Glyph + status word: ✕ deleted, ○ read-only (only 'read' versions),
// ◐ edited (>1 modifying version), ● created/unmodified. 'read' versions are
// excluded from the edit count so a viewed-only doc doesn't look edited.
function statusInfo(artifact: ArtifactRecord, isDeleted: boolean): { glyph: string; word: string } {
  if (isDeleted) return { glyph: '✕', word: 'deleted' };
  const modifying = artifact.versions.filter((v) => v.type !== 'read').length;
  if (modifying === 0) return { glyph: '○', word: 'viewed' };
  if (modifying > 1) return { glyph: '◐', word: 'edited' };
  return { glyph: '●', word: 'created' };
}

function fileNameOf(a: ArtifactRecord): string {
  return a.path.split('/').pop() ?? a.path;
}

function baseName(p: string): string {
  const fn = p.split('/').pop() ?? p;
  const dot = fn.lastIndexOf('.');
  return dot > 0 ? fn.slice(0, dot) : fn;
}

function extOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(dot) : '';
}

function formatSize(content: string): string {
  const bytes = new Blob([content]).size;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  const diff = (Date.now() - date.getTime()) / 1000; // seconds
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
