// PURE record logic for the Conversation Store (Phase 2a design §1).
// No fs/path/os imports — the IO shell (conversation-store.ts) does disk work.
// This is the same pure-core/IO-shell split as local-theme-synthesizer.ts:
// keeping this file free of side effects is what lets us unit-test every merge
// and parse rule with plain objects and no mocks.
import type { SessionProvider } from '../../shared/types';

export const RECORD_SCHEMA_VERSION = 1;

// One flag's state — matches the legacy conversation-index v2 shape so flags
// (pinned, archived, etc.) migrate losslessly in Plan 2c. `updatedAt` is what
// lets us merge a single flag independently of the whole record.
export interface FlagState { value: boolean; updatedAt: string }

export interface ConversationRecord {
  schema: number;
  id: string;                    // provider-stable conversation id (CC: session UUID)
  provider: SessionProvider | string; // 'claude' today; string-open for future providers
  projectName: string;           // portable cross-device key (folder basename)
  originalPath: string;          // path on the device that created it
  title: string;                 // '' means untitled
  lastActive: string;            // ISO-8601 — set at EVENT time, never from file mtime
  device: string;                // last device that ran a turn
  flags: Record<string, FlagState>;
  transcriptRef: string;         // space-relative, e.g. 'claude/transcripts/<key>/<id>.jsonl'
  createdAt: string;             // ISO-8601
}

// Parse + validate a record file's content. Returns null on anything invalid —
// a corrupt record must damage exactly one conversation, never the whole list
// (same "one bad record can't break the browser" guarantee as parseRecord's
// siblings across the codebase).
export function parseRecord(json: string): ConversationRecord | null {
  let raw: any;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schema !== RECORD_SCHEMA_VERSION) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.provider !== 'string' || !raw.provider) return null;
  // lastActive must be a real, parseable date — it drives every merge decision.
  if (typeof raw.lastActive !== 'string' || Number.isNaN(Date.parse(raw.lastActive))) return null;
  return {
    schema: RECORD_SCHEMA_VERSION,
    id: raw.id,
    provider: raw.provider,
    // Optional string fields default to '' so downstream code never sees undefined.
    projectName: typeof raw.projectName === 'string' ? raw.projectName : '',
    originalPath: typeof raw.originalPath === 'string' ? raw.originalPath : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    lastActive: raw.lastActive,
    device: typeof raw.device === 'string' ? raw.device : '',
    flags: raw.flags && typeof raw.flags === 'object' ? raw.flags : {},
    transcriptRef: typeof raw.transcriptRef === 'string' ? raw.transcriptRef : '',
    // A record with no createdAt is treated as born when it was last active.
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : raw.lastActive,
  };
}

// Parse an ISO string to epoch ms; unparseable → 0 so it always loses a
// "newest wins" comparison rather than throwing.
const ts = (iso: string) => Date.parse(iso) || 0;

// Field-level merge, newest-wins per field group (design §1 healer rule).
// Used by BOTH the live upsert (base=on-disk, incoming=new event data) and the
// conflict-copy healer — one merge function so the two paths can't drift.
export function mergeRecords(a: ConversationRecord, b: ConversationRecord): ConversationRecord {
  // Activity fields travel together: whichever side saw the later turn knows
  // the true lastActive/device (and, for two real titles, the true title).
  const newer = ts(b.lastActive) >= ts(a.lastActive) ? b : a;
  const older = newer === a ? b : a;
  // Flags merge per-key by each flag's own updatedAt — a flag set on an idle
  // device must survive a merge with a busier device's record. We seed from
  // the older side, then let the newer side's flags win ties, then give the
  // older side a second pass so a flag it updated MORE RECENTLY still lands
  // (field-level, not record-level — this is contract item 4).
  const flags: Record<string, FlagState> = { ...older.flags };
  for (const [k, v] of Object.entries(newer.flags)) {
    const prev = flags[k];
    if (!prev || ts(v.updatedAt) >= ts(prev.updatedAt)) flags[k] = v;
  }
  for (const [k, v] of Object.entries(older.flags)) {
    const cur = flags[k];
    if (cur && ts(v.updatedAt) > ts(cur.updatedAt)) flags[k] = v;
  }
  // A real title always beats an empty one (auto-title can lag a turn behind,
  // so the newer side may not yet have a title). Literal 'Untitled' is a
  // legacy placeholder some older clients wrote (see PITFALLS → Resume
  // Browser) — it must never shadow a real title either. Two real titles →
  // newer wins, which falls out naturally because `newer` is checked first.
  // The trailing fallbacks keep *something* when both sides are placeholders
  // (harmless — the renderer treats '' and 'Untitled' alike as untitled).
  const real = (t: string) => (t && t !== 'Untitled' ? t : '');
  const title = real(newer.title) || real(older.title) || newer.title || older.title;
  return {
    ...newer,
    title,
    flags,
    // createdAt is the conversation's birth — keep the earliest claim.
    createdAt: ts(a.createdAt) <= ts(b.createdAt) ? a.createdAt : b.createdAt,
  };
}

// Engine conflict copies look like '<base> (from <device>, <date>).json'
// (git-transport.ts → guards.ts conflictCopyName inserts the suffix BEFORE the
// extension). The healer folds them back into the canonical record and deletes
// them. `[^)]+` in the middle matches both the real ISO date ('2026-07-03') and
// any other device/date shape, so the regex tracks the real producer.
const CONFLICT_RE = /^(.+) \(from [^)]+\)\.json$/;

export function isConflictCopyName(fileName: string): boolean {
  return CONFLICT_RE.test(fileName);
}

// Recover the canonical filename a conflict copy belongs to, or null if the
// name isn't a conflict copy at all.
export function extractConflictBase(fileName: string): string | null {
  const m = CONFLICT_RE.exec(fileName);
  return m ? `${m[1]}.json` : null;
}

// Fold every conflict copy of a conversation back into its canonical record.
// Because mergeRecords is field-level newest-wins (associative for these
// fields), the result is independent of the order the copies are folded in.
export function foldConflictCopies(
  canonical: ConversationRecord,
  copies: ConversationRecord[],
): ConversationRecord {
  return copies.reduce((acc, c) => mergeRecords(acc, c), canonical);
}
