// Tests for the IO SHELL of the Conversation Store (Phase 2a design §1).
// Uses REAL temp dirs (fs.mkdtempSync) — no memfs, no fs mocking — because the
// whole point of this module is real disk behavior: on-demand dir creation,
// locked read-modify-write, and heal-on-read that DELETES conflict-copy files.
// The pure record logic it sits on top of is tested separately in
// conversation-store-core.test.ts.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  createConversationStore,
  type ConversationStore,
} from '../src/main/conversations/conversation-store';
import {
  RECORD_SCHEMA_VERSION,
  type ConversationRecord,
} from '../src/main/conversations/store-core';

// Build a valid record JSON string, overriding only the fields a test cares
// about. Keeps each test focused on the one behavior it pins.
function recJson(over: Partial<ConversationRecord> = {}): string {
  const base: ConversationRecord = {
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
  return JSON.stringify(base, null, 2);
}

// Write a raw file directly into a provider dir, bypassing the store — used to
// stage on-disk state (canonical records, conflict copies, garbage) before a
// read/heal path runs.
function stage(root: string, provider: string, fileName: string, content: string): void {
  const dir = path.join(root, provider);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, fileName), content);
}

const EPOCH = '1970-01-01T00:00:00.000Z';

let tmp: string;
let store: ConversationStore;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-conv-'));
  store = createConversationStore(tmp);
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('createConversationStore', () => {
  // Contract 1: upsert on a MISSING record creates <root>/claude/<id>.json with
  // schema 1, returns the written record, and creates the provider dir on demand.
  it('upsert creates the record file (and provider dir) on demand', async () => {
    const written = await store.upsert({
      id: 'sess-1',
      provider: 'claude',
      title: 'First',
      lastActive: '2026-07-03T10:00:00.000Z',
      device: 'Laptop',
    });

    const file = path.join(tmp, 'claude', 'sess-1.json');
    expect(fs.existsSync(file)).toBe(true); // dir + file created on demand
    expect(written.schema).toBe(RECORD_SCHEMA_VERSION);
    expect(written.id).toBe('sess-1');
    expect(written.title).toBe('First');
    expect(written.lastActive).toBe('2026-07-03T10:00:00.000Z');

    // The returned record matches what actually landed on disk.
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(onDisk).toEqual(written);
  });

  // Contract 2: upsert on an EXISTING record merges via mergeRecords — a partial
  // with a newer lastActive updates activity fields while preserving flags.
  it('upsert merges into an existing record (newer activity wins, flags kept)', async () => {
    // Seed a base record that already carries a flag.
    stage(tmp, 'claude', 'sess-1.json', recJson({
      id: 'sess-1',
      title: 'Old title',
      lastActive: '2026-07-03T10:00:00.000Z',
      device: 'Laptop',
      flags: { pinned: { value: true, updatedAt: '2026-07-03T09:00:00.000Z' } },
    }));

    const merged = await store.upsert({
      id: 'sess-1',
      provider: 'claude',
      lastActive: '2026-07-03T12:00:00.000Z', // newer turn
      device: 'Phone',
    });

    // Activity fields advanced to the newer turn...
    expect(merged.lastActive).toBe('2026-07-03T12:00:00.000Z');
    expect(merged.device).toBe('Phone');
    // ...the flag set on the older record survived the merge...
    expect(merged.flags.pinned).toEqual({ value: true, updatedAt: '2026-07-03T09:00:00.000Z' });
    // ...and the metadata-only partial did NOT blank the existing title.
    expect(merged.title).toBe('Old title');
  });

  // Contract 3: get returns null for missing AND corrupt files, and a read must
  // NEVER delete the corrupt file (data isn't ours to throw away).
  it('get returns null for missing files', async () => {
    expect(await store.get('claude', 'nope')).toBeNull();
  });

  it('get returns null for a corrupt file and leaves it in place', async () => {
    stage(tmp, 'claude', 'sess-1.json', 'this is not json at all {{{');
    expect(await store.get('claude', 'sess-1')).toBeNull();
    // The garbage file is untouched — a read never deletes.
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1.json'))).toBe(true);
  });

  // Contract 4: list returns every VALID record; corrupt files are skipped
  // silently so one bad record can't break the whole listing.
  it('list returns valid records and skips corrupt ones', async () => {
    stage(tmp, 'claude', 'a.json', recJson({ id: 'a' }));
    stage(tmp, 'claude', 'b.json', recJson({ id: 'b' }));
    stage(tmp, 'claude', 'c.json', 'garbage-not-json');

    const list = await store.list('claude');
    const ids = list.map((r) => r.id).sort();
    expect(ids).toEqual(['a', 'b']); // 'c' skipped, but a+b still returned
  });

  it('list returns [] for a provider dir that does not exist', async () => {
    expect(await store.list('gemini')).toEqual([]);
  });

  // Contract 5: HEALER — a canonical file plus a conflict copy carrying a newer
  // flag. get() returns the FOLDED record, rewrites the canonical file with the
  // fold, and DELETES the conflict copy.
  it('heal folds a conflict copy into the canonical record and deletes the copy', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({
      id: 'sess-1',
      lastActive: '2026-07-03T12:00:00.000Z', // canonical has the later turn
      flags: {},
    }));
    // A valid record conflict copy with a NEWER flag than the canonical (none).
    stage(tmp, 'claude', 'sess-1 (from Laptop, 2026-07-03).json', recJson({
      id: 'sess-1',
      lastActive: '2026-07-03T08:00:00.000Z', // older activity, must lose
      flags: { complete: { value: true, updatedAt: '2026-07-03T13:00:00.000Z' } },
    }));

    const folded = await store.get('claude', 'sess-1');
    expect(folded).not.toBeNull();
    // The fold picked the flag from the copy AND kept the canonical's later turn.
    expect(folded!.flags.complete).toEqual({ value: true, updatedAt: '2026-07-03T13:00:00.000Z' });
    expect(folded!.lastActive).toBe('2026-07-03T12:00:00.000Z');

    // The canonical file on disk now contains the fold...
    const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'claude', 'sess-1.json'), 'utf8'));
    expect(onDisk.flags.complete).toEqual({ value: true, updatedAt: '2026-07-03T13:00:00.000Z' });
    // ...and the conflict copy is gone.
    expect(fs.existsSync(path.join(tmp, 'claude', 'sess-1 (from Laptop, 2026-07-03).json'))).toBe(false);
  });

  // Contract 6: the healer only touches RECORD conflict copies (.json), never a
  // non-record conflict copy, and never reaches into another provider's dir.
  it('heal ignores non-record conflict copies and never crosses providers', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({ id: 'sess-1', flags: {} }));
    // A conflict copy that is NOT a record file (different extension) — must be
    // left alone.
    stage(tmp, 'claude', 'notes (from Laptop, 2026-07-03).txt', 'just some notes');
    // A same-named conflict copy under a DIFFERENT provider — must not be
    // pulled into claude's heal.
    stage(tmp, 'gemini', 'sess-1 (from Laptop, 2026-07-03).json', recJson({
      id: 'sess-1',
      provider: 'gemini',
      flags: { complete: { value: true, updatedAt: '2026-07-03T13:00:00.000Z' } },
    }));

    await store.get('claude', 'sess-1');

    // The .txt conflict copy is untouched.
    expect(fs.existsSync(path.join(tmp, 'claude', 'notes (from Laptop, 2026-07-03).txt'))).toBe(true);
    // The gemini conflict copy was never healed away (different provider dir).
    expect(fs.existsSync(path.join(tmp, 'gemini', 'sess-1 (from Laptop, 2026-07-03).json'))).toBe(true);
    // claude's canonical picked up NOTHING from gemini's copy.
    const claudeRec = JSON.parse(fs.readFileSync(path.join(tmp, 'claude', 'sess-1.json'), 'utf8'));
    expect(claudeRec.flags.complete).toBeUndefined();
  });

  // Contract 7: setFlag on a MISSING record seeds a flag-only record — empty
  // title, lastActive = EPOCH sentinel (so it never outranks real activity in a
  // later merge) — and sets the flag with a fresh updatedAt.
  it('setFlag creates a flag-only seed record when missing', async () => {
    const before = Date.now();
    await store.setFlag('claude', 'sess-9', 'complete', true);
    const after = Date.now();

    const rec = await store.get('claude', 'sess-9');
    expect(rec).not.toBeNull();
    expect(rec!.title).toBe('');            // flag-only seed: no title
    expect(rec!.lastActive).toBe(EPOCH);    // epoch sentinel: loses every real-activity merge
    expect(rec!.flags.complete.value).toBe(true);
    // updatedAt is a fresh timestamp captured at setFlag time.
    const stampedAt = Date.parse(rec!.flags.complete.updatedAt);
    expect(stampedAt).toBeGreaterThanOrEqual(before);
    expect(stampedAt).toBeLessThanOrEqual(after);
  });

  it('setFlag updates a flag on an existing record without touching activity', async () => {
    stage(tmp, 'claude', 'sess-1.json', recJson({
      id: 'sess-1',
      title: 'Keep me',
      lastActive: '2026-07-03T10:00:00.000Z',
    }));
    await store.setFlag('claude', 'sess-1', 'archived', true);

    const rec = await store.get('claude', 'sess-1');
    expect(rec!.flags.archived.value).toBe(true);
    expect(rec!.title).toBe('Keep me');                       // untouched
    expect(rec!.lastActive).toBe('2026-07-03T10:00:00.000Z'); // untouched
  });

  // Contract 8: two concurrent upserts to the SAME id both land — the final
  // record contains the union of both. Without the lock, both would read a
  // missing file, both create, and the second rename would clobber the first
  // (lost update). The union proves mutateFileUnderLock serialized them.
  it('concurrent upserts to the same id both land (no lost update)', async () => {
    await Promise.all([
      store.upsert({
        id: 'sess-1',
        provider: 'claude',
        title: 'Titled',
        lastActive: '2026-07-03T10:00:00.000Z',
      }),
      store.upsert({
        id: 'sess-1',
        provider: 'claude',
        device: 'DeviceB',
        lastActive: '2026-07-03T11:00:00.000Z',
      }),
    ]);

    const rec = await store.get('claude', 'sess-1');
    expect(rec).not.toBeNull();
    // Both the title from one upsert AND the device from the other survived,
    // regardless of which write won the lock first.
    expect(rec!.title).toBe('Titled');
    expect(rec!.device).toBe('DeviceB');
  });
});
