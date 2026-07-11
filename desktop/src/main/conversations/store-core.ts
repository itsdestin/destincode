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

// Keep only well-formed FlagState entries. A malformed flag (string value,
// missing updatedAt) would corrupt mergeRecords' per-flag newest-wins
// comparison downstream, so it's dropped at the door instead of round-tripped
// — "flags migrate losslessly" only holds for flags that ARE FlagStates.
// Arrays are typeof 'object' too, so they're explicitly normalized to {}.
function sanitizeFlags(raw: unknown): Record<string, FlagState> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, FlagState> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = v as FlagState | null;
    if (f && typeof f === 'object' && typeof f.value === 'boolean' && typeof f.updatedAt === 'string') {
      out[k] = { value: f.value, updatedAt: f.updatedAt };
    }
  }
  return out;
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
    flags: sanitizeFlags(raw.flags),
    transcriptRef: typeof raw.transcriptRef === 'string' ? raw.transcriptRef : '',
    // A record with a missing OR unparseable createdAt is treated as born when
    // it was last active. Corrupt strings must not survive: Date.parse(garbage)
    // is NaN → ts() maps it to 0 → it would WIN every "earliest claim wins"
    // comparison in mergeRecords and poison the merged createdAt forever.
    createdAt:
      typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
        ? raw.createdAt
        : raw.lastActive,
  };
}

// Parse an ISO string to epoch ms; unparseable → 0 so it always loses a
// "newest wins" comparison rather than throwing.
const ts = (iso: string) => Date.parse(iso) || 0;

// Pick the "later" of two values under a TOTAL order: primary by timestamp,
// exact ties broken by comparing the two values' JSON text lexicographically.
// WHY: convergence requires merge(a,b) === merge(b,a). A positional tiebreak
// ("second argument wins") makes the healer fold depend on directory
// enumeration order — two devices folding the same tied copies would pick
// DIFFERENT winners and ping-pong forever instead of converging. The JSON
// comparison is arbitrary but symmetric and stable across devices, which is
// all a lattice join needs. Max under a total order is commutative AND
// associative, so folds converge regardless of copy order.
function laterOf<T>(x: T, y: T, tx: number, ty: number): T {
  if (tx !== ty) return tx > ty ? x : y;
  return JSON.stringify(x) >= JSON.stringify(y) ? x : y;
}

// Earliest-claim pick for createdAt, with the same content tiebreak: two
// different spellings of the same instant must resolve identically on every
// device, or merged records never byte-converge.
function earliestOf(x: string, y: string): string {
  const tx = ts(x);
  const ty = ts(y);
  if (tx !== ty) return tx < ty ? x : y;
  return x <= y ? x : y;
}

// Field-level merge, newest-wins per field group (design §1 healer rule).
// Used by BOTH the live upsert (base=on-disk, incoming=new event data) and the
// conflict-copy healer — one merge function so the two paths can't drift.
export function mergeRecords(a: ConversationRecord, b: ConversationRecord): ConversationRecord {
  // Activity fields travel together: whichever side saw the later turn knows
  // the true lastActive/device (and, for two real titles, the true title).
  // Exact lastActive ties break on record CONTENT via laterOf — never on
  // argument position — so merge(a,b) === merge(b,a).
  const newer = laterOf(a, b, ts(a.lastActive), ts(b.lastActive));
  const older = newer === a ? b : a;
  // Flags merge per-key by each flag's own updatedAt — a flag set on an idle
  // device must survive a merge with a busier device's record (field-level,
  // not record-level — this is contract item 4). Equal-updatedAt ties break
  // by flag content, same convergence reason as above. Keys are sorted so the
  // merged object's key order is identical no matter which argument came
  // first — downstream serialization then byte-converges too.
  const flags: Record<string, FlagState> = {};
  const flagKeys = [...new Set([...Object.keys(a.flags), ...Object.keys(b.flags)])].sort();
  for (const k of flagKeys) {
    const fa = a.flags[k];
    const fb = b.flags[k];
    flags[k] = fa && fb ? laterOf(fa, fb, ts(fa.updatedAt), ts(fb.updatedAt)) : (fa ?? fb);
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
    // createdAt is the conversation's birth — keep the earliest claim
    // (content-tiebroken on equal instants, see earliestOf).
    createdAt: earliestOf(a.createdAt, b.createdAt),
  };
}

// Engine conflict copies look like '<base> (from <device>, <date>).json'
// (git-transport.ts → guards.ts conflictCopyName inserts the suffix BEFORE the
// extension; the date is ISO, e.g. '2026-07-03'). The healer folds them back
// into the canonical record and deletes them. The inner matcher is a GREEDY
// `.+` — it runs to the LAST ')' before '.json' — because the producer's name
// validation permits ')' inside device names; a first-')' stop ([^)]+) would
// fail to match such names and the copy would silently never be healed.
const CONFLICT_RE = /^(.+) \(from .+\)\.json$/;

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
// The result is independent of the order the copies are folded in BECAUSE
// mergeRecords picks each field group as the max/min under a total order
// (timestamp primary, JSON-content tiebreak — see laterOf). Without the
// content tiebreak, exact-timestamp ties would resolve by fold position and
// two devices enumerating the same copies in different directory orders would
// heal to different records.
export function foldConflictCopies(
  canonical: ConversationRecord,
  copies: ConversationRecord[],
): ConversationRecord {
  return copies.reduce((acc, c) => mergeRecords(acc, c), canonical);
}
