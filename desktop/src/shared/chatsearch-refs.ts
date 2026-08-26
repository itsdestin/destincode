// Shared contract for "session references": the two IPC channels the renderer
// uses to turn a chatsearch tool call into Preview / Resume cards, every piece
// of user-facing copy the feature shows, and the PURE parser that decides
// whether a Bash call is a chatsearch call at all.
//
// WHY the parser lives in shared/ and not the renderer: ToolCard (header label,
// expanded default) and ToolBody (card body) both need the same answer, and a
// unit test must run it without React. One function, two consumers — they can
// never disagree about what a call is.
import type { ToolCallState } from './types';

export type ChatsearchProvider = 'claude' | 'native';

/** Lane names are developer jargon; users see these. */
export function providerLabel(p: string): string {
  return p === 'native' ? 'YouCoded assistant' : 'Claude Code';
}

/** Every sentence this feature shows. Rendered in the workbench at the gate. */
export const COPY = {
  preview: 'Preview',
  resume: 'Resume',
  resumeNative: 'Resume…',
  previewHint: 'Read this conversation in the side pane',
  resumeHint: 'Continue this conversation in a new tab',
  resumeNativeHint: 'Pick a model, then continue this conversation in a new tab',
  // Verbatim from ResumeBrowser.tsx:978 — the Resume Browser already teaches
  // users these two sentences; the card must not invent a third.
  resumeMissingProject: 'Project folder not on this device',
  resumeNotSynced: 'Not synced to this device yet',
  previewTombstone: 'Transcript is no longer on this device',
  unknownId: 'Not in the index on this device',
  ambiguousId: (n: number) => `Matches ${n} conversations`,
  lookingUp: (n: number) => `Looking up ${n} conversation${n === 1 ? '' : 's'}…`,
  headerFind: (n: number) => `Found ${n} past conversation${n === 1 ? '' : 's'}`,
  headerShow: 'Past conversation',
  paneSubtitle: (p: string) => `Past conversation · read-only · ${providerLabel(p)}`,
  untitled: 'Untitled conversation',
  noProject: '(no project)',
  toolsNotShown: (n: number) => `${n} tool call${n === 1 ? '' : 's'} not shown`,
  startOfConversation: 'start of conversation',
  loadOlder: 'Load older',
  rawOutput: 'Raw output',
  referencedHeading: 'Referenced conversations',
  // Phase B error strings (main process). Listed here so the gate can show them.
  errNotAnId: 'Not a conversation id',
  errNotIndexed: 'This conversation is not in the index on this device',
  errNotAConversation: 'This file is a helper transcript, not a conversation',
  errOutsideRoots: 'Transcript is stored outside the folders YouCoded may read',
  errReadPrefix: "Couldn't read this transcript: ",
} as const;

/** What `chatsearch:resolve` returns per requested id. */
export type ResolvedConversation =
  | {
      status: 'ok';
      id: string;
      provider: ChatsearchProvider;
      /** '' when untitled. */
      title: string;
      projectName: string;
      originalPath: string;
      lastActive: string;
      createdAt: string;
      tags: string[];
      complete: boolean;
      tombstone: boolean;
      /** Resume prerequisites — same computation as the Resume Browser. */
      projectSlug: string;
      projectPath: string;
      missingProject: boolean;
      notSyncedYet: boolean;
    }
  | { status: 'unknown'; query: string }
  | { status: 'ambiguous'; query: string; candidates: string[] };

export type ChatsearchResolveResponse =
  | { ok: true; results: ResolvedConversation[] }
  | { ok: false; error: string };

/** One transcript message as the preview renders it. */
export interface TranscriptMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  /** Ordinal in the FULL conversation — `before: seq` pages backwards. */
  seq: number;
  /** Tool calls that ran between the previous kept message and this one. */
  droppedToolCalls: number;
}

export interface ChatsearchReadRequest {
  provider: ChatsearchProvider;
  id: string;
  /** Messages to return, counted back from the end (or from `before`). 1..200. */
  tail: number;
  /** Return messages with seq < before. Omit for the newest slice. */
  before?: number;
}

export type ChatsearchReadResponse =
  | { ok: true; messages: TranscriptMessage[]; hasMore: boolean }
  | { ok: false; error: string };

export const READ_TAIL_MAX = 200;
export const READ_TAIL_DEFAULT = 40;

/**
 * Output that reached us may be partial. Three producers, three markers:
 * the native harness (main/harness/tools/truncate.ts) by chars and by lines,
 * and Claude Code, which truncates long tool results in the transcript.
 */
export const TRUNCATION_MARKERS = ['[...]', '[... ', 'characters truncated]'] as const;

export type ChatsearchCall =
  | { cmd: 'find'; shortIds: string[] }
  | { cmd: 'show'; id: string; provider: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// A find row: <short id>  <yyyy-mm-dd | ---------->  … — the id is a uuid
// prefix (hex and dashes, ≥4 chars, chatsearch.js MIN_SHORT_ID); the CLI prints
// ten dashes when the date is unknown (chatsearch.js:63). formatRows() pads
// every column with padEnd(widestInColumn) and joins columns with TWO spaces
// (chatsearch.js:341), so real rows always carry >=2 spaces after the id —
// this must stay \s{2,}, not \s+, or the regex would start matching prose.
const FIND_ROW_RE = /^([0-9a-f-]{4,36})\s{2,}(?:\d{4}-\d{2}-\d{2}|-{10})\s{2,}/;

export function parseFindShortIds(output: string): string[] {
  const ids: string[] = [];
  for (const line of output.split('\n')) {
    const m = FIND_ROW_RE.exec(line);
    if (m) ids.push(m[1]);
  }
  return ids;
}

export function parseShowId(output: string): { id: string; provider: string } | null {
  const lines = output.split('\n');
  // WHY scan instead of reading lines[0]: cmdShow (chatsearch.js:782) pushes a
  // staleness banner and then index.problems onto the output BEFORE the
  // metadata block, so the uuid line is frequently NOT the first line of real
  // output. Scan for the first line whose first token is a full uuid instead.
  const idLineIdx = lines.findIndex((l) => UUID_RE.test(l.trim().split(/\s+/)[0] ?? ''));
  if (idLineIdx < 0) return null;
  const id = lines[idLineIdx].trim().split(/\s+/)[0];
  const provLine = lines.slice(idLineIdx + 1).find((l) => l.startsWith('provider:'));
  return { id, provider: provLine ? provLine.slice('provider:'.length).trim() : '' };
}

/** Does this command run chatsearch with its stdout intact? Decidable from the
 *  command alone, so ToolCard can expand the card before the output exists. */
export function isChatsearchCommand(command: string): boolean {
  const idx = command.indexOf('chatsearch.js');
  if (idx < 0) return false;
  // Anything after the script that pipes or redirects stdout means the output
  // we hold may be partial — never build a card on it. `2>&1` loses nothing.
  // The stdin heredoc form (`cat <<'JSON' | node …chatsearch.js`) pipes INTO
  // the script, which is fine, so only the text AFTER the script is inspected.
  const after = command.slice(idx + 'chatsearch.js'.length).replace(/2>&1/g, '');
  return !/[|>]/.test(after);
}

/**
 * Is this tool call a finished chatsearch invocation whose output can be
 * turned into a card? Returns null for "render it as plain Bash".
 */
export function describeChatsearchCall(tool: ToolCallState): ChatsearchCall | null {
  if (tool.toolName !== 'Bash') return null;
  const command = typeof tool.input?.command === 'string' ? tool.input.command : '';
  if (!isChatsearchCommand(command)) return null;
  if (tool.status !== 'complete') return null;
  const output = tool.response ?? '';
  if (!output.trim()) return null;
  if (TRUNCATION_MARKERS.some((m) => output.includes(m))) return null;
  // The subcommand is read from the OUTPUT, never the command line: `cmd`
  // defaults to find when absent and the request may arrive on stdin.
  const show = parseShowId(output);
  if (show) return { cmd: 'show', ...show };
  const shortIds = parseFindShortIds(output);
  return shortIds.length ? { cmd: 'find', shortIds } : null;
}
