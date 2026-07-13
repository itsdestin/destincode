// src/main/conversations/tag-registry-core.ts
// PURE record logic for the tag registry (design §"Tag registry"). No fs/path/os
// — the IO shell (tag-registry.ts) does disk work. Same pure-core / IO-shell
// split as store-core.ts. Every editable field carries its own *UpdatedAt so
// mergeTag resolves each field independently and converges across devices.
import { ts, laterOf, earliestOf } from './store-core';
import { TagColor, DEFAULT_TAG_COLOR, isTagColor } from '../../shared/tags';

export const TAG_SCHEMA_VERSION = 1;

// The on-disk tag shape — a superset of the renderer's TagRecord with per-field
// timestamps and a delete tombstone.
export interface StoredTag {
  schema: number;
  id: string;
  label: string;
  labelUpdatedAt: string;
  color: TagColor;
  colorUpdatedAt: string;
  archived: boolean;
  archivedUpdatedAt: string;
  deleted: boolean;          // tombstone — delete must propagate, not resurrect
  deletedUpdatedAt: string;
  createdAt: string;
}

// Case-insensitive, trimmed label — the dedup key used by create() so 'Auth'
// and ' auth ' don't become two tags.
export function normalizeLabel(label: string): string {
  return label.trim().toLowerCase();
}

// Parse + validate one tag file. Returns null on anything malformed so a corrupt
// tag damages exactly itself, never the whole list (same guarantee as parseRecord).
export function parseTag(json: string): StoredTag | null {
  let raw: any;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  if (raw.schema !== TAG_SCHEMA_VERSION) return null;
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.label !== 'string') return null;
  const str = (v: unknown, d: string) =>
    typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : d;
  const createdAt = str(raw.createdAt, str(raw.labelUpdatedAt, new Date(0).toISOString()));
  return {
    schema: TAG_SCHEMA_VERSION,
    id: raw.id,
    label: raw.label,
    labelUpdatedAt: str(raw.labelUpdatedAt, createdAt),
    color: isTagColor(raw.color) ? raw.color : DEFAULT_TAG_COLOR,
    colorUpdatedAt: str(raw.colorUpdatedAt, createdAt),
    archived: raw.archived === true,
    archivedUpdatedAt: str(raw.archivedUpdatedAt, createdAt),
    deleted: raw.deleted === true,
    deletedUpdatedAt: str(raw.deletedUpdatedAt, createdAt),
    createdAt,
  };
}

// Pick the value+timestamp pair with the newer timestamp, JSON-tiebroken on a
// tie — reuses store-core's laterOf so the tiebreak is identical everywhere.
function pickField<T>(av: T, aAt: string, bv: T, bAt: string): { v: T; at: string } {
  return laterOf({ v: av, at: aAt }, { v: bv, at: bAt }, ts(aAt), ts(bAt));
}

// Field-level newest-wins merge. Used by BOTH create/update read-modify-write
// and the conflict-copy fold, so the two can't drift.
export function mergeTag(a: StoredTag, b: StoredTag): StoredTag {
  const label = pickField(a.label, a.labelUpdatedAt, b.label, b.labelUpdatedAt);
  const color = pickField(a.color, a.colorUpdatedAt, b.color, b.colorUpdatedAt);
  const archived = pickField(a.archived, a.archivedUpdatedAt, b.archived, b.archivedUpdatedAt);
  const deleted = pickField(a.deleted, a.deletedUpdatedAt, b.deleted, b.deletedUpdatedAt);
  return {
    schema: TAG_SCHEMA_VERSION,
    id: a.id,
    label: label.v, labelUpdatedAt: label.at,
    color: color.v, colorUpdatedAt: color.at,
    archived: archived.v, archivedUpdatedAt: archived.at,
    deleted: deleted.v, deletedUpdatedAt: deleted.at,
    createdAt: earliestOf(a.createdAt, b.createdAt),
  };
}

// Fold conflict copies into the canonical tag. Every field pick is per-field
// max/min over values that pass through merges UNCHANGED (associative +
// commutative), so a plain reduce is order-independent here.
export function foldTagConflicts(canonical: StoredTag, copies: StoredTag[]): StoredTag {
  return copies.reduce((acc, c) => mergeTag(acc, c), canonical);
}
