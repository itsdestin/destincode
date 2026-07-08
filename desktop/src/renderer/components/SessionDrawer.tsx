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

// Maps the rename IPC's error codes to user-facing copy. Falls back to a
// generic message so an unexpected code still surfaces *something* rather than
// silently keeping the old name.
function renameErrorCopy(code: unknown): string {
  switch (code) {
    case 'name-taken': return 'A file with that name already exists.';
    case 'invalid-name': return 'That name has characters that aren’t allowed.';
    case 'file-missing': return 'The original file is no longer on disk.';
    case 'artifact-not-found': return 'This file is no longer tracked.';
    default: return 'Couldn’t rename the file. Try a different name.';
  }
}

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
  // External-link (box + arrow-out) — "Open externally" (OS default app).
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
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
  // Drawer open/closed AND the selected artifact are per-session (remembered
  // across switches). This drawer instance belongs to `sessionId`.
  const drawerOpen = state.drawerOpenBySession[sessionId] ?? false;
  const activeArtifactId = state.activeArtifactBySession[sessionId] ?? null;

  // Existence check (unchanged): mark artifacts whose file is gone as orphans,
  // folded into the "deleted" UI state alongside explicit delete versions.
  const [orphanIds, setOrphanIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!drawerOpen || allArtifacts.length === 0 || !projectRoot) {
      setOrphanIds(new Set());
      return;
    }
    let cancelled = false;
    // Exclude DISCOVERED (on-disk) records: their id is a relative path, not a
    // sidecar id, so checkExistence would treat them as "missing" and wrongly
    // mark a file that's literally on disk as deleted. They exist by definition
    // (discovery only lists real files), so skip them here.
    const ids = allArtifacts.filter((a) => !(a as any).discovered).map((a) => a.id);
    (window.claude as any).artifacts.checkExistence(projectRoot, ids)
      .then((res: any) => {
        if (cancelled || !res?.ok) return;
        setOrphanIds(new Set(res.missingIds ?? []));
      })
      .catch(() => {});
    return () => { cancelled = true; };
    // Dep is the ARRAY, not its length — a rename/status flip changes members
    // without changing the count, and orphan detection must re-run then too.
  }, [drawerOpen, allArtifacts, projectRoot]);

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
  // Look up the open document in the UNFILTERED list — toggling "Hide code" /
  // "Show deleted" while viewing a now-filtered-out file must not blank the
  // content pane (the file is still open; only the LIST hides it).
  const active = allArtifacts.find((a) => a.id === activeArtifactId);
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
  // Inline rename failure message (e.g. name taken). Null = no error.
  const [renameError, setRenameError] = useState<string | null>(null);
  // Guards against the Enter-then-blur double-commit (both fire on the input).
  const renameActiveRef = useRef(false);
  // Lets us re-focus the rename input after a failed commit (autoFocus only
  // fires on first mount; the field stays mounted across a failed attempt).
  const renameInputRef = useRef<HTMLInputElement>(null);
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
    setRenameError(null);
    renameActiveRef.current = true;
    setRenaming(true);
  }, [active]);

  const cancelRename = useCallback(() => {
    renameActiveRef.current = false;
    setRenaming(false);
    setRenameError(null);
  }, []);

  // `viaEnter` distinguishes an explicit Enter commit from a blur commit. On a
  // failed Enter we re-focus the field so the user can immediately retry; on a
  // failed blur we keep the field open with the error but DON'T steal focus
  // back (that would trap the cursor — you could never click away from a bad
  // name). Either way the error is shown rather than silently swallowed.
  const commitRename = useCallback(async (viaEnter = false) => {
    if (!renameActiveRef.current || !active) return;
    renameActiveRef.current = false;
    const next = renameDraft.trim();
    if (!next || next === baseName(active.path)) { // unchanged / empty → no-op
      setRenaming(false);
      setRenameError(null);
      return;
    }
    const res = await (window.claude as any).artifacts.rename(projectRoot, active.id, next);
    if (res?.ok) {
      setRenaming(false);
      setRenameError(null);
      // Re-list from the (now-updated) sidecar so the header + list show the new name.
      const r = await (window.claude as any).artifacts.listSession(sessionId, projectRoot);
      if (r?.ok && Array.isArray(r.artifacts)) {
        dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: r.artifacts });
      }
    } else {
      // Failure (name-taken / invalid / etc.) — keep the field open with the old
      // name and surface WHY, so the rename doesn't silently appear to do nothing.
      setRenameError(renameErrorCopy(res?.error));
      renameActiveRef.current = true; // re-arm so the next Enter/blur commits again
      setRenaming(true);
      if (viaEnter) requestAnimationFrame(() => renameInputRef.current?.focus());
    }
  }, [active, renameDraft, projectRoot, sessionId, dispatch]);

  // Absolute on-disk path of the active artifact (for copy-path + reveal).
  // Forward slashes throughout — mixing a backslash projectRoot with '/' joins
  // reads broken in the clipboard on Windows.
  const absolutePath = active
    ? (active.kind === 'internal'
        ? `${projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${active.path.replace(/\\/g, '/')}`
        : (active.absolutePath ?? active.path))
    : '';

  // ── Toolbar actions ──
  const handleCopyPath = useCallback(() => {
    if (absolutePath) navigator.clipboard?.writeText(absolutePath).catch(() => {});
  }, [absolutePath]);

  const handleReveal = useCallback(() => {
    if (absolutePath) (window.claude as any).shell?.showItemInFolder?.(absolutePath);
  }, [absolutePath]);

  // Open the file with the OS default app (HTML→browser, .docx→Word, etc.) —
  // the right action for formats the in-app viewer can't fully render. Desktop
  // only (shell.openPath); the button is gated on isElectron like Reveal.
  const handleOpenExternal = useCallback(() => {
    if (absolutePath) (window.claude as any).shell?.openPath?.(absolutePath);
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
    if (!drawerOpen) return;
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
  }, [drawerOpen, active]);

  // ── ESC / back: rename → find → edit → expand → list → active → drawer ──
  const handleBack = useCallback(() => {
    if (renameActiveRef.current) { cancelRename(); return; }
    if (findOpen) { setFindOpen(false); return; }
    if (editState.editing) { editRef.current?.cancelEdit(); return; }
    if (expanded) { dispatch({ type: 'DRAWER_EXPAND_TOGGLED' }); return; }
    if (listOpen) { setListOpen(false); return; }
    if (activeArtifactId) { dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId }); return; }
    dispatch({ type: 'DRAWER_CLOSED', sessionId });
  }, [findOpen, editState.editing, expanded, listOpen, activeArtifactId, dispatch, cancelRename, sessionId]);

  useEscClose(drawerOpen, handleBack);

  if (!drawerOpen) return null;

  // ── List column (shared by the no-selection and push-sidebar layouts) ──
  const listInner = (
    <>
      <div className="flex items-center justify-between px-3 py-2 border-b border-edge shrink-0">
        <span className="font-semibold text-sm">Artifacts ({listedArtifacts.length})</span>
        {!active && (
          <button
            className="text-fg-muted hover:text-fg px-1 text-base leading-none"
            onClick={() => dispatch({ type: 'DRAWER_CLOSED', sessionId })}
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
              isActive={activeArtifactId === a.id}
              isDeleted={a.status === 'deleted' || orphanIds.has(a.id)}
              onSelect={() => {
                // Preview-on-click: set the active artifact but KEEP the list open
                // so the user can click across artifacts to preview them. The list
                // collapses only when they engage the content pane (see the
                // contentRef effect: click into it or scroll it).
                // Cancel any in-progress rename first so its open field doesn't
                // bleed onto the newly-selected artifact.
                if (renameActiveRef.current || renaming) cancelRename();
                dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: a.id });
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

  const statusWord = statusInfo(active, active.status === 'deleted' || orphanIds.has(active.id));
  const fileName = active.path.split('/').pop() ?? active.path;

  return (
    <aside ref={asideRef} className={asideClass}>
      {/* top bar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-edge shrink-0">
        <IconBtn name="list" title={listOpen ? 'Hide list' : 'Show list'} active={listOpen} onClick={() => setListOpen((v) => !v)} />
        {renaming ? (
          <div className="flex items-center gap-2 min-w-0 px-1 relative">
            <span className={`inline-flex items-center border rounded-md overflow-hidden ${renameError ? 'border-red-500' : 'border-accent'}`}>
              <input
                ref={renameInputRef}
                autoFocus
                value={renameDraft}
                onChange={(e) => { setRenameDraft(e.target.value); if (renameError) setRenameError(null); }}
                onBlur={() => commitRename(false)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitRename(true); } }}
                className="bg-canvas text-fg text-[13px] font-semibold px-2 py-1 w-[150px] outline-none"
              />
              <span className="text-[12px] text-fg-muted font-mono px-2">{extOf(fileName)}</span>
            </span>
            {/* Inline failure note — keeps the field open so the user can correct it. */}
            {renameError && (
              <span className="absolute left-1 top-full mt-1 text-[11px] text-red-400 whitespace-nowrap z-10">
                {renameError}
              </span>
            )}
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
        {isElectron && <IconBtn name="external" title="Open with the default app" onClick={handleOpenExternal} />}
        <IconBtn name="link" title="Copy path" onClick={handleCopyPath} />
        {isElectron && <IconBtn name="folder" title="Reveal in folder" onClick={handleReveal} />}
        <IconBtn name={expanded ? 'shrink' : 'expand'} title={expanded ? 'Shrink panel' : 'Expand panel'} active={expanded} onClick={() => dispatch({ type: 'DRAWER_EXPAND_TOGGLED' })} />
        <IconBtn name="close" title="Close" onClick={() => dispatch({ type: 'DRAWER_CLOSED', sessionId })} />
      </div>

      {/* metadata strip */}
      <div className="flex items-center gap-2 px-3.5 py-1 text-[11px] text-fg-muted border-b border-edge-dim bg-well shrink-0">
        {/* WHY: status shown as a word, not a ●◐○ glyph (user-disliked — see dislikes-status-glyphs memory). */}
        <span>{statusWord}</span>
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

// Real checkbox visual (lucide-style square + check) instead of the ☑/☐
// unicode glyphs — consistent with the app's SVG iconography and crisper at
// small sizes.
function CheckboxGlyph({ checked }: { checked: boolean }) {
  return (
    <svg width={13} height={13} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      {checked && <path d="m8 12.5 3 3 5.5-6.5" />}
    </svg>
  );
}

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
          <CheckboxGlyph checked={hideCodeAndConfigs} />
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
          <CheckboxGlyph checked={showDeletedArtifacts} />
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
  const statusWord = statusInfo(artifact, isDeleted);
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
        <span className={`font-mono text-xs truncate flex-1 ${isDeleted ? 'line-through' : ''}`}>{fileName}</span>
      </div>
      {/* WHY: status shown as a word, not a ●◐○ glyph (user-disliked — see dislikes-status-glyphs memory). */}
      <div className="text-[10px] text-fg-muted ml-0.5">{statusWord} · {relTime}</div>
    </button>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Status word: deleted, viewed (read-only — only 'read' versions),
// edited (>1 modifying version), created/unmodified. 'read' versions are
// excluded from the edit count so a viewed-only doc doesn't look edited.
// WHY: returns the word only — the ●◐○ glyph form was dropped (user-disliked,
// see dislikes-status-glyphs memory).
function statusInfo(artifact: ArtifactRecord, isDeleted: boolean): string {
  if (isDeleted) return 'deleted';
  const modifying = artifact.versions.filter((v) => v.type !== 'read').length;
  if (modifying === 0) return 'viewed';
  if (modifying > 1) return 'edited';
  return 'created';
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
