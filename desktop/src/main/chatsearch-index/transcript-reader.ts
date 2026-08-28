// Reads a BOUNDED slice of a past conversation for the preview pane, on both
// lanes. Keyed by id: the renderer never names a path. Main looks the id up in
// the index it wrote itself, prefers the local transcript, and falls back to
// the mirror the index recorded.
//
// Deliberately NOT loadHistory (session-browser.ts): that keeps assistant text
// only where stop_reason === 'end_turn', which on a real 42 MB transcript
// discarded 1,135 of 1,405 assistant messages. A preview exists so someone can
// remember what was decided, and the deciding happens between the tool calls —
// so every assistant text block is kept, only tool activity is dropped, and
// the dropped calls are COUNTED so the pane can admit the gap instead of
// presenting an edited conversation as the whole one.
//
// The OUTPUT is bounded; the INPUT is not — the whole file has to be parsed to
// know the ordinals. So parsed messages are cached per file identity (path +
// mtime + size) for the pane's lifetime: "Load older" slices the cached array
// rather than parsing 42 MB a second time.
import fs from 'node:fs';
import path from 'node:path';
import type { ChatsearchReadRequest, ChatsearchReadResponse, TranscriptMessage } from '../../shared/chatsearch-refs';
import { COPY, READ_TAIL_MAX } from '../../shared/chatsearch-refs';

const SESSION_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NUL = String.fromCharCode(0);

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('\n');
  }
  return '';
}

function toolUsesIn(content: unknown): number {
  return Array.isArray(content) ? content.filter((b: any) => b && b.type === 'tool_use').length : 0;
}

function splitLines(text: string): string[] {
  // Null-byte lines are NTFS pre-allocation gaps left by a killed process, not
  // data — a JSON.parse of one throws and would otherwise look like corruption.
  return text.split('\n').filter((l) => l.trim() && !l.includes(NUL));
}

/** Claude Code JSONL → messages (+ whether every line was a subagent sidechain). */
export function parseClaudeTranscript(text: string): { messages: TranscriptMessage[]; allSidechain: boolean } {
  const byUuid = new Map<string, any>(); // last occurrence wins — loadHistory's rule
  for (const line of splitLines(text)) {
    try {
      const p = JSON.parse(line);
      if (p && p.uuid && (p.type === 'user' || p.type === 'assistant')) byUuid.set(p.uuid, p);
    } catch { /* torn line at the tail of a file being written */ }
  }
  const out: TranscriptMessage[] = [];
  let dropped = 0, seen = 0, sidechain = 0;
  for (const p of byUuid.values()) {
    seen++;
    if (p.isSidechain) sidechain++;
    const m = p.message;
    if (!m) continue;
    if (p.type === 'user') {
      // No promptId means the line is a tool result wearing the user role, not
      // something a person typed; isMeta lines are the harness talking to itself.
      if (p.isMeta || !p.promptId) continue;
      const t = textOf(m.content).trim();
      if (!t) continue;
      out.push({ role: 'user', content: t, timestamp: Date.parse(p.timestamp) || 0, seq: out.length, droppedToolCalls: dropped });
      dropped = 0;
    } else {
      // Push this message's TEXT first — it closes the gap that came before it
      // — and only THEN count its own tool calls toward the gap before the
      // next message. The other order attributes a message's own tool calls to
      // itself, which reads as "3 tools not shown" above text that preceded them.
      const t = textOf(m.content).trim();
      if (t) {
        out.push({ role: 'assistant', content: t, timestamp: Date.parse(p.timestamp) || 0, seq: out.length, droppedToolCalls: dropped });
        dropped = 0;
      }
      dropped += toolUsesIn(m.content);
    }
  }
  return { messages: out, allSidechain: seen > 0 && sidechain === seen };
}

/** Native session JSONL (header line + TranscriptEvent lines) → messages. */
export function parseNativeTranscript(text: string): TranscriptMessage[] {
  const out: TranscriptMessage[] = [];
  let dropped = 0;
  for (const line of splitLines(text)) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (!ev || typeof ev.type !== 'string') continue; // the header line has no type
    if (ev.type === 'tool-use') { dropped += 1; continue; }
    if (ev.type !== 'user-message' && ev.type !== 'assistant-text') continue;
    const t = typeof ev.data?.text === 'string' ? ev.data.text.trim() : '';
    if (!t) continue;
    out.push({
      role: ev.type === 'user-message' ? 'user' : 'assistant',
      content: t, timestamp: Number(ev.timestamp) || 0, seq: out.length, droppedToolCalls: dropped,
    });
    dropped = 0;
  }
  return out;
}

/** Is this native file a specialist's transcript rather than a conversation?
 *  The lane equivalent of a Claude sidechain: a specialist is spawned BY a
 *  conversation and reads as one on disk, but nobody ever talked to it. */
function isNativeSpecialist(text: string): boolean {
  const first = splitLines(text)[0];
  if (!first) return false;
  try {
    const h = JSON.parse(first);
    return !!h && typeof h === 'object' && (h.sessionKind === 'specialist' || !!h.parentSessionId);
  } catch {
    return false;
  }
}

export function sliceMessages(all: TranscriptMessage[], tail: number, before?: number): { messages: TranscriptMessage[]; hasMore: boolean } {
  const n = Math.min(Math.max(1, Math.floor(tail) || 1), READ_TAIL_MAX);
  const end = before === undefined ? all.length : Math.max(0, Math.min(before, all.length));
  const start = Math.max(0, end - n);
  return { messages: all.slice(start, end), hasMore: start > 0 };
}

/** realpath the candidate and require it under one of the roots, with a
 *  trailing separator so `root-evil/` cannot pass as being under `root`.
 *  Null means refuse — realpath is what catches a symlink pointing out. */
export function containedTranscriptPath(candidate: string, roots: string[]): string | null {
  let real: string;
  try { real = fs.realpathSync(candidate); } catch { return null; }
  for (const root of roots) {
    let realRoot: string;
    try { realRoot = fs.realpathSync(root); } catch { continue; }
    if (real.startsWith(realRoot + path.sep)) return real;
  }
  return null;
}

const isSubagentPath = (p: string) => p.split(/[\\/]/).includes('subagents');

export interface ParsedCacheEntry { key: string; messages: TranscriptMessage[] }

export interface ReadDeps {
  entryFor: (provider: 'claude' | 'native', id: string) => { transcriptPath: string; tombstone: boolean } | null;
  localPathFor: (provider: 'claude' | 'native', id: string) => string | null;
  /** Legal roots, resolved at call time — the space root is user-configurable. */
  roots: string[];
  /** Per-file parse cache, keyed by real path; value key = `${mtimeMs}:${size}`. */
  cache: Map<string, ParsedCacheEntry>;
}

export async function readTranscriptSlice(req: ChatsearchReadRequest, deps: ReadDeps): Promise<ChatsearchReadResponse> {
  if (!SESSION_UUID_RE.test(req.id)) return { ok: false, error: COPY.errNotAnId };
  const entry = deps.entryFor(req.provider, req.id);
  if (!entry) return { ok: false, error: COPY.errNotIndexed };
  if (entry.tombstone) return { ok: false, error: COPY.previewTombstone };
  // Local first (authoritative and current), then the mirror the index recorded.
  const candidates = [deps.localPathFor(req.provider, req.id), entry.transcriptPath].filter((p): p is string => !!p);
  let chosen: string | null = null;
  for (const c of candidates) {
    if (isSubagentPath(c)) return { ok: false, error: COPY.errNotAConversation };
    const contained = containedTranscriptPath(c, deps.roots);
    if (contained) { chosen = contained; break; }
    // A path that EXISTS but sits outside every root is a refusal, not a
    // fall-through: saying "not found" would be a lie about why.
    if (fs.existsSync(c)) return { ok: false, error: COPY.errOutsideRoots };
  }
  if (!chosen) {
    try { fs.statSync(entry.transcriptPath); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    return { ok: false, error: COPY.errOutsideRoots };
  }
  let st: fs.Stats;
  try { st = fs.statSync(chosen); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
  const key = `${st.mtimeMs}:${st.size}`;
  let cached = deps.cache.get(chosen);
  if (!cached || cached.key !== key) {
    let text: string;
    try { text = await fs.promises.readFile(chosen, 'utf8'); } catch (e: any) { return { ok: false, error: e?.message || String(e) }; }
    let messages: TranscriptMessage[];
    if (req.provider === 'native') {
      if (isNativeSpecialist(text)) return { ok: false, error: COPY.errNotAConversation };
      messages = parseNativeTranscript(text);
    } else {
      const r = parseClaudeTranscript(text);
      if (r.allSidechain) return { ok: false, error: COPY.errNotAConversation };
      messages = r.messages;
    }
    cached = { key, messages };
    // Bound the cache: the pane looks at one or two conversations at a time,
    // and each entry can be a whole parsed transcript.
    if (deps.cache.size >= 4) deps.cache.delete(deps.cache.keys().next().value as string);
    deps.cache.set(chosen, cached);
  }
  return { ok: true, ...sliceMessages(cached.messages, req.tail, req.before) };
}
