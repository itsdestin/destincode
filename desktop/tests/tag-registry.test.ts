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
});
