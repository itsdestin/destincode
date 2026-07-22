// FilesTab — the folder-tree file browser for one project, used for BOTH halves of
// the core Artifacts/All-files split (see ipc-channels.ts):
//   mode='artifacts' → ARTIFACTS: files Claude directly created/edited (LIST_PROJECT,
//                      sidecar-tracked). Honors "Show deleted"/orphan state.
//   mode='allfiles'  → ALL FILES: every real file in the project folder
//                      (LIST_ALL_FILES, full-browser discovery). No "Show deleted"
//                      chip (nothing tracked to un-hide); the seg-row search +
//                      type filter + sort apply to BOTH modes. Badge counts stay
//                      folder TOTALS — the filters are explicit, visible controls,
//                      so a filtered grid never redefines what "N files" means.
// Cards use .layer-surface; the deleted badge is a plain word "deleted" (the ●◐○ / ✕
// glyph language is disliked — plain words instead).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useArtifact } from '../../../state/ArtifactContext';
import { useProjectWatch } from '../../../hooks/useProjectWatch';
import { useTheme } from '../../../state/theme-context';
import type { CentralIndexProject, ArtifactRecord } from '../../../../shared/artifacts/types';
import { ActiveArtifactView } from '../../artifact-views/ActiveArtifactView';
import type { ActiveArtifactHandle } from '../../artifact-views/ActiveArtifactView';
import { ArtifactThumbnail } from '../../ArtifactThumbnail';
import { fileTypeGroup, fileTypeLabel } from '../../../../shared/artifacts/categorization';
import type { FileTypeGroup } from '../../../../shared/artifacts/categorization';
import { ProjectDetailOverlay } from '../ProjectDetailOverlay';
import {
  TOOL_BTN_ACCENT, TOOL_BTN_NEUTRAL, PencilIcon, CheckIcon, FolderIcon, LinkIcon, ExternalLinkIcon,
} from '../detail-tool-icons';

// Compact relative-time for the detail meta strip (shared util).
import { formatRelativeTime as relTime } from '../../../utils/format-time';
import { getPlatform } from '../../../platform';

// Is the project path a bare drive/filesystem root (vs. the home folder)?
// Only used to pick the right word in the gated-folder message.
function rootLooksLikeDrive(p: string): boolean {
  const fwd = p.replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[a-zA-Z]:$/.test(fwd) || fwd === '';
}

// Absolute on-disk path for an artifact (internal = project.path + rel path).
function artifactAbsPath(projectPath: string, a: ArtifactRecord): string {
  if (a.kind !== 'internal') return a.absolutePath ?? a.path;
  const sep = projectPath.includes('\\') ? '\\' : '/';
  return `${projectPath.replace(/[\\/]+$/, '')}${sep}${a.path.replace(/^[\\/]+/, '')}`;
}

// ProjectView keeps its own artifact selection separate from any chat session's
// drawer, keyed under this reserved sessionId in activeArtifactBySession.
const PV_SESSION = 'project-view';

// Human "kind" label for a card (Document / Image / Spreadsheet / Code), from the
// shared fine-grained type groups — the same groups the type filter uses, so the
// card label always agrees with which filter option surfaces it.
const kindLabel = fileTypeLabel;

// Sort order for the file cards (folders always sort by name). Shared with the
// seg-row sort <select> in ProjectView via this exported key type.
export type FileSortKey = 'name' | 'recent' | 'type';
const fileNameOf = (a: ArtifactRecord) => a.path.split('/').pop() ?? a.path;
const extOf = (n: string) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
function fileComparator(sortBy: FileSortKey) {
  return (a: ArtifactRecord, b: ArtifactRecord): number => {
    // lastModified is an ISO string — lexicographic compare IS chronological.
    if (sortBy === 'recent') return (b.lastModified || '').localeCompare(a.lastModified || '');
    if (sortBy === 'type') {
      return extOf(fileNameOf(a)).localeCompare(extOf(fileNameOf(b)))
        || fileNameOf(a).localeCompare(fileNameOf(b));
    }
    return fileNameOf(a).localeCompare(fileNameOf(b));
  };
}

// One level of a virtual folder tree built from the flat artifact paths.
// `samples` holds the first few files found beneath the folder, used to render
// the filename-list contents preview on the folder card.
interface DirFolder { name: string; path: string; count: number; samples: ArtifactRecord[] }

// Filenames shown on a folder card before the "…and N more" overflow line.
const FOLDER_PREVIEW_FILES = 3;

// Split the (already-filtered) artifacts into the immediate subfolders + the
// files that live directly in `dir` ('' = project root). Counts on a folder are
// the total files anywhere beneath it (recursive), so the card reads "N files".
// Files sort per the user's sort key; folders always sort by name (a folder has
// no single mtime/type, and a stable folder order keeps navigation predictable).
function listDir(artifacts: ArtifactRecord[], dir: string, sortBy: FileSortKey): { folders: DirFolder[]; files: ArtifactRecord[] } {
  const prefix = dir ? dir + '/' : '';
  const folderCounts = new Map<string, number>();
  const folderSamples = new Map<string, ArtifactRecord[]>();
  const files: ArtifactRecord[] = [];
  for (const a of artifacts) {
    const p = a.path.replace(/\\/g, '/');
    if (prefix && !p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      files.push(a); // directly in this dir
    } else {
      const name = rest.slice(0, slash);
      folderCounts.set(name, (folderCounts.get(name) ?? 0) + 1);
      // Collect a few sample files for the folder-card contents preview.
      const s = folderSamples.get(name);
      if (s) { if (s.length < FOLDER_PREVIEW_FILES) s.push(a); }
      else folderSamples.set(name, [a]);
    }
  }
  const folders = [...folderCounts.entries()]
    .map(([name, count]) => ({
      name, path: dir ? `${dir}/${name}` : name, count,
      samples: folderSamples.get(name) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  files.sort(fileComparator(sortBy));
  return { folders, files };
}

// Folder glyph for the folder cards — shared module (../icons); strokeWidth 1.5
// reads better at the card sizes than the segmented control's default 2.
// Aliased: detail-tool-icons also exports a (different) FolderIcon used by the
// Reveal button above.
import { FolderIcon as FolderCardIcon, DocIcon, ImageIcon, SheetIcon, CodeGlyphIcon } from '../icons';
import { Button } from '../../ui';

// Tiny per-type glyph for the folder-card filename list — one icon per
// fileTypeGroup, so the list rows read like a miniature file listing.
function MiniTypeIcon({ path }: { path: string }) {
  const group = fileTypeGroup(path);
  if (group === 'image') return <ImageIcon size={12} />;
  if (group === 'sheet') return <SheetIcon size={12} />;
  if (group === 'code') return <CodeGlyphIcon size={12} />;
  return <DocIcon size={12} />;
}

// Shared browser for BOTH project-view file sections (the split is the core
// principle): mode='artifacts' lists Claude-authored tracked files (LIST_PROJECT);
// mode='allfiles' lists the project folder's on-disk documents (LIST_ALL_FILES).
// Everything else — folder-tree navigation, cards, the detail overlay — is shared.
export function FilesTab({
  project,
  search,
  typeFilter,
  sortBy,
  hideCode,
  refreshKey,
  mode,
  onMutated,
}: {
  project: CentralIndexProject;
  search: string;     // lifted to ProjectView — lives on the shared seg-row now
  typeFilter: 'all' | FileTypeGroup; // filter popover: type (both file tabs)
  sortBy: FileSortKey;               // filter popover: sort (files only)
  hideCode: boolean;                 // filter popover: hide code & configs (default ON)
  refreshKey: number; // bumped by ProjectView after "+ Add file" to force a reload
  mode: 'artifacts' | 'allfiles';
  // Called after an in-tab sidecar mutation (exclude) so ProjectView can refetch
  // the hero/segment counts without forcing this tab to reload (which would
  // reset the breadcrumb + selection).
  onMutated?: () => void;
}) {
  // Root breadcrumb label + empty-state wording follow the mode.
  const rootLabel = mode === 'allfiles' ? 'All files' : 'Artifacts';
  const noun = mode === 'allfiles' ? 'files' : 'artifacts';
  const { state, dispatch } = useArtifact();
  const pvActiveId = state.activeArtifactBySession[PV_SESSION] ?? null;
  // Read-only here: the toggle chips that SET these live on the ProjectView seg-row.
  const { showDeletedArtifacts } = useTheme();
  const [artifacts, setArtifacts] = useState<ArtifactRecord[]>([]);
  // True until the first load for the current project/mode resolves — gates the
  // empty-state message so "No artifacts yet" can't flash before data arrives.
  const [loading, setLoading] = useState(true);
  // True when on-disk discovery hit a cap (folder too large) — surfaced as a note
  // so a partial list never silently reads as complete.
  const [truncated, setTruncated] = useState(false);
  // Gated root (home dir / drive root): main returns { gated } WITHOUT scanning
  // — the tree is so large the list/count would be an arbitrary sample. The tab
  // renders a "Browse anyway?" gate; forceScan re-requests with { force: true }.
  const [gated, setGated] = useState(false);
  const [forceScan, setForceScan] = useState(false);
  useEffect(() => { setForceScan(false); }, [project.id]); // per-project consent
  // Current folder being browsed ('' = project root). Files are organized into a
  // virtual tree from their relative paths so a 1000-file project is navigable.
  const [currentDir, setCurrentDir] = useState('');

  // Load artifacts whenever the active project changes, or after an add-external
  // (refreshKey bump from ProjectView).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    // ARTIFACTS → tracked sidecar files; ALL FILES → on-disk discovery. Normalize
    // both response shapes (artifacts vs files) into one list.
    const load = mode === 'allfiles'
      ? (window.claude as any).artifacts.listAllFiles(project.id, forceScan ? { force: true } : undefined)
      : (window.claude as any).artifacts.listProject(project.id);
    load.then((res: any) => {
      if (cancelled) return;
      setLoading(false);
      setGated(!!res?.gated);
      if (res && res.ok) { setArtifacts(res.files ?? res.artifacts ?? []); setTruncated(!!res.truncated); }
      else { setArtifacts([]); setTruncated(false); }
    });
    // Clear the active artifact when the project switches so the detail pane
    // doesn't carry stale content from the previous project.
    dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION });
    setCurrentDir(''); // back to the project root on switch
    return () => { cancelled = true; };
  }, [project.id, refreshKey, mode, forceScan]);

  // Existence check: fold "file not on disk" into the deleted UI state alongside
  // sidecar-tracked delete versions. Re-runs whenever the artifact list changes.
  // WHY exclude discovered files: they were JUST found on disk by the scan, so
  // they're inherently present — and their ids aren't sidecar ids, so
  // checkExistence would (wrongly) report every one as "missing" → deleted.
  const [orphanIds, setOrphanIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const trackedIds = artifacts.filter((a) => !a.discovered).map((a) => a.id);
    if (trackedIds.length === 0) { setOrphanIds(new Set()); return; }
    let cancelled = false;
    (window.claude as any).artifacts.checkExistence(project.path, trackedIds)
      .then((res: any) => {
        if (cancelled || !res?.ok) return;
        setOrphanIds(new Set(res.missingIds ?? []));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [project.path, artifacts]);

  // Filter the artifact grid (deleted-state, search, type filter, hide-code).
  // Search matches the FILE NAME only — a query matching a folder name should
  // not surface every file inside that folder. Hide-code is suspended while the
  // "Code & configs" TYPE filter is selected (the two together would always
  // show nothing — an explicit type pick wins over the default hide).
  const effectiveHideCode = hideCode && typeFilter !== 'code';
  const filtered = useMemo(
    () => artifacts.filter((a) => {
      const isDeleted = a.status === 'deleted' || orphanIds.has(a.id);
      if (isDeleted && !showDeletedArtifacts) return false;
      const filename = a.path.split('/').pop() ?? a.path;
      if (search && !filename.toLowerCase().includes(search.toLowerCase())) return false;
      if (typeFilter !== 'all' && fileTypeGroup(a.path) !== typeFilter) return false;
      if (effectiveHideCode && fileTypeGroup(a.path) === 'code') return false;
      return true;
    }),
    [artifacts, showDeletedArtifacts, orphanIds, search, typeFilter, effectiveHideCode],
  );
  const refreshArtifacts = () => {
    const load = mode === 'allfiles'
      ? (window.claude as any).artifacts.listAllFiles(project.id, forceScan ? { force: true } : undefined)
      : (window.claude as any).artifacts.listProject(project.id);
    load.then((r: any) => {
      if (r && r.ok) { setArtifacts(r.files ?? r.artifacts ?? []); setTruncated(!!r.truncated); setGated(!!r.gated); }
    });
  };
  const refreshRef = useRef(refreshArtifacts);
  refreshRef.current = refreshArtifacts;

  // Live external changes (spec §8.3): watch the project root while this tab is
  // mounted, and refresh the list when files appear/disappear on disk. Debounced
  // — a git checkout emits hundreds of add/remove events in a burst, and each
  // uncoalesced refresh would re-run the (cache-invalidated) discovery scan.
  useProjectWatch(project.path);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const unsub = (window.claude as any).artifacts?.onChanged?.((evt: any) => {
      if (evt.projectRoot !== project.path || evt.by !== 'external') return;
      if (evt.kind !== 'add' && evt.kind !== 'remove') return; // edits refetch per-file
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; refreshRef.current(); }, 500);
    });
    return () => {
      if (timer) clearTimeout(timer);
      if (typeof unsub === 'function') unsub();
    };
  }, [project.path]);

  const activeArtifact = pvActiveId ? artifacts.find((a) => a.id === pvActiveId) : undefined;

  // Searching OR an active type filter flattens the tree to matching FILES only
  // — no folder cards. When you're looking for something, folders are noise;
  // each flat card shows its parent folder for context instead. Plain browsing
  // (no search, no type filter) keeps the navigable folder tree; the visibility
  // toggles (hide-code, show-deleted) don't flatten — they only prune it.
  const searching = !!search.trim();
  const flat = searching || typeFilter !== 'all';
  const dirView = useMemo(() => listDir(filtered, currentDir, sortBy), [filtered, currentDir, sortBy]);
  // Flat results honor the same sort as the folder view.
  const flatResults = useMemo(
    () => (flat ? [...filtered].sort(fileComparator(sortBy)) : filtered),
    [filtered, flat, sortBy],
  );
  const segments = currentDir ? currentDir.split('/') : [];

  // One file card — reused by both the flat search results and the folder view.
  const renderFileCard = (a: ArtifactRecord) => {
    const filename = a.path.split('/').pop() ?? a.path;
    const isActive = pvActiveId === a.id;
    const isDeleted = a.status === 'deleted' || orphanIds.has(a.id);
    return (
      // Fixed h-44 (PITFALL: without a fixed card height the thumbnail flex-shrinks
      // to zero in a short grid row, collapsing cards into blank pills). The
      // thumbnail is flex-1; both text lines are shrink-0 so the card stays uniform.
      <button
        key={a.id}
        type="button"
        className={`layer-surface !rounded-lg relative flex flex-col h-44 overflow-hidden text-left transition-transform duration-200 hover:scale-[1.02] ${
          isActive ? 'border-accent' : ''
        } ${isDeleted ? 'opacity-60' : ''}`}
        // No shadow: folder cards are flat, and mixed elevation in one grid read
        // as inconsistent (user feedback 2026-07-08). Same override the seg
        // control uses on its .layer-surface.
        style={{ boxShadow: 'none' }}
        onClick={() => dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId: PV_SESSION, artifactId: a.id })}
        title={isDeleted ? `${a.path}\nDeleted (file is no longer on disk)` : a.path}
      >
        <ArtifactThumbnail
          artifact={a}
          projectPath={project.path}
          className={`flex-1 min-h-0 w-full border-b border-edge-dim ${isDeleted ? 'grayscale' : ''}`}
        />
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
        {/* In flat mode (search / type filter) show the file's folder for
            context; in folder view the breadcrumb already gives location, so
            show the kind instead. */}
        <span className="px-2.5 pb-2.5 text-[10.5px] text-fg-muted shrink-0 truncate">
          {flat && a.path.includes('/')
            ? a.path.slice(0, a.path.lastIndexOf('/'))
            : kindLabel(a.path)}
        </span>
      </button>
    );
  };

  const emptyHere = !flat && dirView.folders.length === 0 && dirView.files.length === 0;

  return (
    <div className="relative flex flex-col h-full overflow-hidden px-2 sm:px-4 pt-4 pb-4 gap-3 min-w-0 max-sm:h-auto max-sm:overflow-visible">
      {/* Breadcrumb — folder-browse mode only (search/type-filter flatten the tree). */}
      {!flat && (
        <div className="flex items-center gap-1 text-[12px] shrink-0 flex-wrap min-w-0">
          <button
            type="button"
            onClick={() => setCurrentDir('')}
            className={currentDir ? 'text-fg-muted hover:text-fg transition-colors' : 'text-fg-2 font-medium'}
          >
            {rootLabel}
          </button>
          {segments.map((seg, i) => {
            const p = segments.slice(0, i + 1).join('/');
            const last = i === segments.length - 1;
            return (
              <React.Fragment key={p}>
                <span className="text-fg-faint">/</span>
                <button
                  type="button"
                  onClick={() => setCurrentDir(p)}
                  className={`truncate max-w-[200px] ${last ? 'text-fg-2 font-medium' : 'text-fg-muted hover:text-fg transition-colors'}`}
                >
                  {seg}
                </button>
              </React.Fragment>
            );
          })}
        </div>
      )}

      {loading && (
        <p className="text-sm text-fg-muted">Loading {noun}…</p>
      )}
      {/* Gated root (home dir / drive root): no scan ran. Explain WHY and offer
          an explicit opt-in — showing an arbitrary truncated sample by default
          would read as "here are your files" when it isn't. */}
      {!loading && gated && (
        <div className="max-w-md mt-4 mx-auto text-center">
          <p className="text-sm text-fg mb-1.5">This folder is very large.</p>
          <p className="text-[13px] text-fg-muted mb-3">
            It covers your whole {rootLooksLikeDrive(project.path) ? 'drive' : 'home folder'}, so
            browsing shows only a partial list and can be slow. Conversations and
            Artifacts work normally either way.
          </p>
          {/* Was a pill (rounded-full). Spec decision 65 reserves pills for
              floating overlay affordances — this is an inline action inside the
              gate message, so it uses the standard button radius. */}
          <Button variant="secondary" onClick={() => setForceScan(true)}>
            Browse anyway
          </Button>
        </div>
      )}
      {!loading && !gated && flat && flatResults.length === 0 && (
        <p className="text-sm text-fg-muted">
          {searching ? `No ${noun} match your search.` : 'Nothing matches the current filters.'}
        </p>
      )}
      {!loading && !gated && emptyHere && (
        <p className="text-sm text-fg-muted">
          {/* When files EXIST but the visibility filters (hide-code / deleted)
              hid them all, say so — the bare "no artifacts yet" empty state
              would lie about the project. */}
          {artifacts.length > 0
            ? currentDir
              ? 'This folder is empty under the current filters.'
              : 'Nothing matches the current filters.'
            : mode === 'allfiles'
              ? 'No files found in this project folder.'
              : 'No artifacts yet — files Claude creates or edits in this project will show up here. Check "All files" to browse everything in the folder.'}
        </p>
      )}

      {/* p-2 gives the hover scale-up room INSIDE the scroll clip box so edge-column
          and first-row cards don't clip; -m-2 cancels that padding's position so the
          cards still line up with the breadcrumb above (the 8px sits in the parent's
          px-4/pt-4 gutter, well inside its clip). */}
      {/* grid-cols-2 on narrow: auto-fill/minmax(180px) correctly falls back to
          ONE column at 390px, but that makes each card a ~342x176 slab — much
          wider than tall, nothing like the intended card proportion. Two ~165px
          columns read correctly on a phone. */}
      <div className="flex-1 overflow-auto max-sm:overflow-visible grid grid-cols-2 sm:grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 content-start p-2 -m-2">
        {flat
          ? flatResults.map(renderFileCard)
          : (
            <>
              {/* Files directly in this folder FIRST, then subfolders (per request:
                  single files sort before folders). */}
              {dirView.files.map(renderFileCard)}
              {dirView.folders.map((f) => {
                const previewFiles = f.samples.slice(0, FOLDER_PREVIEW_FILES);
                return (
                  // Folder cards have a distinct FOLDER SHAPE — a tab on the top-left
                  // plus a body that previews the contents as a FILENAME LIST (the
                  // first few files inside, tiny type icon + name — user-picked over
                  // the old 2x2 thumbnail grid, which read as clutter). The name +
                  // count live INSIDE the folder body (a footer below the preview),
                  // so they read as part of the folder, not a caption floating
                  // beneath it.
                  <button
                    key={'dir:' + f.path}
                    type="button"
                    className="group relative flex flex-col h-44 text-left transition-transform duration-200 hover:scale-[1.02]"
                    onClick={() => setCurrentDir(f.path)}
                    title={f.path}
                  >
                    {/* Folder tab (nub). ml-4 clears the body's rounded top-left
                        corner. The nub carries its OWN bottom border and overlaps
                        the body by exactly 1px (-mb-px), so its border sits ON the
                        body's top border: the separating line stays visible across
                        the joint AND there's no seam gap at fractional zoom levels.
                        (border-b-0 + overlap covered the line; border-b-0 without
                        overlap left a subpixel gap — both were reported.) */}
                    <div className="relative -mb-px ml-4 h-3 w-14 rounded-t-md bg-panel border border-edge group-hover:border-accent/60 transition-colors" />
                    {/* Folder body — preview AND the name/count footer, all inside one
                        bordered, rounded container so they read as the same folder.
                        All four corners rounded — the old rounded-tl-none square
                        corner under the tab read as a glitch, not a folder. bg-panel
                        (not bg-inset) so the folder body matches the file card's
                        .layer-surface background — the two card kinds previously
                        used different tokens and read as mismatched (user feedback
                        2026-07-19). */}
                    <div className="flex-1 min-h-0 flex flex-col rounded-lg border border-edge bg-panel overflow-hidden group-hover:border-accent/60 transition-colors">
                      <div className="flex-1 min-h-0 overflow-hidden">
                        {previewFiles.length > 0 ? (
                          <div className="flex flex-col gap-1.5 p-2.5">
                            {/* First few filenames only — no overflow line (the
                                footer's "N files" count already tells the rest). */}
                            {previewFiles.map((s) => (
                              <div key={s.id} className="flex items-center gap-1.5 min-w-0">
                                <span className="text-fg-muted shrink-0"><MiniTypeIcon path={s.path} /></span>
                                <span className="text-[11px] text-fg-2 truncate">{fileNameOf(s)}</span>
                              </div>
                            ))}
                          </div>
                        ) : (
                          // No previewable files (a folder of subfolders) — folder glyph.
                          <div className="h-full w-full flex items-center justify-center bg-well text-accent">
                            <FolderCardIcon size={40} strokeWidth={1.5} />
                          </div>
                        )}
                      </div>
                      {/* Footer inside the folder: name (with accent folder glyph) + count.
                          bg-panel + the doc-caption typography (12px mono fg-2 name,
                          10.5px fg-muted second line) — same token as the folder
                          body above, so the whole card and the doc cards share one
                          background color. */}
                      <div className="shrink-0 border-t border-edge-dim px-2.5 py-1.5 bg-panel">
                        <div className="text-[12px] font-mono text-fg-2 flex items-center gap-1.5">
                          <span className="text-accent shrink-0"><FolderCardIcon size={13} strokeWidth={1.5} /></span>
                          <span className="truncate">{f.name}</span>
                        </div>
                        <div className="text-[10.5px] text-fg-muted pl-[20px]">
                          {f.count} file{f.count === 1 ? '' : 's'}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
            </>
          )}
      </div>

      {/* Truncation note — discovery hit a cap (very large folder). Never let a
          partial list read as complete. */}
      {truncated && (
        <p className="text-[11px] text-fg-muted shrink-0">
          This folder is large — showing the first batch of files. Some documents deeper in the
          folder aren't listed.
        </p>
      )}

      {/* Selected-artifact detail — rendered in the shared centered overlay
          (Task 2.4). Same load/view/edit/exclude behavior as the prior inline
          detail; only the presentation changed (full-bleed → centered overlay). */}
      {activeArtifact && (
        <ArtifactDetail
          artifact={activeArtifact}
          project={project}
          onRefreshArtifacts={() => { refreshArtifacts(); onMutated?.(); }}
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
  // Drive the viewer's edit lifecycle from the overlay header (controlsInHeader).
  // ActiveArtifactView still owns the edit/save/conflict logic; we only call into
  // it and mirror its edit state so the header can swap Edit ↔ Save/Cancel.
  const viewRef = useRef<ActiveArtifactHandle>(null);
  const [editState, setEditState] = useState({ isEditable: false, editing: false });
  const [copied, setCopied] = useState(false);

  const filename = artifact.path.split('/').pop() ?? artifact.path;
  const absPath = artifactAbsPath(project.path, artifact);

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

  const isElectron = getPlatform() === 'electron';
  const handleReveal = () => (window.claude as any).shell?.showItemInFolder?.(absPath);
  // Open the file with the OS default app (HTML→browser, .docx→Word, etc.) —
  // the right action for formats the in-app viewer can't render (html) or only
  // renders partially (docx/xlsx). Desktop-only (shell.openPath); no-op on remote.
  const handleOpenExternal = () => (window.claude as any).shell?.openPath?.(absPath);
  const handleCopyPath = () => {
    navigator.clipboard?.writeText(absPath).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable — ignore */ });
  };

  // Header tools: Edit ↔ Save/Cancel (only for editable formats) + Reveal + Copy + Exclude.
  const tools = (
    <>
      {editState.isEditable && (editState.editing ? (
        <>
          <button type="button" className={TOOL_BTN_ACCENT} onClick={() => viewRef.current?.saveEdit()}>
            <CheckIcon size={13} />
            Save
          </button>
          <button type="button" className={TOOL_BTN_NEUTRAL} onClick={() => viewRef.current?.cancelEdit()}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className={TOOL_BTN_ACCENT} onClick={() => viewRef.current?.startEdit()}>
          <PencilIcon size={13} />
          Edit
        </button>
      ))}
      {/* shell.openPath / showItemInFolder are desktop-only — remote stubs them
          as no-ops and Android has no handler. Gate on isElectron so the
          buttons can't render dead, matching SessionDrawer's toolbar. */}
      {isElectron && (
        <>
          <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleOpenExternal} title="Open with the default app">
            <ExternalLinkIcon size={13} />
            Open
          </button>
          <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleReveal}>
            <FolderIcon size={13} />
            Reveal
          </button>
        </>
      )}
      <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleCopyPath}>
        <LinkIcon size={13} />
        {copied ? 'Copied' : 'Copy path'}
      </button>
      {/* Exclude = hide from the Artifacts tab: un-pins the file AND writes a
          sticky manualExcludes entry so Claude re-editing it doesn't resurface
          it. Recovery: "+ Add file" re-pins it (includes win over excludes).
          Discovered files have no sidecar entry and aren't in Artifacts anyway,
          so the button is hidden for them. */}
      {!artifact.discovered && (
        <button
          type="button"
          className={TOOL_BTN_NEUTRAL}
          onClick={handleExclude}
          title="Hide this file from Artifacts (bring it back with + Add file)"
        >
          Exclude
        </button>
      )}
    </>
  );

  const modifiedAt = relTime(artifact.lastModified);
  // Discovered files were found on disk (no tracked edit history) — label the
  // timestamp as the file's modified time, not a YouCoded "edited" event.
  const meta = artifact.discovered ? (
    <>
      <span>on disk</span>
      {modifiedAt && (<><span className="text-fg-faint">·</span><span>modified {modifiedAt}</span></>)}
    </>
  ) : (
    <>
      <span>edited</span>
      {modifiedAt && (<><span className="text-fg-faint">·</span><span>{modifiedAt}</span></>)}
    </>
  );

  return (
    <ProjectDetailOverlay title={filename} onClose={handleClose} tools={tools} meta={meta}>
      {/* The viewer owns its own scroll; fill the overlay body height. */}
      <div className="h-full min-h-0">
        <ActiveArtifactView
          ref={viewRef}
          artifact={artifact}
          content={content}
          projectRoot={project.path}
          projectId={project.id}
          projectName={project.name}
          sessionId="project-view"
          onContentChange={setContent}
          controlsInHeader
          onEditStateChange={setEditState}
        />
      </div>
    </ProjectDetailOverlay>
  );
}
