/**
 * chatsearch Tier 1 — the metadata snapshot. Pure: takes records + lookups in,
 * returns the file contents. All IO lives in index-store.
 *
 * Everything the CLI would otherwise need store knowledge for is resolved HERE:
 * tag ids -> labels, flag map -> booleans, transcriptRef -> absolute local path.
 */

import type { ConversationRecord } from '../conversations/store-core';
import { laneMatches } from '../conversations/lane-guards';
import {
  CHATSEARCH_FORMAT_VERSION,
  type ChatsearchMetaEntry,
  type ChatsearchMetaFile,
  type ConversationStats,
} from './index-format';

export interface BuildMetaInput {
  provider: string;
  records: ConversationRecord[];
  refreshedAt: string;
  /** tag id -> label, from the tag registry's list(). Empty map when unavailable. */
  tagLabels: Map<string, string>;
  /** conversation id -> stats, from the turns state file. */
  stats: Map<string, ConversationStats>;
  resolveTranscriptPath: (rec: ConversationRecord) => string;
  transcriptExists: (absPath: string) => boolean;
  storeRoot: string;
}

const EMPTY_STATS: ConversationStats = {
  sizeBytes: 0, turnCount: 0, firstTurnTs: '', lastTurnTs: '',
};

/** 'Untitled' and 'New Session' are placeholders, not titles (store-core's rule). */
function realTitle(title: string): string {
  const t = (title || '').trim();
  return t === 'Untitled' || t === 'New Session' ? '' : t;
}

export function buildMetaFile(input: BuildMetaInput): ChatsearchMetaFile {
  const conversations: Record<string, ChatsearchMetaEntry> = {};

  for (const rec of input.records) {
    // Phantom metadata-only seed: no ref to resolve. Skip rather than derive a
    // slug — no record predates transcriptRef, so an empty one is always this.
    if (!rec.transcriptRef) continue;
    // D5, never cross-materialize.
    if (!laneMatches(input.provider, rec.transcriptRef)) continue;

    const flags = rec.flags || {};
    const tags: string[] = [];
    for (const [key, state] of Object.entries(flags)) {
      if (!state?.value) continue;
      if (!key.startsWith('tag:')) continue;
      const label = input.tagLabels.get(key.slice(4));
      // An unresolvable id means a deleted tag or an unavailable registry —
      // omit it rather than leaking a raw id into CLI output.
      if (label) tags.push(label);
    }
    tags.sort();

    const transcriptPath = input.resolveTranscriptPath(rec);

    conversations[rec.id] = {
      ...(input.stats.get(rec.id) ?? EMPTY_STATS),
      id: rec.id,
      provider: input.provider,
      projectName: rec.projectName,
      originalPath: rec.originalPath,
      title: realTitle(rec.title),
      lastActive: rec.lastActive,
      createdAt: rec.createdAt,
      complete: !!flags.complete?.value,
      priority: !!flags.priority?.value,
      tags,
      note: rec.note || '',
      transcriptPath,
      // Tombstone, never prune: answering about a conversation whose bytes are
      // gone is the backstop's most valuable case.
      tombstone: !input.transcriptExists(transcriptPath),
    };
  }

  return {
    v: CHATSEARCH_FORMAT_VERSION,
    provider: input.provider,
    refreshedAt: input.refreshedAt,
    storeRoot: input.storeRoot,
    conversations,
  };
}
