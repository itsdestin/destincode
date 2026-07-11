// Tests for the PURE Conversation Store record logic (Phase 2a design §1).
// Plain vitest, no mocks — store-core.ts is a pure module (no fs/path/os), so
// every behavior is exercised directly on plain objects/strings.
import { describe, it, expect } from 'vitest';
import {
  RECORD_SCHEMA_VERSION,
  parseRecord,
  mergeRecords,
  isConflictCopyName,
  extractConflictBase,
  foldConflictCopies,
  type ConversationRecord,
  type FlagState,
} from '../src/main/conversations/store-core';

// Small factory so each test states only the fields it cares about — the rest
// default to a valid baseline record.
function rec(over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    schema: RECORD_SCHEMA_VERSION,
    id: 'sess-1',
    provider: 'claude',
    projectName: 'my-app',
    originalPath: '/home/a/my-app',
    title: 'Hello',
    lastActive: '2026-07-03T10:00:00.000Z',
    device: 'Laptop',
    flags: {},
    transcriptRef: 'claude/transcripts/my-app/sess-1.jsonl',
    createdAt: '2026-07-01T09:00:00.000Z',
    ...over,
  };
}

function flag(value: boolean, updatedAt: string): FlagState {
  return { value, updatedAt };
}

describe('parseRecord', () => {
  // Contract 1: a well-formed schema:1 record with all required fields round-trips.
  it('parses valid JSON with schema:1 and all required fields', () => {
    const source = rec();
    const parsed = parseRecord(JSON.stringify(source));
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(source);
  });

  // Contract 2 (three ways to be invalid → null, never throw):
  it('returns null on malformed JSON', () => {
    expect(parseRecord('{ not json')).toBeNull();
    expect(parseRecord('')).toBeNull();
    expect(parseRecord('null')).toBeNull();
    expect(parseRecord('42')).toBeNull();
  });

  it('returns null on wrong schema version', () => {
    const wrong = JSON.stringify({ ...rec(), schema: 2 });
    expect(parseRecord(wrong)).toBeNull();
  });

  it('returns null when id/provider/lastActive is missing or invalid', () => {
    // Missing id
    expect(parseRecord(JSON.stringify({ ...rec(), id: undefined }))).toBeNull();
    expect(parseRecord(JSON.stringify({ ...rec(), id: '' }))).toBeNull();
    // Missing provider
    expect(parseRecord(JSON.stringify({ ...rec(), provider: undefined }))).toBeNull();
    expect(parseRecord(JSON.stringify({ ...rec(), provider: '' }))).toBeNull();
    // Missing / unparseable lastActive
    expect(parseRecord(JSON.stringify({ ...rec(), lastActive: undefined }))).toBeNull();
    expect(parseRecord(JSON.stringify({ ...rec(), lastActive: 'not-a-date' }))).toBeNull();
  });

  it('never throws on arbitrary garbage input', () => {
    expect(() => parseRecord('  ')).not.toThrow();
    expect(() => parseRecord('[1,2,3')).not.toThrow();
  });

  // Flags must round-trip LOSSLESSLY or not at all — a malformed FlagState
  // reaching mergeRecords would corrupt the per-flag updatedAt comparison.
  it('drops malformed flag entries but keeps well-formed ones', () => {
    const parsed = parseRecord(JSON.stringify({
      ...rec(),
      flags: {
        good: { value: true, updatedAt: '2026-07-01T00:00:00.000Z' },
        stringValue: 'yes',                    // not an object
        emptyObject: {},                       // missing both fields
        badValue: { value: 'yes', updatedAt: '2026-07-01T00:00:00.000Z' }, // non-boolean
        badUpdatedAt: { value: true, updatedAt: 42 },                      // non-string
      },
    }));
    expect(parsed).not.toBeNull();
    expect(parsed!.flags).toEqual({
      good: { value: true, updatedAt: '2026-07-01T00:00:00.000Z' },
    });
  });

  it('normalizes a non-record flags shape (array) to {}', () => {
    // Arrays are typeof 'object' — a naive object check would let one through.
    const parsed = parseRecord(JSON.stringify({ ...rec(), flags: [1, 2, 3] }));
    expect(parsed).not.toBeNull();
    expect(parsed!.flags).toEqual({});
  });

  // createdAt hygiene: garbage would parse to epoch 0 and then win every
  // "earliest claim" comparison in mergeRecords — so it must never survive parse.
  it('falls back to lastActive when createdAt is corrupt', () => {
    const parsed = parseRecord(JSON.stringify({ ...rec(), createdAt: 'not-a-date' }));
    expect(parsed).not.toBeNull();
    expect(parsed!.createdAt).toBe(rec().lastActive);
  });

  it('defaults createdAt to lastActive when absent', () => {
    const parsed = parseRecord(JSON.stringify({ ...rec(), createdAt: undefined }));
    expect(parsed).not.toBeNull();
    expect(parsed!.createdAt).toBe(rec().lastActive);
  });
});

describe('mergeRecords', () => {
  // Contract 3: incoming NEWER → activity fields (lastActive/device/title) from
  // incoming; createdAt keeps the OLDER of the two; flags merge per-flag newest-wins.
  it('takes activity fields from the newer side and keeps the older createdAt', () => {
    const base = rec({
      lastActive: '2026-07-03T10:00:00.000Z',
      device: 'Laptop',
      title: 'Old title',
      createdAt: '2026-07-01T00:00:00.000Z',
      flags: { pinned: flag(true, '2026-07-02T00:00:00.000Z') },
    });
    const incoming = rec({
      lastActive: '2026-07-04T10:00:00.000Z', // newer
      device: 'Desktop',
      title: 'New title',
      createdAt: '2026-07-05T00:00:00.000Z', // later birth claim — should NOT win
      flags: { pinned: flag(false, '2026-07-06T00:00:00.000Z') }, // newer flag
    });
    const merged = mergeRecords(base, incoming);
    expect(merged.lastActive).toBe('2026-07-04T10:00:00.000Z');
    expect(merged.device).toBe('Desktop');
    expect(merged.title).toBe('New title');
    // createdAt keeps the EARLIER of the two, not the newer side's value.
    expect(merged.createdAt).toBe('2026-07-01T00:00:00.000Z');
    // Flag merged per-flag by updatedAt (incoming's is newer).
    expect(merged.flags.pinned).toEqual(flag(false, '2026-07-06T00:00:00.000Z'));
  });

  // Contract 4: incoming OLDER → base's activity fields win, but incoming's
  // newer individual flags STILL land (field-level, not record-level).
  it('lets an older record still contribute its newer individual flags', () => {
    const base = rec({
      lastActive: '2026-07-10T10:00:00.000Z', // newer overall
      device: 'Laptop',
      title: 'Base title',
      flags: { archived: flag(false, '2026-07-01T00:00:00.000Z') },
    });
    const incoming = rec({
      lastActive: '2026-07-02T10:00:00.000Z', // older overall
      device: 'Phone',
      title: 'Incoming title',
      // This flag was updated AFTER base's copy of it — must survive the merge.
      flags: { archived: flag(true, '2026-07-09T00:00:00.000Z') },
    });
    const merged = mergeRecords(base, incoming);
    // Activity fields come from the newer (base) side.
    expect(merged.lastActive).toBe('2026-07-10T10:00:00.000Z');
    expect(merged.device).toBe('Laptop');
    expect(merged.title).toBe('Base title');
    // But the older record's newer flag still lands.
    expect(merged.flags.archived).toEqual(flag(true, '2026-07-09T00:00:00.000Z'));
  });

  it('merges disjoint flag keys from both sides', () => {
    const base = rec({ flags: { a: flag(true, '2026-07-01T00:00:00.000Z') } });
    const incoming = rec({ flags: { b: flag(true, '2026-07-02T00:00:00.000Z') } });
    const merged = mergeRecords(base, incoming);
    expect(merged.flags.a).toEqual(flag(true, '2026-07-01T00:00:00.000Z'));
    expect(merged.flags.b).toEqual(flag(true, '2026-07-02T00:00:00.000Z'));
  });

  // Contract 5: title precedence — non-empty always beats empty/'Untitled'
  // regardless of age; two non-empty → newest lastActive side wins.
  it('lets a real title beat an empty title even when the empty side is newer', () => {
    const base = rec({ lastActive: '2026-07-01T00:00:00.000Z', title: 'Real title' });
    const incoming = rec({ lastActive: '2026-07-09T00:00:00.000Z', title: '' });
    // incoming is newer but has no title — the real title must survive.
    expect(mergeRecords(base, incoming).title).toBe('Real title');
    // Order-independent.
    expect(mergeRecords(incoming, base).title).toBe('Real title');
  });

  // Contract 5 (continued): the literal 'Untitled' is a legacy placeholder
  // (PITFALLS → Resume Browser: older clients wrote it into topic files) — it
  // must never shadow a real title, in either direction, regardless of age.
  it("lets a real title beat a literal 'Untitled' even when the placeholder side is newer", () => {
    const older = rec({ lastActive: '2026-07-01T00:00:00.000Z', title: 'Real title' });
    const newer = rec({ lastActive: '2026-07-09T00:00:00.000Z', title: 'Untitled' });
    // (a) older side's real title beats newer side's 'Untitled'.
    expect(mergeRecords(older, newer).title).toBe('Real title');
    expect(mergeRecords(newer, older).title).toBe('Real title');
  });

  it("lets a newer real title beat an older 'Untitled'", () => {
    const older = rec({ lastActive: '2026-07-01T00:00:00.000Z', title: 'Untitled' });
    const newer = rec({ lastActive: '2026-07-09T00:00:00.000Z', title: 'Real title' });
    // (b) newer real title beats older 'Untitled'.
    expect(mergeRecords(older, newer).title).toBe('Real title');
    expect(mergeRecords(newer, older).title).toBe('Real title');
  });

  it('degrades gracefully when both sides are placeholders', () => {
    // (c) both placeholder/empty → no crash; result is one of the placeholders
    // (the renderer treats '' and 'Untitled' alike as untitled, so either is fine).
    const a = rec({ lastActive: '2026-07-01T00:00:00.000Z', title: 'Untitled' });
    const b = rec({ lastActive: '2026-07-09T00:00:00.000Z', title: '' });
    expect(['', 'Untitled']).toContain(mergeRecords(a, b).title);
    expect(['', 'Untitled']).toContain(mergeRecords(b, a).title);
    const c = rec({ title: 'Untitled' });
    expect(['', 'Untitled']).toContain(mergeRecords(c, c).title);
  });

  it('picks the newest side when both titles are non-empty', () => {
    const older = rec({ lastActive: '2026-07-01T00:00:00.000Z', title: 'Older title' });
    const newer = rec({ lastActive: '2026-07-09T00:00:00.000Z', title: 'Newer title' });
    expect(mergeRecords(older, newer).title).toBe('Newer title');
    expect(mergeRecords(newer, older).title).toBe('Newer title');
  });

  // LOAD-BEARING convergence test: two devices merging the same pair must get
  // the SAME result even on an exact lastActive tie. Positional tie-breaking
  // ("second argument wins") makes merge(a,b) !== merge(b,a), and the healer
  // fold becomes directory-enumeration-order dependent — devices ping-pong
  // instead of converging. Ties must break on CONTENT (total order), never on
  // argument position.
  it('is commutative on an exact lastActive tie (content tiebreak)', () => {
    const same = '2026-07-05T12:00:00.000Z';
    const x = rec({
      lastActive: same,
      device: 'Laptop',
      title: 'Title from laptop',
      flags: { pinned: flag(true, same) },
    });
    const y = rec({
      lastActive: same,
      device: 'Desktop',
      title: 'Title from desktop',
      flags: { pinned: flag(false, same) }, // same updatedAt, different value
    });
    expect(mergeRecords(x, y)).toEqual(mergeRecords(y, x));
  });

  it('flag ties on equal updatedAt break by content, not argument order', () => {
    const same = '2026-07-05T12:00:00.000Z';
    const a = rec({ flags: { starred: flag(true, same) } });
    const b = rec({ flags: { starred: flag(false, same) } });
    const ab = mergeRecords(a, b).flags.starred;
    const ba = mergeRecords(b, a).flags.starred;
    expect(ab).toEqual(ba);
  });
});

describe('isConflictCopyName / extractConflictBase', () => {
  // Contract 6: real conflict-copy filenames are detected and the base recovered.
  // The REAL format (git-transport.ts conflictCopyName) uses an ISO date.
  it('detects a real conflict-copy name and extracts its canonical base', () => {
    const real = 'abc123 (from Laptop, 2026-07-03).json';
    expect(isConflictCopyName(real)).toBe(true);
    expect(extractConflictBase(real)).toBe('abc123.json');
  });

  it('also matches the task example date shape', () => {
    const name = 'abc123 (from Laptop, Jul 3).json';
    expect(isConflictCopyName(name)).toBe(true);
    expect(extractConflictBase(name)).toBe('abc123.json');
  });

  // Contract 7: a plain canonical name is NOT a conflict copy.
  it('rejects a plain canonical filename', () => {
    expect(isConflictCopyName('abc123.json')).toBe(false);
    expect(extractConflictBase('abc123.json')).toBeNull();
  });

  // The producer (guards.ts) permits ')' inside device names, so the matcher
  // must run greedily to the LAST ')' before '.json' — a first-')' stop would
  // truncate on such names and miss the copy entirely.
  it("matches device names containing ')'", () => {
    const tricky = 'abc123 (from foo)bar, 2026-07-03).json';
    expect(isConflictCopyName(tricky)).toBe(true);
    expect(extractConflictBase(tricky)).toBe('abc123.json');
  });
});

describe('foldConflictCopies', () => {
  // Contract 8: folding == successive mergeRecords, and is order-independent —
  // true because each field group is picked as max/min under a TOTAL order
  // (timestamp primary, JSON-content tiebreak). Both orderings must match.
  it('folds copies into the canonical record, order-independently', () => {
    const canonical = rec({
      id: 'sess-1',
      lastActive: '2026-07-03T00:00:00.000Z',
      title: 'Canonical',
      flags: { pinned: flag(true, '2026-07-03T00:00:00.000Z') },
    });
    const copy1 = rec({
      id: 'sess-1',
      lastActive: '2026-07-05T00:00:00.000Z', // newest activity
      device: 'Desktop',
      title: 'Copy One',
      flags: { archived: flag(true, '2026-07-05T00:00:00.000Z') },
    });
    const copy2 = rec({
      id: 'sess-1',
      lastActive: '2026-07-04T00:00:00.000Z',
      device: 'Phone',
      title: 'Copy Two',
      flags: { pinned: flag(false, '2026-07-06T00:00:00.000Z') }, // newest pinned flag
    });

    const forward = foldConflictCopies(canonical, [copy1, copy2]);
    const reversed = foldConflictCopies(canonical, [copy2, copy1]);

    // Both orders converge to the same record (associativity for these fields).
    expect(forward).toEqual(reversed);
    // And the fold matches successive pairwise merges.
    const manual = mergeRecords(mergeRecords(canonical, copy1), copy2);
    expect(forward).toEqual(manual);
    // Sanity on the winning fields: newest activity from copy1, newest flags win.
    expect(forward.lastActive).toBe('2026-07-05T00:00:00.000Z');
    expect(forward.device).toBe('Desktop');
    expect(forward.flags.pinned).toEqual(flag(false, '2026-07-06T00:00:00.000Z'));
    expect(forward.flags.archived).toEqual(flag(true, '2026-07-05T00:00:00.000Z'));
  });

  it('returns the canonical record unchanged when there are no copies', () => {
    const canonical = rec();
    expect(foldConflictCopies(canonical, [])).toEqual(canonical);
  });

  // Convergence under ties: when canonical and every copy share ONE lastActive
  // (a real shape — two devices ran the same last turn's clock second), the
  // fold must still be enumeration-order independent, which requires the
  // content-based total-order tiebreak inside mergeRecords.
  it('is order-independent even when all records tie on lastActive', () => {
    const same = '2026-07-05T12:00:00.000Z';
    const canon = rec({ lastActive: same, device: 'Laptop', title: 'Canon' });
    const x = rec({ lastActive: same, device: 'Desktop', title: 'From desktop' });
    const y = rec({ lastActive: same, device: 'Phone', title: 'From phone' });
    expect(foldConflictCopies(canon, [x, y])).toEqual(foldConflictCopies(canon, [y, x]));
  });
});
