import fs from 'fs';
import path from 'path';
import os from 'os';
import { PastSession, HistoryMessage, SessionFlagName } from '../shared/types';
// ccProjectSlug drive-normalizes before slugifying, so a store originalPath with
// a lowercase Windows drive still maps to CC's uppercase-drive project dir. Used
// lazily inside listPastSessions, so the session-browser ↔ project-conversations
// import cycle is harmless (neither uses the other at module-eval time).
import { ccProjectSlug } from './project-conversations';

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const TOPICS_DIR = path.join(CLAUDE_DIR, 'topics');
const CONVERSATION_INDEX_PATH = path.join(CLAUDE_DIR, 'conversation-index.json');

/** Read per-session metadata from conversation-index.json: the user-set flag
 *  map AND the topic (display name). Lifts v1 legacy `complete` into the flags
 *  shape so older entries still show up.
 *
 *  The conversation index is the *durable* name store — it keeps a session's
 *  topic for 30 days (INDEX_PRUNE_DAYS) and syncs across devices. The
 *  `topics/topic-<id>` files are the *ephemeral* store — pruned by the
 *  auto-title hook and never synced. The Resume Browser reads the file first
 *  and falls back to `topics` here when the file is gone (see readTopic). */
function readIndexMeta(): {
  flags: Record<string, Record<string, boolean>>;
  topics: Record<string, string>;
} {
  const flags: Record<string, Record<string, boolean>> = {};
  const topics: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(CONVERSATION_INDEX_PATH, 'utf8');
    const index = JSON.parse(raw);
    for (const [sid, entry] of Object.entries<any>(index?.sessions || {})) {
      if (!entry) continue;
      const on: Record<string, boolean> = {};
      for (const [name, state] of Object.entries<any>(entry.flags || {})) {
        if (state?.value) on[name] = true;
      }
      // v1 legacy — tolerated on read until old devices are upgraded.
      if (!on.complete && entry.complete) on.complete = true;
      if (Object.keys(on).length > 0) flags[sid] = on;
      if (typeof entry.topic === 'string' && entry.topic.trim()) {
        topics[sid] = entry.topic.trim();
      }
    }
  } catch { /* index missing/corrupt — no flags or topic fallback available */ }
  return { flags, topics };
}

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Retry an async operation up to `attempts` times with a short delay between tries. */
async function withRetry<T>(fn: () => Promise<T>, attempts: number = 3, delayMs: number = 100): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw new Error('unreachable');
}

/**
 * Resolves a project slug back to a real filesystem path by walking the
 * directory tree. The naive approach (replace all dashes with separators)
 * breaks when directory names contain hyphens (e.g. "youcoded-core-dev"
 * becomes "youcoded-core/dev"). This function tries each segment greedily
 * against the filesystem, extending with hyphens when a single part
 * doesn't match a real directory.
 */
function resolveSlugToPath(slug: string): string {
  let root: string;
  let parts: string[];

  if (/^[A-Z]--/.test(slug)) {
    // Windows: C--Users-alice-project → root=C:\, parts=[Users, alice, project]
    root = slug[0] + ':\\';
    parts = slug.slice(3).split('-').filter(Boolean);
  } else {
    // Unix: -home-user-project → root=/, parts=[home, user, project]
    root = '/';
    parts = slug.slice(1).split('-').filter(Boolean);
  }

  if (parts.length === 0) return root;
  return walkSlugParts(root, parts);
}

/**
 * Recursively resolves slug dash-segments against the filesystem.
 * Tries single segment first; if it doesn't exist as a directory,
 * joins with the next segment via hyphen and retries.
 */
function walkSlugParts(base: string, parts: string[]): string {
  for (let len = 1; len <= parts.length; len++) {
    const segment = parts.slice(0, len).join('-');
    const candidate = path.join(base, segment);

    if (len === parts.length) {
      // Last possible grouping — accept whether or not it exists on disk
      return candidate;
    }

    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return walkSlugParts(candidate, parts.slice(len));
      }
    } catch {}
  }

  // Fallback: naive join
  return path.join(base, parts.join('-'));
}

/** Resolve a session's display name. The auto-title hook writes
 *  `topics/topic-<id>`, but those files are pruned (30-day) and never sync
 *  across devices — so when the file is missing, or still holds the pre-title
 *  "New Session" placeholder, fall back to the conversation index, which keeps
 *  the name longer and is synced. Without this fallback the Resume Browser
 *  showed "Untitled" for every session whose topic file had been pruned. */
async function readTopic(sessionId: string, indexTopics: Record<string, string>): Promise<string> {
  try {
    const content = (await fs.promises.readFile(path.join(TOPICS_DIR, `topic-${sessionId}`), 'utf8')).trim();
    // 'Untitled' in a file is a placeholder too (older clients synced such
    // files) — treating it as a real name would bypass the index fallback
    // AND the transcript-derived title, so reject it like 'New Session'.
    if (content && content !== 'New Session' && content !== 'Untitled') return content;
  } catch { /* topic file pruned or never written — fall through to the index */ }
  const indexed = indexTopics[sessionId];
  if (indexed && indexed !== 'New Session' && indexed !== 'Untitled') return indexed;
  return 'Untitled';
}

// Bounded reads so a 100MB transcript doesn't blow up the browse call.
const HEAD_CHUNK_BYTES = 256 * 1024;
const TAIL_CHUNK_BYTES = 64 * 1024;
const FALLBACK_TITLE_MAX = 48;

export interface SessionTranscriptMeta {
  /** Title derived from the first real user prompt, or null. */
  fallbackTitle: string | null;
  /** Timestamp (ms) of the last parseable transcript line, or null. */
  lastTimestampMs: number | null;
}

/** Collapse whitespace and trim a derived title to a word boundary. */
function cleanTitle(text: string): string | null {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (!collapsed) return null;
  if (collapsed.length <= FALLBACK_TITLE_MAX) return collapsed;
  const cut = collapsed.slice(0, FALLBACK_TITLE_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  // Trim back to the last word boundary, but only when that leaves a
  // reasonable stub (>20 chars) — otherwise a long first word would shrink
  // the title to almost nothing, so we hard-cut mid-word instead.
  return (lastSpace > 20 ? cut.slice(0, lastSpace) : cut) + '…';
}

/**
 * Derive display metadata straight from the transcript JSONL.
 *
 * WHY: the topic/index naming pipeline has gaps (the auto-title hook only
 * fires on PostToolUse, so chat-only sessions are never titled; titles also
 * depend on the in-session model complying), and file mtimes are clobbered
 * by sync restores. The transcript content itself is the only source of
 * truth that survives both. See docs/PITFALLS.md → Resume Browser.
 *
 * CC-coupled: relies on the transcript JSONL line shape (`type`, `isMeta`,
 * `promptId`, `timestamp`, `message.content`) — same contract the
 * transcript-watcher parses. See youcoded/docs/cc-dependencies.md.
 */
export async function readSessionTranscriptMeta(jsonlPath: string, wantTitle: boolean): Promise<SessionTranscriptMeta> {
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(jsonlPath, 'r');
    const { size } = await fh.stat();

    // --- Tail: last parseable line's timestamp ---
    let lastTimestampMs: number | null = null;
    const tailLen = Math.min(TAIL_CHUNK_BYTES, size);
    if (tailLen > 0) {
      const tailBuf = Buffer.alloc(tailLen);
      await fh.read(tailBuf, 0, tailLen, size - tailLen);
      // First "line" of the chunk is usually a partial JSON line — the
      // backwards scan just skips anything that doesn't parse.
      const tailLines = tailBuf.toString('utf8').split('\n');
      for (let i = tailLines.length - 1; i >= 0; i--) {
        const line = tailLines[i];
        if (!line.trim() || line.includes('\x00')) continue;
        try {
          const ts = Date.parse(JSON.parse(line).timestamp);
          if (!Number.isNaN(ts)) { lastTimestampMs = ts; break; }
        } catch { /* partial or corrupt line — keep scanning backwards */ }
      }
    }

    // --- Head: first real user prompt → fallback title ---
    let fallbackTitle: string | null = null;
    if (wantTitle) {
      const headLen = Math.min(HEAD_CHUNK_BYTES, size);
      const headBuf = Buffer.alloc(headLen);
      await fh.read(headBuf, 0, headLen, 0);
      for (const line of headBuf.toString('utf8').split('\n')) {
        if (!line.trim() || line.includes('\x00')) continue;
        let parsed: any;
        try { parsed = JSON.parse(line); } catch { continue; }
        // Same "real conversational prompt" gate as loadHistory: user-type,
        // has promptId, not meta.
        if (parsed.type !== 'user' || parsed.isMeta || !parsed.promptId || !parsed.message) continue;
        const c = parsed.message.content;
        const text = typeof c === 'string'
          ? c
          : Array.isArray(c)
            ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join(' ')
            : '';
        // Skip injected wrappers (<command-name>…, <local-command-stdout>…,
        // <system-reminder>…) — they're plumbing, not what the user said.
        // Deliberately lossy: a real prompt that starts with '<' (pasted
        // HTML/XML) is also skipped, and the scan moves to the next prompt.
        if (!text.trim() || text.trim().startsWith('<')) continue;
        fallbackTitle = cleanTitle(text);
        if (fallbackTitle) break;
      }
    }

    return { fallbackTitle, lastTimestampMs };
  } catch {
    return { fallbackTitle: null, lastTimestampMs: null };
  } finally {
    try { await fh?.close(); } catch {}
  }
}

/**
 * Scans all project directories for JSONL transcript files.
 * Returns sessions sorted by last modified (most recent first).
 * Excludes sessions that are currently active (matching activeSessionIds).
 * Uses async I/O with Promise.all for parallelism.
 */
export async function listPastSessions(activeSessionIds?: Set<string>): Promise<PastSession[]> {
  let slugs: string[];
  try {
    const entries = await withRetry(() => fs.promises.readdir(PROJECTS_DIR));
    const statResults = await Promise.all(
      entries.map(async (f) => {
        try {
          const stat = await withRetry(() => fs.promises.stat(path.join(PROJECTS_DIR, f)));
          return stat.isDirectory() ? f : null;
        } catch { return null; }
      })
    );
    slugs = statResults.filter((s): s is string => s !== null);
  } catch (err) {
    // A missing/unreadable projects dir is NORMAL on a fresh secondary device
    // (store synced, but no local CC transcripts written here yet). Degrade to
    // an empty legacy scan and fall through to the store union below — remote
    // conversations must still appear so they're visible "everywhere". (Phase 2a)
    console.warn('[session-browser] Failed to read projects directory:', err);
    slugs = [];
  }

  // Join flag + topic metadata from the synced conversation index
  const indexMeta = readIndexMeta();

  const allSessions: PastSession[] = [];

  for (const slug of slugs) {
    const slugDir = path.join(PROJECTS_DIR, slug);
    let files: string[];
    try {
      files = (await withRetry(() => fs.promises.readdir(slugDir))).filter((f) => f.endsWith('.jsonl'));
    } catch (err) {
      console.warn(`[session-browser] Failed to read slug dir ${slug} after retries:`, err);
      continue;
    }

    const sessionPromises = files.map(async (file) => {
      const sessionId = file.replace('.jsonl', '');
      if (activeSessionIds?.has(sessionId)) return null;

      try {
        const stat = await withRetry(() => fs.promises.stat(path.join(slugDir, file)));
        if (stat.size < 500) return null;
        const topicName = await readTopic(sessionId, indexMeta.topics);

        // Transcript-derived metadata: content timestamp beats file mtime
        // (sync restores clobber mtimes), and the first user message names
        // sessions the title pipeline missed. readSessionTranscriptMeta returns
        // nulls on any failure, so this can only improve on the defaults.
        const meta = await readSessionTranscriptMeta(path.join(slugDir, file), topicName === 'Untitled');
        const name = topicName !== 'Untitled'
          ? topicName
          : (meta.fallbackTitle ?? 'Untitled');

        const joinedFlags = indexMeta.flags[sessionId];
        return {
          sessionId,
          name,
          projectSlug: slug,
          projectPath: resolveSlugToPath(slug),
          lastModified: meta.lastTimestampMs ?? stat.mtimeMs,
          size: stat.size,
          ...(joinedFlags ? { flags: joinedFlags } : {}),
        } as PastSession;
      } catch {
        console.warn(`[session-browser] Failed to stat ${slug}/${file} after retries`);
        return null;
      }
    });

    const results = await Promise.all(sessionPromises);
    allSessions.push(...results.filter((s): s is PastSession => s !== null));
  }

  // Deduplicate: aggregation symlinks/copies place project-specific .jsonl
  // files into the home slug for unified browsing. When the same sessionId
  // appears in both the home slug and a project slug, keep the project slug
  // entry so resume uses the correct working directory.
  const deduped = new Map<string, PastSession>();
  for (const s of allSessions) {
    const existing = deduped.get(s.sessionId);
    if (!existing || s.projectSlug.length > existing.projectSlug.length) {
      deduped.set(s.sessionId, s);
    }
  }

  const result = Array.from(deduped.values());

  // Store union (Phase 2a): the Conversation Store is the canonical record;
  // legacy transcript scanning stays as the fallback until Plan 2c deletes it.
  // Store rows WIN on display metadata (title/lastActive/flags/device) so a
  // conversation named on another device reads right here; legacy rows WIN on
  // projectSlug/projectPath because resume needs the LOCAL slug, which the store
  // doesn't know for a conversation that never ran on this device. A store
  // record with no local transcript becomes a NEW row flagged missingProject
  // (visible everywhere, resume disabled) when its project folder isn't here.
  // `deduped` is already keyed by sessionId, so it doubles as the merge index;
  // mutating a legacy value mutates the same object already in `result`.
  try {
    const { getConversationStore } = await import('./conversations/service');
    const store = getConversationStore();
    if (store) {
      const records = await store.list('claude');
      for (const rec of records) {
        const legacy = deduped.get(rec.id);
        // Store flags are { value, updatedAt }; keep only the ON, known flags.
        const flags: Partial<Record<SessionFlagName, boolean>> = {};
        for (const [k, v] of Object.entries(rec.flags)) {
          if (v.value && (k === 'complete' || k === 'priority' || k === 'helpful')) flags[k] = true;
        }
        if (legacy) {
          // Overlay store metadata onto the local row (resume slug/path untouched).
          legacy.name = rec.title || legacy.name;
          legacy.lastModified = Math.max(legacy.lastModified, Date.parse(rec.lastActive) || 0);
          if (Object.keys(flags).length) legacy.flags = flags;
          legacy.device = rec.device || undefined;
          legacy.provider = rec.provider;
        } else {
          // Store-only conversation: resolve its project locally. When the folder
          // isn't on this device, there's no cwd to resume into — flag it.
          const localPath = rec.originalPath && fs.existsSync(rec.originalPath) ? rec.originalPath : null;
          result.push({
            sessionId: rec.id,
            name: rec.title || 'Untitled',
            projectSlug: localPath ? ccProjectSlug(localPath) : '',
            projectPath: localPath ?? rec.originalPath,
            lastModified: Date.parse(rec.lastActive) || 0,
            size: 0,
            ...(Object.keys(flags).length ? { flags } : {}),
            device: rec.device || undefined,
            provider: rec.provider,
            ...(localPath ? {} : { missingProject: true }),
          });
        }
      }
    }
  } catch { /* store unavailable — the legacy list stands alone */ }

  result.sort((a, b) => b.lastModified - a.lastModified);
  return result;
}

/**
 * Loads the last N conversational messages from a session's JSONL file.
 * "Conversational" = user prompts (with promptId, not meta) and assistant
 * end_turn responses (text content only, no tool calls).
 *
 * Uses async I/O with single-pass deduplication (Map overwrite pattern)
 * and null-byte line filtering.
 */
export async function loadHistory(
  sessionId: string,
  projectSlug: string,
  count: number = 10,
  all: boolean = false,
): Promise<HistoryMessage[]> {
  if (!SAFE_ID_RE.test(projectSlug) || !SAFE_ID_RE.test(sessionId)) return [];
  const jsonlPath = path.join(PROJECTS_DIR, projectSlug, `${sessionId}.jsonl`);

  let content: string;
  try {
    content = await fs.promises.readFile(jsonlPath, 'utf8');
  } catch {
    return [];
  }

  // Filter null-byte corrupted lines (NTFS pre-allocation gaps from process kills)
  const lines = content.trim().split('\n').filter(line =>
    line.trim() && !line.includes('\x00')
  );

  // Single-pass: overwrite Map by UUID (last occurrence wins for dedup)
  const lastParsedByUuid = new Map<string, any>();
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.uuid && (parsed.type === 'user' || parsed.type === 'assistant')) {
        lastParsedByUuid.set(parsed.uuid, parsed);
      }
    } catch {}
  }

  // Extract conversational messages from deduplicated set (preserves insertion order)
  const messages: HistoryMessage[] = [];
  for (const parsed of lastParsedByUuid.values()) {
    const message = parsed.message;
    if (!message) continue;

    if (parsed.type === 'user') {
      if (parsed.isMeta) continue;
      if (!parsed.promptId) continue;
      const c = message.content;
      const text = typeof c === 'string'
        ? c
        : Array.isArray(c)
          ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
          : '';
      if (!text.trim()) continue;
      messages.push({ role: 'user', content: text.trim(), timestamp: parsed.timestamp || 0 });
    } else if (parsed.type === 'assistant' && message.stop_reason === 'end_turn') {
      const c = message.content;
      const texts = Array.isArray(c)
        ? c.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n')
        : typeof c === 'string' ? c : '';
      if (!texts.trim()) continue;
      messages.push({ role: 'assistant', content: texts.trim(), timestamp: parsed.timestamp || 0 });
    }
  }

  if (all) return messages;
  return messages.slice(-count);
}
