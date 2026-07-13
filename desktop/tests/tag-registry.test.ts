// tests/tag-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTagRegistry } from '../src/main/conversations/tag-registry';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tagreg-'));
});

describe('createTagRegistry', () => {
  it('creates, lists, updates, and deletes', async () => {
    const reg = createTagRegistry(root);
    const t = await reg.create('Auth rewrite', 'tag-blue');
    expect(t.id.startsWith('tag_')).toBe(true);
    expect((await reg.list()).map((x) => x.label)).toEqual(['Auth rewrite']);

    await reg.update(t.id, { label: 'Auth', color: 'tag-red', archived: true });
    const [u] = await reg.list();
    expect([u.label, u.color, u.archived]).toEqual(['Auth', 'tag-red', true]);

    await reg.delete(t.id);
    expect(await reg.list()).toEqual([]);   // tombstoned tags never list
  });

  it('reuses an existing non-archived tag on a case-insensitive label match', async () => {
    const reg = createTagRegistry(root);
    const a = await reg.create('Feature X', 'tag-green');
    const b = await reg.create('  feature x ', 'tag-pink');
    expect(b.id).toBe(a.id);                // same tag, not a duplicate
    expect((await reg.list()).length).toBe(1);
  });

  it('rejects a blank label', async () => {
    const reg = createTagRegistry(root);
    await expect(reg.create('   ', 'tag-blue')).rejects.toThrow();
  });

  it('clamps an unknown color to the default on create', async () => {
    const reg = createTagRegistry(root);
    const t = await reg.create('X', 'not-a-color' as any);
    expect(t.color).toBe('tag-gray');
  });

  // Build a raw on-disk tag file. Simulates what the synced git transport writes,
  // including conflict-copy files ("<name> (from <device>, <date>).json") that
  // carry the SAME internal id as the canonical file.
  const writeRaw = (fileName: string, over: Record<string, any>) => {
    const t = '2026-07-13T00:00:00.000Z';
    const rec = {
      schema: 1, id: 'tag_x', label: 'Old', labelUpdatedAt: t,
      color: 'tag-blue', colorUpdatedAt: t, archived: false, archivedUpdatedAt: t,
      deleted: false, deletedUpdatedAt: t, createdAt: t, ...over,
    };
    fs.writeFileSync(path.join(root, fileName), JSON.stringify(rec, null, 2), 'utf8');
  };

  it('folds a sync conflict-copy into one converged tag (no duplicate id)', async () => {
    const reg = createTagRegistry(root);
    // Canonical: older label. Conflict copy (same id): newer label.
    writeRaw('tag_x.json', { label: 'Old', labelUpdatedAt: '2026-07-13T01:00:00.000Z' });
    writeRaw('tag_x (from DeviceB, 2026-07-13).json',
      { label: 'New', labelUpdatedAt: '2026-07-13T02:00:00.000Z' });
    const list = await reg.list();
    expect(list.length).toBe(1);                 // one id → one entry, not two
    expect(list[0].label).toBe('New');           // newest field wins across copies
  });

  it('a delete tombstone in a conflict copy is not resurrected by an older rename copy', async () => {
    const reg = createTagRegistry(root);
    // Canonical still live with a newer rename; a conflict copy carries the delete.
    writeRaw('tag_x.json',
      { label: 'Renamed', labelUpdatedAt: '2026-07-13T02:00:00.000Z' });
    writeRaw('tag_x (from DeviceB, 2026-07-13).json',
      { deleted: true, deletedUpdatedAt: '2026-07-13T03:00:00.000Z' });
    // Tombstone dominates → the tag stays deleted, never listed, never duplicated.
    expect(await reg.list()).toEqual([]);
  });
});
