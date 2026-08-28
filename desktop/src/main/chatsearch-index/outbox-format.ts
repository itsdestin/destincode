// Outbox protocol between the chatsearch CLI and the app. Spec: docs/active/specs/
// 2026-08-27-chatsearch-writes-and-bundled-plugin-upgrade-design.md §A2.
// WHY a file protocol: the CLI can't reach the running app (no auth-free local
// endpoint), direct store edits would race the app's in-memory records, and a
// mailbox works when the app is closed (drained at launch).
export const OUTBOX_FORMAT_VERSION = 1;
export const NOTE_MAX_CHARS = 8000; // matches SESSION_SET_NOTE

export interface OutboxTarget { provider: string; id: string }
export type OutboxOp =
  | { op: 'flag'; targets: OutboxTarget[]; flag: 'complete' | 'priority'; value: boolean }
  | { op: 'note'; targets: OutboxTarget[]; mode: 'set' | 'append'; text: string }
  | { op: 'tag'; targets: OutboxTarget[]; add: string[]; remove: string[]; create: boolean };

export interface OutboxRequest {
  v: number; id: string; createdAt: string; storeRoot: string; ops: OutboxOp[];
}

export type ReceiptStatus = 'applied' | 'already' | 'not-found' | 'refused' | 'error';
export interface ReceiptResult extends OutboxTarget { op: OutboxOp['op']; status: ReceiptStatus; error?: string }
export interface OutboxReceipt {
  v: number; id: string; appliedAt: string; appVersion: string;
  results: ReceiptResult[]; createdTags: Array<{ id: string; label: string }>;
  error?: string; // only when the request itself was unusable
}

const isRec = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const UUID_RE = /^[0-9a-f-]{8,64}$/i;

function parseTargets(v: unknown): OutboxTarget[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  const out: OutboxTarget[] = [];
  for (const t of v) {
    if (!isRec(t) || typeof t.provider !== 'string' || typeof t.id !== 'string' || !t.id) return null;
    out.push({ provider: t.provider, id: t.id });
  }
  return out;
}

export function parseOutboxRequest(raw: string): { ok: true; req: OutboxRequest } | { ok: false; error: string } {
  let j: unknown;
  try { j = JSON.parse(raw); } catch (e: any) { return { ok: false, error: `request is not valid JSON — ${e?.message ?? String(e)}` }; }
  if (!isRec(j)) return { ok: false, error: 'request is not a JSON object' };
  if (j.v !== OUTBOX_FORMAT_VERSION) return { ok: false, error: `unsupported request version ${String(j.v)} (this app reads v${OUTBOX_FORMAT_VERSION})` };
  if (typeof j.id !== 'string' || !UUID_RE.test(j.id)) return { ok: false, error: 'request id is missing or malformed' };
  if (typeof j.storeRoot !== 'string' || !j.storeRoot) return { ok: false, error: 'request has no storeRoot' };
  if (!Array.isArray(j.ops) || j.ops.length === 0) return { ok: false, error: 'request has no ops' };
  const ops: OutboxOp[] = [];
  for (const o of j.ops) {
    if (!isRec(o)) return { ok: false, error: 'an op is not an object' };
    const targets = parseTargets(o.targets);
    if (!targets) return { ok: false, error: `op "${String(o.op)}" has no valid targets` };
    if (o.op === 'flag') {
      if (o.flag !== 'complete' && o.flag !== 'priority') return { ok: false, error: `unknown flag "${String(o.flag)}"` };
      if (typeof o.value !== 'boolean') return { ok: false, error: 'flag value must be true or false' };
      ops.push({ op: 'flag', targets, flag: o.flag, value: o.value });
    } else if (o.op === 'note') {
      if (o.mode !== 'set' && o.mode !== 'append') return { ok: false, error: `note mode must be set or append, got "${String(o.mode)}"` };
      if (typeof o.text !== 'string') return { ok: false, error: 'note text must be a string' };
      ops.push({ op: 'note', targets, mode: o.mode, text: o.text });
    } else if (o.op === 'tag') {
      const strs = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === 'string') ? (x as string[]) : null;
      const add = strs(o.add ?? []); const remove = strs(o.remove ?? []);
      if (!add || !remove) return { ok: false, error: 'tag add/remove must be arrays of strings' };
      if (add.length === 0 && remove.length === 0) return { ok: false, error: 'tag op adds and removes nothing' };
      ops.push({ op: 'tag', targets, add, remove, create: o.create === true });
    } else {
      return { ok: false, error: `unknown op "${String(o.op)}"` };
    }
  }
  return { ok: true, req: { v: 1, id: j.id, createdAt: typeof j.createdAt === 'string' ? j.createdAt : '', storeRoot: j.storeRoot, ops } };
}

/** append formatting: blank note → just the line; else two newlines then the line. */
export function appendNoteText(existing: string, day: string, text: string): string {
  const line = `${day}: ${text}`;
  // Fix: trimEnd (not the untrimmed `existing`) in the template — deciding on
  // trimmed text but appending to the untrimmed string let a note ending in
  // "\n\n" accumulate to four newlines on every append.
  return existing.trim() ? `${existing.trimEnd()}\n\n${line}` : line;
}

// WHY a block match, not a single-line match: `text` may itself contain a
// newline (an ordinary multi-line close note). appendNoteText writes it as one
// block ("<date>: line one\nline two"), so the old per-line comparison could
// never match a single split line against the whole `text` and every retried
// append re-appended. Matching the whole block (date wildcarded, anchored on
// both ends so "superseded" doesn't false-match "superseded by X") fixes that
// while keeping the retried-`close`-is-a-no-op guarantee for single-line notes.
export function hasDatedLine(existing: string, text: string): boolean {
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|\\n\\n)\\d{4}-\\d{2}-\\d{2}: ${escaped}($|\\n)`);
  return re.test(existing);
}
