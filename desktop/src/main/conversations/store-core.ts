// PURE record logic for the Conversation Store (Phase 2a design §1).
// No fs/path/os imports — the IO shell (conversation-store.ts) does disk work.
// This is the same pure-core/IO-shell split as local-theme-synthesizer.ts:
// keeping this file free of side effects is what lets us unit-test every merge
// and parse rule with plain objects and no mocks.
import type { SessionProvider, PortableModelRef } from '../../shared/types';
// Task 5: PortableModelRef now LIVES in shared/types.ts (PastSession needs it
// too, and shared/ must never import from main/ — see the type's own comment
// there). Re-exported here so this module's existing importers
// (conversation-store.ts, service.ts, portable-model.ts, ipc-handlers.ts) keep
// working against './store-core' unchanged.
export type { PortableModelRef };

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
  note: string;                  // user freeform note; '' means none
  noteUpdatedAt: string;         // ISO — own timestamp for independent merge
  lastUsedModel?: PortableModelRef; // portable — see PortableModelRef; absent until a turn runs
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

// Whitelist parse for lastUsedModel: keep it ONLY when every field is a
// non-empty string, else drop the FIELD (never the whole record) — same
// per-field damage containment as sanitizeFlags. A partially-shaped ref would
// crash the resume selector's `.modelId` read; portable-by-design also means
// this must never carry the device-local providerId ULID through (see
// PortableModelRef) — a caller that accidentally passes one still round-trips
// as a plain string here, but the shape check alone can't catch that; the WHY
// lives at the write side (service.ts noteModelUsed / conversation-store.ts).
function sanitizeModelRef(raw: unknown): PortableModelRef | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<Record<keyof PortableModelRef, unknown>>;
  if (
    typeof r.modelId === 'string' && r.modelId &&
    typeof r.providerType === 'string' && r.providerType &&
    typeof r.providerLabel === 'string' && r.providerLabel
  ) {
    return { modelId: r.modelId, providerType: r.providerType, providerLabel: r.providerLabel };
  }
  return undefined;
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
  const lastUsedModel = sanitizeModelRef(raw.lastUsedModel);
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
    note: typeof raw.note === 'string' ? raw.note : '',
    // Absent/corrupt noteUpdatedAt → createdAt, so an old record never claims a
    // note edit it didn't make.
    noteUpdatedAt:
      typeof raw.noteUpdatedAt === 'string' && !Number.isNaN(Date.parse(raw.noteUpdatedAt))
        ? raw.noteUpdatedAt
        : (typeof raw.createdAt === 'string' && !Number.isNaN(Date.parse(raw.createdAt))
            ? raw.createdAt : raw.lastActive),
    // Conditional spread: an absent/invalid lastUsedModel must leave the key
    // OFF the parsed object entirely (not `undefined`), so a plain `toEqual`
    // against a source record that never had the field still round-trips.
    ...(lastUsedModel ? { lastUsedModel } : {}),
  };
}

// Parse an ISO string to epoch ms; unparseable → 0 so it always loses a
// "newest wins" comparison rather than throwing.
export const ts = (iso: string) => Date.parse(iso) || 0;

// Pick the "later" of two values under a TOTAL order: primary by timestamp,
// exact ties broken by comparing the two values' JSON text lexicographically.
// WHY: convergence requires merge(a,b) === merge(b,a). A positional tiebreak
// ("second argument wins") makes the healer fold depend on directory
// enumeration order — two devices folding the same tied copies would pick
// DIFFERENT winners and ping-pong forever instead of converging. The JSON
// comparison is arbitrary but symmetric and stable across devices, which is
// all a lattice join needs. Max under a total order is commutative AND
// associative, so folds converge regardless of copy order.
// Exported so the project-registry store (cross-device project discovery,
// 2026-07-12) can reuse the same content-tiebroken lattice-join pick for its
// displayName last-writer-wins merge.
export function laterOf<T>(x: T, y: T, tx: number, ty: number): T {
  if (tx !== ty) return tx > ty ? x : y;
  return JSON.stringify(x) >= JSON.stringify(y) ? x : y;
}

// A "real" title is non-empty and not the literal 'Untitled' — that literal
// is a legacy placeholder some older clients wrote (see PITFALLS → Resume
// Browser) and must never shadow an actual name. Shared by the pairwise merge
// and the fold's set-based title pick so the two definitions can't drift.
//
// DO NOT unify this with shared/session-title.ts's isRealSessionName. That one
// also rejects 'New Session' and the 'Resuming…' placeholders, which is right
// for a LIVE session name but wrong here: this predicate decides which title
// wins the cross-device CRDT merge, and widening it changes sync results on
// records that already exist on other devices.
const realTitle = (t: string) => (t && t !== 'Untitled' ? t : '');

// Earliest-claim pick for createdAt, with the same content tiebreak: two
// different spellings of the same instant must resolve identically on every
// device, or merged records never byte-converge.
export function earliestOf(x: string, y: string): string {
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
  // A real title always beats a placeholder (empty / literal 'Untitled' —
  // see realTitle): auto-title can lag a turn behind, so the newer side may
  // not have a name yet. Two real titles → newer wins, which falls out
  // naturally because `newer` is checked first. The trailing fallbacks keep
  // *something* when both sides are placeholders (harmless — the renderer
  // treats '' and 'Untitled' alike as untitled). NOTE: this pairwise rule is
  // a heuristic and is NOT associative — foldConflictCopies compensates with
  // a set-based title pick over its original inputs.
  const title = realTitle(newer.title) || realTitle(older.title) || newer.title || older.title;
  // Note is NOT activity-coupled (unlike title): a note edit on an idle device
  // must not lose to a busier device's newer turn. Pick by noteUpdatedAt alone.
  const notePick = laterOf(
    { v: a.note, at: a.noteUpdatedAt }, { v: b.note, at: b.noteUpdatedAt },
    ts(a.noteUpdatedAt), ts(b.noteUpdatedAt),
  );
  return {
    ...newer,
    title,
    note: notePick.v,
    noteUpdatedAt: notePick.at,
    flags,
    // createdAt is the conversation's birth — keep the earliest claim
    // (content-tiebroken on equal instants, see earliestOf).
    createdAt: earliestOf(a.createdAt, b.createdAt),
    // lastUsedModel travels with activity like title/device (whichever side
    // saw the later turn knows the current model) but a real value must never
    // lose to an absent one — a device that hasn't run since the model was
    // picked shouldn't erase it.
    lastUsedModel: newer.lastUsedModel ?? older.lastUsedModel,
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
// Order-independence strategy: every field group is picked over the ORIGINAL
// inputs, never over mutated intermediates — that's what makes directory
// enumeration order unable to change the healed record.
//  - flags/createdAt: accumulated through the pairwise reduce, which is safe
//    for THEM because those picks are per-key max / earliest-min over values
//    that pass through merges UNCHANGED (max/min under a total order are
//    associative and commutative).
//  - activity/spread fields (lastActive, device, transcriptRef, ...): picked
//    directly as the total-order max of the original inputs. Taking them from
//    the reduce accumulator was subtly order-dependent: the accumulator's
//    title override can shrink its JSON and flip a later exact-lastActive tie
//    comparison inside mergeRecords, healing e.g. a different device per
//    enumeration order.
//  - title: picked over the original inputs that have a REAL (non-placeholder)
//    title — the pairwise title rule is a heuristic that isn't associative
//    (an adopted title rides the accumulator's newest lastActive and beats a
//    newer real title from a later fold step). If no input has a real title,
//    the reduce's placeholder result stands (either placeholder is fine — the
//    renderer treats '' and 'Untitled' alike as untitled).
export function foldConflictCopies(
  canonical: ConversationRecord,
  copies: ConversationRecord[],
): ConversationRecord {
  const inputs = [canonical, ...copies];
  const folded = copies.reduce((acc, c) => mergeRecords(acc, c), canonical);
  // Spread-source: the total-order-max ORIGINAL record supplies every field
  // the pairwise merge would take from its "newer" side.
  const base = inputs.reduce((x, y) => laterOf(x, y, ts(x.lastActive), ts(y.lastActive)));
  const titled = inputs.filter((r) => realTitle(r.title));
  const title =
    titled.length > 0
      ? titled.reduce((x, y) => laterOf(x, y, ts(x.lastActive), ts(y.lastActive))).title
      : folded.title;
  return {
    ...base,
    title,
    flags: folded.flags,
    createdAt: folded.createdAt,
    note: folded.note,
    noteUpdatedAt: folded.noteUpdatedAt,
  };
}
