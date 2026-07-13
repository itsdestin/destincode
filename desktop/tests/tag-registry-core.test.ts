// tests/tag-registry-core.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseTag, mergeTag, foldTagConflicts, normalizeLabel,
  StoredTag, TAG_SCHEMA_VERSION,
} from '../src/main/conversations/tag-registry-core';

function tag(over: Partial<StoredTag> = {}): StoredTag {
  const t = '2026-07-13T00:00:00.000Z';
  return {
    schema: TAG_SCHEMA_VERSION, id: 'tag_a', label: 'Auth', labelUpdatedAt: t,
    color: 'tag-blue', colorUpdatedAt: t, archived: false, archivedUpdatedAt: t,
    deleted: false, deletedUpdatedAt: t, createdAt: t, ...over,
  };
}

describe('parseTag', () => {
  it('rejects wrong schema / missing id', () => {
    expect(parseTag(JSON.stringify({ ...tag(), schema: 99 }))).toBeNull();
    expect(parseTag(JSON.stringify({ ...tag(), id: '' }))).toBeNull();
    expect(parseTag('not json')).toBeNull();
  });
  it('clamps an unknown color to the default', () => {
    const p = parseTag(JSON.stringify({ ...tag(), color: 'tag-chartreuse' }));
    expect(p?.color).toBe('tag-gray');
  });
});

describe('mergeTag', () => {
  it('picks each field by its own updatedAt (commutative)', () => {
    const a = tag({ label: 'Auth', labelUpdatedAt: '2026-07-13T01:00:00.000Z' });
    const b = tag({ color: 'tag-red', colorUpdatedAt: '2026-07-13T02:00:00.000Z' });
    const ab = mergeTag(a, b);
    const ba = mergeTag(b, a);
    expect(ab).toEqual(ba);
    expect(ab.label).toBe('Auth');       // a's later label
    expect(ab.color).toBe('tag-red');    // b's later color
  });
  it('a delete tombstone from an older-overall copy still wins the deleted field', () => {
    const live = tag({ deleted: false, deletedUpdatedAt: '2026-07-13T01:00:00.000Z' });
    const gone = tag({ deleted: true, deletedUpdatedAt: '2026-07-13T03:00:00.000Z',
                       label: 'Old', labelUpdatedAt: '2026-07-12T00:00:00.000Z' });
    expect(mergeTag(live, gone).deleted).toBe(true);
  });
  it('keeps the earliest createdAt', () => {
    const a = tag({ createdAt: '2026-07-13T05:00:00.000Z' });
    const b = tag({ createdAt: '2026-07-10T00:00:00.000Z' });
    expect(mergeTag(a, b).createdAt).toBe('2026-07-10T00:00:00.000Z');
  });
});

describe('normalizeLabel', () => {
  it('lowercases and trims for dedup', () => {
    expect(normalizeLabel('  Auth Rewrite ')).toBe('auth rewrite');
  });
});

describe('foldTagConflicts', () => {
  it('is independent of copy order', () => {
    const base = tag({ label: 'A', labelUpdatedAt: '2026-07-13T01:00:00.000Z' });
    const c1 = tag({ label: 'B', labelUpdatedAt: '2026-07-13T02:00:00.000Z' });
    const c2 = tag({ color: 'tag-green', colorUpdatedAt: '2026-07-13T03:00:00.000Z' });
    expect(foldTagConflicts(base, [c1, c2])).toEqual(foldTagConflicts(base, [c2, c1]));
  });
});
