// src/main/conversations/tag-registry.ts
// IO shell for the tag registry (design §"Tag registry"). One JSON file per tag
// under <personalRoot>/Tags/. All disk access lives here; all DECISIONS live in
// tag-registry-core.ts. Uses the same mkdir-lock read-modify-write primitive and
// path-traversal guards as conversation-store.ts.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mutateFileUnderLock } from '../artifacts/cas-write';
import {
  StoredTag, TAG_SCHEMA_VERSION, parseTag, mergeTag, normalizeLabel,
} from './tag-registry-core';
import {
  TagColor, TagRecord, TAG_ID_PREFIX, DEFAULT_TAG_COLOR, isTagColor,
} from '../../shared/tags';

export interface TagRegistry {
  list(): Promise<TagRecord[]>;                 // non-deleted; archived included
  create(label: string, color: TagColor): Promise<TagRecord>;
  update(id: string, patch: { label?: string; color?: TagColor; archived?: boolean }): Promise<TagRecord>;
  delete(id: string): Promise<void>;
  root(): string;
}

// Same allowlist as conversation-store: id becomes a path segment.
const SAFE_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const isSafeId = (s: string) => SAFE_SEGMENT_RE.test(s) && s !== '.' && s !== '..';

const nowIso = () => new Date().toISOString();

function toPublic(t: StoredTag): TagRecord {
  return { id: t.id, label: t.label, color: t.color, archived: t.archived, createdAt: t.createdAt };
}

export function createTagRegistry(tagsRoot: string): TagRegistry {
  const rootResolved = path.resolve(tagsRoot);

  function tagPath(id: string): string {
    const target = path.resolve(rootResolved, `${id}.json`);
    if (!isSafeId(id) || !target.startsWith(rootResolved + path.sep)) {
      throw new Error(`tag-registry: invalid tag id '${id}'`);
    }
    return target;
  }

  // Read every *.json under the root, parse, drop nulls (corrupt) and tombstoned.
  async function readAll(): Promise<StoredTag[]> {
    let names: string[];
    try { names = fs.readdirSync(rootResolved); } catch { return []; }
    const out: StoredTag[] = [];
    for (const n of names) {
      if (!n.endsWith('.json') || n.endsWith('.tmp')) continue;
      try {
        const t = parseTag(fs.readFileSync(path.join(rootResolved, n), 'utf8'));
        if (t) out.push(t);
      } catch { /* unreadable — skip */ }
    }
    return out;
  }

  async function writeTag(next: StoredTag): Promise<void> {
    const committed = await mutateFileUnderLock(tagPath(next.id), (onDisk) => {
      const existing = onDisk ? parseTag(onDisk) : null;
      // Merge so a concurrent cross-process edit isn't clobbered.
      const merged = existing ? mergeTag(existing, next) : next;
      return JSON.stringify(merged, null, 2);
    });
    if (!committed) throw new Error(`tag-registry: could not write ${next.id} (lock timeout)`);
  }

  return {
    root: () => tagsRoot,

    async list() {
      return (await readAll())
        .filter((t) => !t.deleted)
        .sort((a, b) => a.label.localeCompare(b.label))
        .map(toPublic);
    },

    async create(label, color) {
      const clean = label.trim();
      if (!clean) throw new Error('tag-registry: blank label');
      // Reuse an existing non-archived tag with the same normalized label
      // instead of making a duplicate.
      const existing = (await readAll()).find(
        (t) => !t.deleted && !t.archived && normalizeLabel(t.label) === normalizeLabel(clean),
      );
      if (existing) return toPublic(existing);
      const at = nowIso();
      const tag: StoredTag = {
        schema: TAG_SCHEMA_VERSION,
        id: TAG_ID_PREFIX + randomUUID(),
        label: clean, labelUpdatedAt: at,
        color: isTagColor(color) ? color : DEFAULT_TAG_COLOR, colorUpdatedAt: at,
        archived: false, archivedUpdatedAt: at,
        deleted: false, deletedUpdatedAt: at,
        createdAt: at,
      };
      await writeTag(tag);
      return toPublic(tag);
    },

    async update(id, patch) {
      const target = tagPath(id);
      let result: StoredTag | undefined;
      const committed = await mutateFileUnderLock(target, (onDisk) => {
        const existing = onDisk ? parseTag(onDisk) : null;
        if (!existing) throw new Error(`tag-registry: no tag '${id}'`);
        const at = nowIso();
        const next: StoredTag = { ...existing };
        if (patch.label !== undefined) {
          const clean = patch.label.trim();
          if (!clean) throw new Error('tag-registry: blank label');
          next.label = clean; next.labelUpdatedAt = at;
        }
        if (patch.color !== undefined) {
          next.color = isTagColor(patch.color) ? patch.color : DEFAULT_TAG_COLOR;
          next.colorUpdatedAt = at;
        }
        if (patch.archived !== undefined) { next.archived = patch.archived; next.archivedUpdatedAt = at; }
        result = next;
        return JSON.stringify(next, null, 2);
      });
      if (!committed || !result) throw new Error(`tag-registry: could not update ${id}`);
      return toPublic(result);
    },

    async delete(id) {
      const committed = await mutateFileUnderLock(tagPath(id), (onDisk) => {
        const existing = onDisk ? parseTag(onDisk) : null;
        if (!existing) return null; // already gone — nothing to tombstone
        const at = nowIso();
        return JSON.stringify({ ...existing, deleted: true, deletedUpdatedAt: at }, null, 2);
      });
      if (!committed) throw new Error(`tag-registry: could not delete ${id}`);
    },
  };
}
