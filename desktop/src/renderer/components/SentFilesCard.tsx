// SentFilesCard — the in-bubble card for files the assistant hands to the user
// via the SendUserFile tool (Claude Code's built-in, mirrored by the native
// harness under the same name — spec 2026-08-25).
//
// Layout decisions (Destin, 2026-08-25):
//   - Lives INSIDE the assistant bubble, after the message text and ABOVE that
//     turn's tool cards. Not collapsible, no tool chrome — it is the deliverable,
//     not a log line. The SendUserFile call is pulled out of its tool group the
//     same way Skill cards are (see AssistantTurnBubble → ToolGroupInline).
//   - Two columns of previews when the chat is wide, one column of shorter
//     previews when narrow (useNarrowViewport — the same 640px boundary the
//     rest of the app branches on).
//   - Every tile opens the artifact viewer through useOpenFilepath, the same
//     path a filepath pill takes — so untracked files (a scratchpad report)
//     still open, and "Open" never lies.
//   - Preview is ArtifactThumbnail: ONE preview mechanism app-wide (image /
//     first lines of text / scaled HTML page / letter glyph). Nothing here
//     re-implements a thumbnail.
import { useMemo } from 'react';
import type { ToolCallState } from '../../shared/types';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { useArtifactOptional } from '../state/ArtifactContext';
import { useNarrowViewport } from '../hooks/use-narrow-viewport';
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

interface TileProps {
  path: string;
  sessionId: string;
  status: ToolCallState['status'];
  narrow: boolean;
}

function SentFileTile({ path, sessionId, status, narrow }: TileProps) {
  const artifactCtx = useArtifactOptional();
  const open = useOpenFilepath(sessionId);
  const cwd = artifactCtx?.state.sessionCwd?.[sessionId];
  const sessionArts = artifactCtx?.state.sessionArtifacts?.[sessionId];
  const abs = resolveAbsolute(path, cwd);

  const tracked = useMemo(
    () => matchSessionArtifact(sessionArts ?? [], abs),
    [sessionArts, abs],
  );
  const record = tracked ?? standInRecord(abs);
  // Internal records resolve relative to the session's project; externals
  // carry their own absolutePath and ignore projectPath.
  const projectPath = record.kind === 'internal' ? (cwd ?? '') : '';

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
      className={`group flex flex-col w-full min-w-0 text-left rounded-lg bg-well border border-edge hover:border-fg-muted overflow-hidden transition-colors ${failed ? 'opacity-70' : ''}`}
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
          <span className="block text-sm-tight font-semibold text-fg truncate">{name}</span>
          {dir && <span className="block text-2xs font-mono text-fg-muted truncate">{dir}/</span>}
        </span>
        <span className="shrink-0 inline-flex items-center gap-1 text-2xs font-semibold text-fg-2 border border-edge group-hover:border-fg-muted rounded-md px-2 py-1 transition-colors">
          Open
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 7h10v10" />
            <path d="M7 17 17 7" />
          </svg>
        </span>
      </div>
    </button>
  );
}

interface Props {
  /** Every SendUserFile call in this bubble, in invocation order. Each call
   *  renders its own grid + caption; calls stack vertically. */
  tools: ToolCallState[];
  sessionId: string;
}

export function SentFilesCard({ tools, sessionId }: Props) {
  const narrow = useNarrowViewport();
  if (tools.length === 0) return null;
  return (
    <div className="mt-3 space-y-3" data-testid="sent-files-card">
      {tools.map((tool) => {
        const files = sentFilePaths(tool.input);
        const caption = asString(tool.input.caption);
        if (files.length === 0 && !caption) return null;
        return (
          <div key={tool.toolUseId}>
            {files.length > 0 && (
              <div className={`grid gap-2 ${narrow ? 'grid-cols-1' : 'grid-cols-2'}`}>
                {files.map((fp) => (
                  <SentFileTile key={fp} path={fp} sessionId={sessionId} status={tool.status} narrow={narrow} />
                ))}
              </div>
            )}
            {caption && (
              <p className="mt-2 text-sm text-fg-2 leading-snug">{caption}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
