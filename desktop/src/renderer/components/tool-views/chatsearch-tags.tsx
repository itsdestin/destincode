// Shared by ChatsearchFindCard and ChatsearchShowCard: turns a conversation's
// tag LABELS into real TagChip-renderable records.
//
// WHY this exists (and why it's a label lookup, not an id lookup like every
// other tag consumer in the app): the chatsearch index denormalizes tag ids to
// LABELS once at build time (main/chatsearch-index/meta-builder.ts) so the
// index doesn't have to carry the live registry around. By the time
// ResolvedConversation.tags reaches the renderer, the id is already gone — so
// unlike ResumeBrowser.tsx (registry.byId.get(id)) or SessionTagsChip.tsx,
// this has to re-match by LABEL against the current registry to recover a
// color at all.
import { useMemo } from 'react';
import { useTagRegistry } from '../../hooks/useTagRegistry';
import { DEFAULT_TAG_COLOR, type TagRecord } from '../../../shared/tags';

export type ChipTag = Pick<TagRecord, 'label' | 'color'>;

/** One registry load per card (not per row) — call this once at the card's
 *  root and pass the map down, so N rows sharing M tags don't each mount
 *  their own useTagRegistry() and independently hit window.claude.tags.list(). */
export function useTagLabelIndex(): Map<string, TagRecord> {
  const registry = useTagRegistry();
  return useMemo(() => {
    const m = new Map<string, TagRecord>();
    for (const t of registry.tags) if (!m.has(t.label)) m.set(t.label, t);
    return m;
  }, [registry.tags]);
}

/** Resolves each label to its real registry color when the label still
 *  matches a live tag. A label that doesn't match — the tag was renamed or
 *  deleted since the index snapshot was built, or the registry hasn't loaded
 *  yet — still renders, just in the neutral default color rather than a
 *  fabricated one: the row must never drop a tag the index reported, and
 *  must never invent a color for one this lookup can't verify. */
export function resolveChatsearchTags(labels: string[], byLabel: Map<string, TagRecord>): ChipTag[] {
  return labels.map((label) => byLabel.get(label) ?? { label, color: DEFAULT_TAG_COLOR });
}
