// IO shell for Conversation Store records (Phase 2a design §1). All disk access
// for records lives HERE; every DECISION (what a merge resolves to, what a
// conflict copy folds to) lives in store-core.ts (pure). This is the same
// pure-core / IO-shell split used by local-theme-synthesizer.ts.
//
// Records are one-file-per-conversation so the sync engine's generic
// conflict-copy policy stays out of our way (design decision 6) — and the
// healer below cleans up the rare record-level conflict copies it does produce.
import fs from 'node:fs';
import path from 'node:path';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import {
  ConversationRecord,
  RECORD_SCHEMA_VERSION,
  parseRecord,
  mergeRecords,
  isConflictCopyName,
  extractConflictBase,
  foldConflictCopies,
  FlagState,
} from './store-core';

export interface ConversationStore {
  upsert(partial: UpsertInput): Promise<ConversationRecord>;
  get(provider: string, id: string): Promise<ConversationRecord | null>;
  list(provider: string): Promise<ConversationRecord[]>;
  setFlag(provider: string, id: string, flag: string, value: boolean): Promise<void>;
  setTitle(provider: string, id: string, title: string): Promise<void>;
  root(): string;
}

// The activity/metadata fields a caller can supply. `lastActive` is the ONLY
// field that drives merge outcome — omit it for metadata-only upserts (flag /
// title seeds) so they never masquerade as fresh activity.
export interface UpsertInput {
  id: string;
  provider: string;
  projectName?: string;
  originalPath?: string;
  title?: string;
  lastActive?: string;   // ISO — REQUIRED for activity updates; omitted for metadata-only
  device?: string;
  transcriptRef?: string;
}

// Epoch sentinel for lastActive on metadata-only seeds. Date.parse maps it to 0,
// so a seed always LOSES a "newest wins" merge against any real turn — a flag
// set before the first turn can never fabricate activity that outranks it.
const EPOCH = '1970-01-01T00:00:00.000Z';

export function createConversationStore(conversationsRoot: string): ConversationStore {
  // <root>/<provider>/<id>.json — one file per conversation, grouped by provider.
  const recordPath = (provider: string, id: string) =>
    path.join(conversationsRoot, provider, `${id}.json`);

  // Build a full record from a partial. Missing string fields default to '' so
  // a record on disk never carries undefined. `lastActive` defaults to EPOCH
  // (see above) so metadata-only partials don't outrank real activity, and
  // `createdAt` is anchored to the supplied activity when present, else "now"
  // (a fresh conversation is born when we first see it).
  function toRecord(p: UpsertInput): ConversationRecord {
    const la = p.lastActive ?? EPOCH;
    return {
      schema: RECORD_SCHEMA_VERSION,
      id: p.id,
      provider: p.provider,
      projectName: p.projectName ?? '',
      originalPath: p.originalPath ?? '',
      title: p.title ?? '',
      lastActive: la,
      device: p.device ?? '',
      flags: {},
      transcriptRef: p.transcriptRef ?? '',
      createdAt: p.lastActive ?? new Date().toISOString(),
    };
  }

  // Read-modify-write one record file atomically. The callback sees the parsed
  // on-disk record (null when absent) and returns the record to persist.
  //
  // mutateFileUnderLock gives read-modify-write atomicity under a mkdir lock:
  // the dev instance and the built app both point at the same ~/YouCoded, so
  // cross-process interleaving is a NORMAL state (same reasoning as the artifact
  // central index — a read-outside-then-write loses updates).
  async function mutateRecord(
    provider: string,
    id: string,
    fn: (onDisk: ConversationRecord | null) => ConversationRecord,
  ): Promise<ConversationRecord> {
    const target = recordPath(provider, id);
    // mutateFileUnderLock also mkdirs the parent, but doing it here keeps the
    // "provider dir created on demand" guarantee obvious at the call site.
    fs.mkdirSync(path.dirname(target), { recursive: true });
    let result: ConversationRecord | undefined;
    // The mutate callback is SYNCHRONOUS (see cas-write.ts) — we compute the
    // next record and stringify it in one shot; the lock is held across the
    // whole read+compute+write.
    const committed = await mutateFileUnderLock(target, (onDisk) => {
      const existing = onDisk ? parseRecord(onDisk) : null;
      result = fn(existing);
      return JSON.stringify(result, null, 2);
    });
    // Deviation from the plan: guard the lock-timeout case. mutateFileUnderLock
    // returns false (and skips the write) when it can't acquire the lock within
    // its timeout; the plan's `result!` would then hand back `undefined` typed
    // as a record. Throwing surfaces the rare contention failure instead of
    // silently returning a bogus record.
    if (!committed || !result) {
      throw new Error(`conversation-store: could not write ${provider}/${id} (lock timeout)`);
    }
    return result;
  }

  // Heal engine conflict copies for ONE record id: fold them field-level into
  // the canonical record, rewrite the canonical, delete the copies. Runs
  // opportunistically on the read paths (get/list) and before an upsert.
  async function heal(provider: string, id: string): Promise<void> {
    const dir = path.join(conversationsRoot, provider);
    let names: string[];
    // The provider dir may not exist yet — nothing to heal.
    try { names = fs.readdirSync(dir); } catch { return; }
    // Only conflict copies whose canonical base is exactly this id's file.
    // extractConflictBase runs to the LAST ')' before .json (device names may
    // contain ')'), so this correctly scopes to <id>.json copies only.
    const copies = names.filter(
      (n) => isConflictCopyName(n) && extractConflictBase(n) === `${id}.json`,
    );
    if (copies.length === 0) return;
    // Parse the copies; a copy that won't parse (or whose id doesn't match) is
    // dropped from the fold but STILL deleted below — it carries nothing and
    // would otherwise re-trigger healing on every read forever.
    const parsed = copies
      .map((n) => {
        try { return parseRecord(fs.readFileSync(path.join(dir, n), 'utf8')); }
        catch { return null; }
      })
      .filter((r): r is ConversationRecord => !!r && r.id === id);
    if (parsed.length > 0) {
      await mutateRecord(provider, id, (existing) =>
        // With a canonical on disk: fold ALL copies into it. Without one (only
        // conflict copies exist): seed from the first copy and fold the rest.
        // foldConflictCopies picks each field over its ORIGINAL inputs, so the
        // result is independent of directory enumeration order.
        foldConflictCopies(existing ?? parsed[0], existing ? parsed : parsed.slice(1)));
    }
    // Delete every copy we scanned (parseable or not). The try/catch tolerates a
    // concurrent list()/heal() in another window having already unlinked it.
    for (const n of copies) {
      try { fs.unlinkSync(path.join(dir, n)); } catch { /* already gone */ }
    }
  }

  return {
    root: () => conversationsRoot,

    async upsert(partial) {
      // Fold away any conflict copies first so we merge into the true canonical.
      await heal(partial.provider, partial.id);
      const incoming = toRecord(partial);
      return mutateRecord(partial.provider, partial.id, (existing) => {
        if (!existing) return incoming;
        // Metadata-only partials must NOT blank real fields: overlay ONLY the
        // fields the caller actually provided onto the existing record, then
        // field-merge. lastActive always comes from `incoming` (EPOCH when the
        // caller omitted it) so mergeRecords ranks activity correctly.
        const overlay: ConversationRecord = {
          ...existing,
          ...(partial.projectName !== undefined && { projectName: partial.projectName }),
          ...(partial.originalPath !== undefined && { originalPath: partial.originalPath }),
          ...(partial.title !== undefined && { title: partial.title }),
          ...(partial.device !== undefined && { device: partial.device }),
          ...(partial.transcriptRef !== undefined && { transcriptRef: partial.transcriptRef }),
          lastActive: incoming.lastActive,
        };
        return mergeRecords(existing, overlay);
      });
    },

    async get(provider, id) {
      // Heal-on-read: any conflict copies for this id are folded in before we
      // return, so callers always see the converged record.
      await heal(provider, id);
      try {
        return parseRecord(fs.readFileSync(recordPath(provider, id), 'utf8'));
      } catch {
        // Missing file → null. (A corrupt file is handled by parseRecord
        // returning null above; either way we never delete on a read.)
        return null;
      }
    },

    async list(provider) {
      const dir = path.join(conversationsRoot, provider);
      let names: string[];
      // No provider dir → no conversations.
      try { names = fs.readdirSync(dir); } catch { return []; }
      // Heal any conflict copies found in this listing pass, then read clean.
      for (const n of names) {
        if (isConflictCopyName(n)) {
          const base = extractConflictBase(n);
          // Only .json conflict copies map back to a record id; a non-record
          // copy ('notes (from X).txt') yields a base that isn't ours and heal
          // finds no matching copies, so it's a no-op — but we still gate on the
          // .json base to avoid pointless heal calls.
          if (base && base.endsWith('.json')) {
            await heal(provider, base.replace(/\.json$/, ''));
          }
        }
      }
      const out: ConversationRecord[] = [];
      // Re-read the dir: heal may have deleted conflict copies above.
      for (const n of fs.readdirSync(dir)) {
        if (!n.endsWith('.json') || isConflictCopyName(n)) continue;
        try {
          const r = parseRecord(fs.readFileSync(path.join(dir, n), 'utf8'));
          // A corrupt record damages exactly ONE conversation, never the list.
          if (r) out.push(r);
        } catch { /* unreadable file — skip */ }
      }
      return out;
    },

    async setFlag(provider, id, flag, value) {
      await mutateRecord(provider, id, (existing) => {
        // Seed a flag-only record when the conversation isn't on disk yet — a
        // flag can legitimately be set before the first turn is recorded.
        const base = existing ?? toRecord({ id, provider });
        const flags: Record<string, FlagState> = {
          ...base.flags,
          // Fresh updatedAt so this flag wins any future merge against an older
          // value for the same key.
          [flag]: { value, updatedAt: new Date().toISOString() },
        };
        return { ...base, flags };
      });
    },

    async setTitle(provider, id, title) {
      // Empty title is a no-op — never overwrite a real name with nothing, and
      // never seed an empty-titled record just to store "".
      if (!title) return;
      await mutateRecord(provider, id, (existing) => {
        const base = existing ?? toRecord({ id, provider });
        return { ...base, title };
      });
    },
  };
}
