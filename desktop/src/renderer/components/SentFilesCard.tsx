// SentFilesCard — the in-bubble card for files the assistant hands to the user
// via the SendUserFile tool (Claude Code's built-in, mirrored by the native
// harness under the same name — spec 2026-08-25).
//
// Layout decisions (Destin, 2026-08-25 — workbench compare rounds 1–2, pick
// "D + scroll-aware fades + collapsible"):
//   - ONE "Files" card per bubble, LAST in the bubble after the tool cards. It
//     is the deliverable, not a log line, so it must stay visually distinct
//     from a collapsed tool group: lifted bg-well card, a "Files · N" header
//     with the caption, and previews instead of a status line. The
//     SendUserFile calls are pulled out of their tool groups the same way
//     Skill cards are (see AssistantTurnBubble → ToolGroupInline).
//   - Body is a FILMSTRIP: one row of fixed-width preview tiles that scrolls
//     sideways. A fade on the right says "more this way" only while there IS
//     more; a fade on the left appears once a tile has slid under that edge.
//     Same strip on narrow screens (a sideways swipe is natural on a phone).
//   - Collapsible like a tool card (chevron; Ctrl+O expand/collapse-all
//     applies), but OPEN by default — the whole point is seeing the files.
//   - Every tile opens the artifact viewer through useOpenFilepath, the same
//     path a filepath pill takes — so untracked files (a scratchpad report)
//     still open, and "Open" never lies.
//   - Preview is ArtifactThumbnail: ONE preview mechanism app-wide (image /
//     first lines of text / scaled HTML page / letter glyph). Nothing here
//     re-implements a thumbnail.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ToolCallState } from '../../shared/types';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { useArtifactOptional } from '../state/ArtifactContext';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';
import { useExpandAllToggle } from '../hooks/useExpandAllToggle';
import { ChevronIcon } from './Icons';
import { useOpenFilepath } from '../hooks/useOpenFilepath';
import { ArtifactThumbnail } from './ArtifactThumbnail';
import { matchSessionArtifact } from './filepath-match';
import { asString } from '../utils/tool-input';

export const SENT_FILES_TOOL = 'SendUserFile';

export function isSentFilesTool(tool: ToolCallState | undefined): tool is ToolCallState {
  return !!tool && tool.toolName === SENT_FILES_TOOL;
}

/** The `files` argument, tolerant of the model sending a single string. Tool
 *  inputs are untyped JSON — never trust the shape (see utils/tool-input). */
export function sentFilePaths(input: Record<string, unknown>): string[] {
  const raw = input.files;
  if (Array.isArray(raw)) return raw.filter((f): f is string => typeof f === 'string' && f.length > 0);
  const single = asString(raw) || asString(input.file) || asString(input.file_path);
  return single ? [single] : [];
}

function basename(fp: string): string {
  const parts = fp.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || fp;
}

function parentDir(fp: string): string {
  const norm = fp.replace(/\\/g, '/');
  const parts = norm.split('/').filter(Boolean);
  const dir = parts.slice(0, -1).join('/');
  // Keep the leading slash on absolute paths: "/tmp/scratch/" is a location,
  // "tmp/scratch/" reads as a folder inside the project — which it isn't.
  return norm.startsWith('/') && dir ? '/' + dir : dir;
}

function isAbsolute(p: string): boolean {
  return /^([a-zA-Z]:\/|\/|~)/.test(p.replace(/\\/g, '/'));
}

/** Best-effort absolute path: join a relative path onto the session cwd. Used
 *  for the right-click menu (data-file-path) and the untracked-file stand-in. */
function resolveAbsolute(p: string, cwd?: string): string {
  const norm = p.replace(/\\/g, '/');
  if (isAbsolute(norm) || !cwd) return norm;
  return cwd.replace(/[\\/]+$/, '') + '/' + norm.replace(/^\.\//, '');
}

/** A throwaway ArtifactRecord for a file the session hasn't tracked (yet).
 *  Images still preview (ArtifactThumbnail reads by absolutePath); text/html
 *  fall back to the letter glyph until the tracker records the file. Never
 *  persisted — it exists only to feed the thumbnail. */
function standInRecord(absPath: string): ArtifactRecord {
  return {
    id: absPath,
    path: basename(absPath),
    kind: 'external',
    absolutePath: absPath,
    lastModified: '',
    status: 'active',
    versions: [],
    comments: [],
    tags: [],
  };
}

export interface SentFileTileProps {
  path: string;
  sessionId: string;
  status: ToolCallState['status'];
  narrow: boolean;
  /** Workbench compare view only: hand the tile its record + project root
   *  directly. The compare route mounts without ArtifactProvider, so the
   *  session-artifact lookup below has nothing to match against. Never set
   *  from production code — the lookup is the real path. */
  record?: ArtifactRecord;
  projectPath?: string;
  /** Tile background utility. Default bg-well lifts a tile off the bubble;
   *  a tile nested inside a bg-well card passes bg-inset to alternate. */
  tileBg?: string;
  /** Let the filename wrap to two lines instead of truncating — for narrow
   *  filmstrip tiles where "scroll-pe…" says nothing. */
  wrapName?: boolean;
  /** Filmstrip tiles: the whole tile is the click target and width is scarce,
   *  so the "Open" button collapses to its arrow glyph and the name gets the
   *  full row. */
  compact?: boolean;
}

export function SentFileTile({ path, sessionId, status, narrow, record: recordOverride, projectPath: projectPathOverride, tileBg = 'bg-well', wrapName = false, compact = false }: SentFileTileProps) {
  const artifactCtx = useArtifactOptional();
  const open = useOpenFilepath(sessionId);
  const cwd = artifactCtx?.state.sessionCwd?.[sessionId];
  const sessionArts = artifactCtx?.state.sessionArtifacts?.[sessionId];
  const abs = resolveAbsolute(path, cwd);

  const matched = useMemo(
    () => matchSessionArtifact(sessionArts ?? [], abs),
    [sessionArts, abs],
  );
  const tracked = recordOverride ?? matched;
  const record = tracked ?? standInRecord(abs);
  // Internal records resolve relative to the session's project; externals
  // carry their own absolutePath and ignore projectPath.
  const projectPath = projectPathOverride ?? (record.kind === 'internal' ? (cwd ?? '') : '');

  const labelPath = tracked?.kind === 'internal' ? tracked.path : path;
  const name = basename(labelPath);
  const dir = parentDir(labelPath);
  const failed = status === 'failed';
  const sending = status === 'running' || status === 'awaiting-approval';

  return (
    <button
      type="button"
      onClick={() => { void open(path); }}
      title={failed ? `${path} — could not be sent` : `Open ${name}`}
      // data-file-path (absolute) lets the chat right-click menu recover the
      // real path for View in folder / Copy as path — left-click opens the
      // in-app artifact viewer.
      data-file-path={abs || undefined}
      data-testid="sent-file-tile"
      className={`group flex flex-col w-full min-w-0 text-left rounded-lg ${tileBg} border border-edge hover:border-fg-muted overflow-hidden transition-colors ${failed ? 'opacity-70' : ''}`}
    >
      <div className={`relative w-full ${narrow ? 'h-16' : 'h-28'} border-b border-edge`}>
        <ArtifactThumbnail
          artifact={record}
          projectPath={projectPath}
          bgClass="bg-canvas"
          className="w-full h-full"
        />
        {sending && (
          // Tool still running: the file isn't confirmed yet. Dim the preview
          // and say so, rather than showing a finished-looking card that may
          // turn into an error a second later.
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/70 text-2xs font-medium text-fg-muted animate-pulse">
            Sending…
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center bg-canvas/80 text-2xs font-semibold text-red-400">
            Couldn’t send — not found
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-2.5 py-2 min-w-0">
        <span className="flex-1 min-w-0">
          <span className={`block text-sm-tight font-semibold text-fg ${wrapName ? 'line-clamp-2 leading-snug [overflow-wrap:anywhere]' : 'truncate'}`}>{name}</span>
          {dir && <span className="block text-2xs font-mono text-fg-muted truncate">{dir}/</span>}
        </span>
        <span className={`shrink-0 inline-flex items-center gap-1 text-2xs font-semibold text-fg-2 border border-edge group-hover:border-fg-muted rounded-md transition-colors ${compact ? 'p-1 self-start' : 'px-2 py-1'}`} aria-label="Open">
          {!compact && 'Open'}
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 7h10v10" />
            <path d="M7 17 17 7" />
          </svg>
        </span>
      </div>
    </button>
  );
}

// The document glyph FilepathToken draws, at header size.
function FilesGlyph({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
  );
}

/** Tracks whether a horizontally scrolling element has content hidden past
 *  either edge. Re-measured on scroll and on resize (a bubble that widens can
 *  bring the last tile fully into view, at which point the right fade lies). */
function useEdgeOverflow(ref: React.RefObject<HTMLDivElement | null>, deps: unknown[]) {
  const [edges, setEdges] = useState({ left: false, right: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const left = el.scrollLeft > 2;
      const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
    };
    measure();
    el.addEventListener('scroll', measure, { passive: true });
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', measure); ro.disconnect(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return edges;
}

interface Props {
  /** Every SendUserFile call in this bubble, in invocation order. They merge
   *  into ONE card: files concatenate, each keeps its own call's status. */
  tools: ToolCallState[];
  sessionId: string;
}

export function SentFilesCard({ tools, sessionId }: Props) {
  const narrow = useNarrowViewport();
  // Open by default — unlike a tool card — because the files ARE the reply.
  // Still collapsible, and Ctrl+O's expand/collapse-all applies, so the card
  // behaves like the tool cards around it once the user starts managing space.
  const [open, setOpen] = useState(true);
  useExpandAllToggle(() => setOpen(true), () => setOpen(false));

  const entries = useMemo(
    () => tools.flatMap((tool) => sentFilePaths(tool.input).map((path) => ({ path, status: tool.status, key: `${tool.toolUseId}:${path}` }))),
    [tools],
  );
  const captions = useMemo(
    () => tools.map((t) => asString(t.input.caption)).filter((c): c is string => !!c),
    [tools],
  );

  const stripRef = useRef<HTMLDivElement>(null);
  const edges = useEdgeOverflow(stripRef, [open, entries.length, narrow]);

  if (entries.length === 0 && captions.length === 0) return null;

  // One caption rides the header; several stack under the strip so none is lost.
  const headerCaption = captions.length === 1 ? captions[0] : '';
  const footCaptions = captions.length > 1 ? captions : [];
  const fade = (side: 'left' | 'right') => ({
    background: `linear-gradient(to ${side === 'left' ? 'right' : 'left'}, var(--well), transparent)`,
  });

  return (
    <div className="mt-2 rounded-lg border border-edge bg-well overflow-hidden" data-testid="sent-files-card">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-inset/50 transition-colors"
      >
        <FilesGlyph className="w-3.5 h-3.5 shrink-0 text-fg-dim" />
        <span className="text-xs font-semibold text-fg-2">Files</span>
        <span className="text-2xs font-mono text-fg-muted">{entries.length}</span>
        <span className="flex-1 min-w-0 text-2xs text-fg-muted truncate text-right">{headerCaption}</span>
        <ChevronIcon className="w-3.5 h-3.5 shrink-0 text-fg-muted" expanded={open} />
      </button>
      {open && (
        <>
          <div className="relative">
            <div ref={stripRef} className="flex gap-2 overflow-x-auto px-2 pb-2" data-testid="sent-files-strip">
              {entries.map((e) => (
                <div key={e.key} className={`${narrow ? 'w-44' : 'w-56'} shrink-0`}>
                  <SentFileTile path={e.path} sessionId={sessionId} status={e.status} narrow={narrow} tileBg="bg-inset" compact />
                </div>
              ))}
            </div>
            {/* Edge fades: only while something is actually hidden past that
                edge, so a strip that fits shows none and a fully-scrolled strip
                shows only the left one. */}
            {edges.left && <div className="pointer-events-none absolute top-0 bottom-2 left-0 w-10" style={fade('left')} data-testid="sent-files-fade-left" />}
            {edges.right && <div className="pointer-events-none absolute top-0 bottom-2 right-0 w-10" style={fade('right')} data-testid="sent-files-fade-right" />}
          </div>
          {footCaptions.map((c, i) => (
            <p key={i} className="px-3 pb-2 -mt-0.5 text-2xs text-fg-muted">{c}</p>
          ))}
        </>
      )}
    </div>
  );
}
