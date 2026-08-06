/**
 * chatsearch index — PURE core. No fs/path/os imports, ever.
 *
 * Turn extraction for both provider lanes. The two lanes store user messages in
 * completely different shapes (CC: raw Claude Code JSONL with string-or-block
 * content and ISO timestamps; native: TranscriptEvent with data.text and epoch-ms
 * timestamps), so each gets its own extractor and both emit the same IndexTurn.
 */

/** One indexed user turn. Serialized to <provider>-turns.jsonl by index-store. */
export interface IndexTurn {
  conversationId: string;
  /** 1-based ordinal among INDEXED turns (not among all JSONL lines). */
  turn: number;
  /** ISO-8601. Normalized across both lanes so date filters work uniformly. */
  ts: string;
  text: string;
}

export interface ExtractResult {
  turns: IndexTurn[];
  /**
   * Byte offset just past the last COMPLETE line in `chunk`. The caller stores
   * this and resumes there, so a half-written trailing line is never parsed and
   * never double-counted once it is finished.
   */
  consumedBytes: number;
}

/**
 * The "real conversational prompt" gate, matching session-browser.ts.
 *
 * NOTE what this does NOT do: it does not exclude tool-result carrier lines.
 * Those are type 'user' AND carry a promptId (verified: all 101 user lines in a
 * real transcript had one). They are excluded downstream because their content
 * holds no `text` blocks, so userTurnText returns '' and isIndexableText drops
 * it. Do not "optimize" that second filter away.
 */
export function isRealUserTurn(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const p = parsed as Record<string, unknown>;
  return p.type === 'user' && !p.isMeta && !!p.promptId && !!p.message;
}

/**
 * Text of a CC user line. Content is a string OR an array of blocks; only `text`
 * blocks contribute, which is what collapses tool-result lines to ''.
 *
 * `joiner` defaults to '\n' (loadHistory's behavior). The title head-scan uses
 * ' '. The index uses the default.
 */
export function userTurnText(parsed: unknown, joiner: string = '\n'): string {
  if (!parsed || typeof parsed !== 'object') return '';
  const message = (parsed as Record<string, unknown>).message;
  if (!message || typeof message !== 'object') return '';
  const c = (message as Record<string, unknown>).content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c
      .filter((b) => b && typeof b === 'object' && (b as Record<string, unknown>).type === 'text')
      .map((b) => String((b as Record<string, unknown>).text ?? ''))
      .join(joiner);
  }
  return '';
}

/**
 * Is this text worth putting in the index?
 *
 * The '<' skip removes injected wrappers (<system-reminder>, <command-name>,
 * <local-command-stdout>) that are plumbing, not what the user said. Deliberately
 * lossy: a real prompt that starts with '<' (pasted HTML/XML) is dropped too.
 *
 * WHY this is not shared with loadHistory: chat rendering MUST keep such a
 * prompt — dropping it would blank a real message in the UI. Only the index and
 * the title scan want it gone.
 */
export function isIndexableText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !t.startsWith('<');
}

/** ISO-8601 from either lane's timestamp format; '' when unparseable. */
export function normalizeTimestamp(v: unknown): string {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v).toISOString();
  if (typeof v === 'string') {
    const ms = Date.parse(v);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  return '';
}

/**
 * Split a chunk into complete lines plus the byte offset just past the last one.
 * A chunk with no trailing newline yields consumedBytes for only the complete
 * prefix, so the unfinished tail is re-read next cycle.
 */
function completeLines(chunk: string): { lines: string[]; consumedBytes: number } {
  const lastNewline = chunk.lastIndexOf('\n');
  if (lastNewline === -1) return { lines: [], consumedBytes: 0 };
  const complete = chunk.slice(0, lastNewline + 1);
  return {
    lines: complete.split('\n'),
    // BYTE length, not character length — the caller seeks by bytes, and a
    // character count desyncs the offset on any non-ASCII prompt.
    consumedBytes: Buffer.byteLength(complete, 'utf8'),
  };
}

/** Blank or null-byte-corrupt lines (NTFS pre-allocation gaps) are never parsed. */
function isParseableLine(line: string): boolean {
  return !!line.trim() && !line.includes('\x00');
}

/** Extract indexable user turns from a Claude Code transcript chunk. */
export function extractCcUserTurns(
  chunk: string,
  conversationId: string,
  startTurn: number
): ExtractResult {
  const { lines, consumedBytes } = completeLines(chunk);
  const turns: IndexTurn[] = [];
  let turn = startTurn;

  for (const line of lines) {
    if (!isParseableLine(line)) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!isRealUserTurn(parsed)) continue;
    const text = userTurnText(parsed);
    if (!isIndexableText(text)) continue;
    turns.push({
      conversationId,
      turn: turn++,
      ts: normalizeTimestamp((parsed as Record<string, unknown>).timestamp),
      text: text.trim(),
    });
  }

  return { turns, consumedBytes };
}

/**
 * Extract indexable user turns from a native harness session chunk.
 *
 * `isStartOfFile` must be true only when reading from byte 0: line 1 is the
 * NativeSessionHeader, not an event. On an incremental resume the offset is
 * already past it, so skipping a line there would silently drop a real message.
 */
export function extractNativeUserTurns(
  chunk: string,
  conversationId: string,
  startTurn: number,
  isStartOfFile: boolean
): ExtractResult {
  const { lines, consumedBytes } = completeLines(chunk);
  const turns: IndexTurn[] = [];
  let turn = startTurn;
  let skipHeader = isStartOfFile;

  for (const line of lines) {
    if (!isParseableLine(line)) continue;
    if (skipHeader) { skipHeader = false; continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    if (!parsed || typeof parsed !== 'object') continue;
    const ev = parsed as Record<string, unknown>;
    if (ev.type !== 'user-message') continue;
    const data = ev.data as Record<string, unknown> | undefined;
    const text = typeof data?.text === 'string' ? data.text : '';
    if (!isIndexableText(text)) continue;
    turns.push({
      conversationId,
      turn: turn++,
      ts: normalizeTimestamp(ev.timestamp),
      text: text.trim(),
    });
  }

  return { turns, consumedBytes };
}
