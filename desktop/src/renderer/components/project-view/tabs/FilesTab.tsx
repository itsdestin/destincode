// FilesTab — the folder-tree file browser for one project, used for BOTH halves of
// the core Artifacts/All-files split (see ipc-channels.ts):
//   mode='artifacts' → ARTIFACTS: files Claude directly created/edited (LIST_PROJECT,
//                      sidecar-tracked). Honors "Show deleted"/orphan state.
//   mode='allfiles'  → ALL FILES: the project folder's on-disk documents
//                      (LIST_ALL_FILES, full-browser discovery). Honors "Hide code".
// Cards use .layer-surface; the deleted badge is a plain word "deleted" (the ●◐○ / ✕
// glyph language is disliked — plain words instead).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useArtifact } from '../../../state/ArtifactContext';
import { useTheme } from '../../../state/theme-context';
import type { CentralIndexProject, ArtifactRecord } from '../../../../shared/artifacts/types';
import { ActiveArtifactView } from '../../artifact-views/ActiveArtifactView';
import type { ActiveArtifactHandle } from '../../artifact-views/ActiveArtifactView';
import { ArtifactThumbnail } from '../../ArtifactThumbnail';
import { categorizeArtifact } from '../../../../shared/artifacts/categorization';
import { ProjectDetailOverlay } from '../ProjectDetailOverlay';
import {
  TOOL_BTN_ACCENT, TOOL_BTN_NEUTRAL, PencilIcon, CheckIcon, FolderIcon, LinkIcon, ExternalLinkIcon,
} from '../detail-tool-icons';

// Compact relative-time for the detail meta strip (matches ConversationsTab).
function relTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
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

// Human "kind" label for a card (Document / Image / Code / Config), derived from
// the shared categorizer — matches the prototype's artCard second line.
function kindLabel(p: string): string {
  const c = categorizeArtifact(p);
  return c ? c.charAt(0).toUpperCase() + c.slice(1) : 'File';
}

// One level of a virtual folder tree built from the flat artifact paths.
// `samples` holds up to 4 files found beneath the folder, used to render a 2x2
// contents preview on the folder card.
interface DirFolder { name: string; path: string; count: number; samples: ArtifactRecord[] }

const FOLDER_PREVIEW_TILES = 4;

// Split the (already-filtered) artifacts into the immediate subfolders + the
// files that live directly in `dir` ('' = project root). Counts on a folder are
// the total files anywhere beneath it (recursive), so the card reads "N files".
function listDir(artifacts: ArtifactRecord[], dir: string): { folders: DirFolder[]; files: ArtifactRecord[] } {
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
      if (s) { if (s.length < FOLDER_PREVIEW_TILES) s.push(a); }
      else folderSamples.set(name, [a]);
    }
  }
  const folders = [...folderCounts.entries()]
    .map(([name, count]) => ({
      name, path: dir ? `${dir}/${name}` : name, count,
      samples: folderSamples.get(name) ?? [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => (a.path.split('/').pop() || '').localeCompare(b.path.split('/').pop() || ''));
  return { folders, files };
}

// lucide-style folder glyph for the folder cards (matches the app's iconography).
function FolderGlyph({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}

// Shared browser for BOTH project-view file sections (the split is the core
// principle): mode='artifacts' lists Claude-authored tracked files (LIST_PROJECT);
// mode='allfiles' lists the project folder's on-disk documents (LIST_ALL_FILES).
// Everything else — folder-tree navigation, cards, the detail overlay — is shared.
export function FilesTab({
  project,
  search,
  refreshKey,
  mode,
  onMutated,
}: {
  project: CentralIndexProject;
  search: string;     // lifted to ProjectView — lives on the shared seg-row now
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
  // True when on-disk discovery hit a cap (folder too large) — surfaced as a note
  // so a partial list never silently reads as complete.
  const [truncated, setTruncated] = useState(false);
  // Current folder being browsed ('' = project root). Files are organized into a
  // virtual tree from their relative paths so a 1000-file project is navigable.
  const [currentDir, setCurrentDir] = useState('');

  // Load artifacts whenever the active project changes, or after an add-external
  // (refreshKey bump from ProjectView).
  useEffect(() => {
    let cancelled = false;
    // ARTIFACTS → tracked sidecar files; ALL FILES → on-disk discovery. Normalize
    // both response shapes (artifacts vs files) into one list.
    const load = mode === 'allfiles'
      ? (window.claude as any).artifacts.listAllFiles(project.id)
      : (window.claude as any).artifacts.listProject(project.id);
    load.then((res: any) => {
      if (cancelled) return;
      if (res && res.ok) { setArtifacts(res.files ?? res.artifacts ?? []); setTruncated(!!res.truncated); }
      else { setArtifacts([]); setTruncated(false); }
    });
    // Clear the active artifact when the project switches so the detail pane
    // doesn't carry stale content from the previous project.
    dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: PV_SESSION });
    setCurrentDir(''); // back to the project root on switch
    return () => { cancelled = true; };
  }, [project.id, refreshKey, mode]);

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

  // Filter the artifact grid.
  const filtered = useMemo(
    () => artifacts.filter((a) => {
      const isDeleted = a.status === 'deleted' || orphanIds.has(a.id);
      if (isDeleted && !showDeletedArtifacts) return false;
      if (search && !a.path.toLowerCase().includes(search.toLowerCase())) return false;
      return true;
    }),
    [artifacts, showDeletedArtifacts, orphanIds, search],
  );
  const refreshArtifacts = () => {
    const load = mode === 'allfiles'
      ? (window.claude as any).artifacts.listAllFiles(project.id)
      : (window.claude as any).artifacts.listProject(project.id);
    load.then((r: any) => {
      if (r && r.ok) { setArtifacts(r.files ?? r.artifacts ?? []); setTruncated(!!r.truncated); }
    });
  };

  const activeArtifact = pvActiveId ? artifacts.find((a) => a.id === pvActiveId) : undefined;

  // Search flattens the tree (find a file anywhere); otherwise browse by folder.
  const searching = !!search.trim();
  const dirView = useMemo(() => listDir(filtered, currentDir), [filtered, currentDir]);
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
        {/* In search mode show the file's folder for context; in folder view the
            breadcrumb already gives location, so show the kind instead. */}
        <span className="px-2.5 pb-2.5 text-[10.5px] text-fg-muted shrink-0 truncate">
          {searching && a.path.includes('/')
            ? a.path.slice(0, a.path.lastIndexOf('/'))
            : kindLabel(a.path)}
        </span>
      </button>
    );
  };

  const emptyHere = !searching && dirView.folders.length === 0 && dirView.files.length === 0;

  return (
    <div className="relative flex flex-col h-full overflow-hidden px-4 pt-4 pb-4 gap-3 min-w-0">
      {/* Breadcrumb — folder-browse mode only (search flattens the whole tree). */}
      {!searching && (
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

      {searching && filtered.length === 0 && (
        <p className="text-sm text-fg-muted">No {noun} match your search.</p>
      )}
      {emptyHere && (
        <p className="text-sm text-fg-muted">
          {currentDir
            ? 'This folder is empty under the current filters.'
            : mode === 'allfiles'
              ? 'No documents found in this project folder. Try toggling "Hide code & configs" above.'
              : 'No artifacts yet — files Claude creates or edits in this project will show up here. Check "All files" to browse everything in the folder.'}
        </p>
      )}

      {/* p-2 gives the hover scale-up room INSIDE the scroll clip box so edge-column
          and first-row cards don't clip; -m-2 cancels that padding's position so the
          cards still line up with the breadcrumb above (the 8px sits in the parent's
          px-4/pt-4 gutter, well inside its clip). */}
      <div className="flex-1 overflow-auto grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3 content-start p-2 -m-2">
        {searching
          ? filtered.map(renderFileCard)
          : (
            <>
              {/* Files directly in this folder FIRST, then subfolders (per request:
                  single files sort before folders). */}
              {dirView.files.map(renderFileCard)}
              {dirView.folders.map((f) => {
                const tiles = f.samples.slice(0, FOLDER_PREVIEW_TILES);
                return (
                  // Folder cards have a distinct FOLDER SHAPE — a tab on the top-left
                  // plus a body that previews the contents as a 2x2 grid of the first
                  // files inside (macOS/Drive style). The name + count live INSIDE the
                  // folder body (a footer below the preview), so they read as part of
                  // the folder, not a caption floating beneath it.
                  <button
                    key={'dir:' + f.path}
                    type="button"
                    className="group relative flex flex-col h-44 text-left transition-transform duration-200 hover:scale-[1.02]"
                    onClick={() => setCurrentDir(f.path)}
                    title={f.path}
                  >
                    {/* Folder tab. */}
                    <div className="ml-2 h-3 w-14 rounded-t-md bg-inset border border-edge border-b-0 group-hover:border-accent/60 transition-colors" />
                    {/* Folder body — preview AND the name/count footer, all inside one
                        bordered, rounded container so they read as the same folder. */}
                    <div className="flex-1 min-h-0 flex flex-col rounded-lg rounded-tl-none border border-edge bg-inset overflow-hidden group-hover:border-accent/60 transition-colors">
                      <div className="flex-1 min-h-0">
                        {tiles.length > 0 ? (
                          // 2x2 contents preview. gap-px over a bg-edge-dim parent draws
                          // hairline dividers between the mini thumbnails.
                          <div className="grid grid-cols-2 grid-rows-2 gap-px h-full w-full bg-edge-dim">
                            {tiles.map((s) => (
                              <div key={s.id} className="overflow-hidden bg-canvas">
                                <ArtifactThumbnail artifact={s} projectPath={project.path} className="w-full h-full" />
                              </div>
                            ))}
                            {Array.from({ length: FOLDER_PREVIEW_TILES - tiles.length }).map((_, i) => (
                              <div key={'empty' + i} className="bg-well" />
                            ))}
                          </div>
                        ) : (
                          // No previewable files (a folder of subfolders) — folder glyph.
                          <div className="h-full w-full flex items-center justify-center bg-well text-accent">
                            <FolderGlyph size={40} />
                          </div>
                        )}
                      </div>
                      {/* Footer inside the folder: name (with accent folder glyph) + count. */}
                      <div className="shrink-0 border-t border-edge-dim px-2.5 py-1.5">
                        <div className="text-[12.5px] font-semibold text-fg flex items-center gap-1.5">
                          <span className="text-accent shrink-0"><FolderGlyph size={13} /></span>
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
      <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleOpenExternal} title="Open with the default app">
        <ExternalLinkIcon size={13} />
        Open
      </button>
      <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleReveal}>
        <FolderIcon size={13} />
        Reveal
      </button>
      <button type="button" className={TOOL_BTN_NEUTRAL} onClick={handleCopyPath}>
        <LinkIcon size={13} />
        {copied ? 'Copied' : 'Copy path'}
      </button>
      {/* Exclude only applies to TRACKED artifacts (it writes the sidecar's
          manualExcludes). Discovered files have no sidecar entry, so hide it
          rather than silently no-op / create a sidecar just to exclude a doc. */}
      {!artifact.discovered && (
        <button
          type="button"
          className={TOOL_BTN_NEUTRAL}
          onClick={handleExclude}
          title="Exclude this file from artifact tracking"
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
