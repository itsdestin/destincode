/**
 * chatsearch — module singleton + lifecycle, matching tag-registry-service.ts's
 * shape (module-level state, start/stop free functions, no class).
 *
 * Refresh triggers: app start, session quiesce, and any in-app metadata change.
 * The last one is load-bearing — without it a tag applied in the app UI would be
 * invisible to the CLI until the next launch.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ConversationRecord } from '../conversations/store-core';
import {
  getConversationStore,
  onConversationMetaChanged,
} from '../conversations/service';
import { getTagRegistry } from '../conversations/tag-registry-service';
import { NativeHome } from '../native-home';
import { cwdToProjectSlug } from '../transcript-watcher';
import { ccProjectSlug } from '../project-conversations';
import { buildMetaFile } from './meta-builder';
import {
  acquireBuildLock, atomicWriteFileSync, chatsearchDir, metaPath, refreshTurns,
} from './index-store';

/** Coalesce bursts of metadata changes into one refresh. */
const META_DEBOUNCE_MS = 3_000;

let started = false;
let debounceTimer: NodeJS.Timeout | null = null;
let unsubscribeMeta: (() => void) | null = null;
let inFlight = false;

export interface LaneInput {
  provider: string;
  lane: 'claude' | 'native';
  records: ConversationRecord[];
  resolveTranscriptPath: (rec: ConversationRecord) => string;
}

export interface RefreshInput {
  homeRoot: string;
  lanes: LaneInput[];
  tagLabels: Map<string, string>;
}

/**
 * One full refresh cycle. Returns false when another instance holds the build
 * lock (this cycle is skipped; the next tick catches up).
 *
 * WHY one lock for the whole cycle: acquireBuildLock is keyed on the
 * chatsearch DIRECTORY, not per-provider — a second acquire inside this same
 * call would either deadlock against itself (mkdir-based lock, not
 * reentrant) or, if implemented reentrant, defeat the point of serializing
 * concurrent builders. So the lock wraps BOTH lanes in the loop below.
 */
export async function refreshChatsearchIndex(input: RefreshInput): Promise<boolean> {
  const dir = chatsearchDir(input.homeRoot);
  const release = await acquireBuildLock(dir);
  if (!release) return false;

  // WHY try/finally: a throw partway through one lane (e.g. a bad transcript
  // path) must still release the lock, or every future refresh — including
  // ones triggered from a different process — is skipped forever.
  try {
    for (const lane of input.lanes) {
      const conversations = lane.records
        .filter((r) => !!r.transcriptRef)
        .map((r) => ({ id: r.id, transcriptPath: lane.resolveTranscriptPath(r) }));

      const stats = await refreshTurns({
        dir, provider: lane.provider, lane: lane.lane, conversations,
      });

      const meta = buildMetaFile({
        provider: lane.provider,
        records: lane.records,
        refreshedAt: new Date().toISOString(),
        tagLabels: input.tagLabels,
        stats,
        resolveTranscriptPath: lane.resolveTranscriptPath,
        // lstatSync, never existsSync/statSync: matches the rest of this
        // subsystem's never-follow-a-symlink posture (see index-store.ts's
        // acquireBuildLock and transcriptSkipReason).
        transcriptExists: (p) => { try { return fs.lstatSync(p).size >= 0; } catch { return false; } },
      });

      atomicWriteFileSync(metaPath(dir, lane.provider), JSON.stringify(meta, null, 2));
    }
    return true;
  } finally {
    release();
  }
}

/** Gather live inputs from the store + tag registry and run one cycle. */
async function refreshFromLiveState(): Promise<void> {
  if (inFlight) return; // a cycle is already running; its result will be current enough
  const store = getConversationStore();
  if (!store) return; // store unavailable this launch — nothing to index

  inFlight = true;
  try {
    const tagLabels = new Map<string, string>();
    try {
      const reg = getTagRegistry();
      // Null registry (managed roots unavailable) degrades to unlabeled tags,
      // never to a crash — same posture as the tags:list IPC handler.
      for (const t of (await reg?.list()) ?? []) tagLabels.set(t.id, t.label);
    } catch { /* unlabeled is acceptable; an empty index is not */ }

    const home = new NativeHome();
    const homeRoot = os.homedir();

    const [claudeRecords, nativeRecords] = await Promise.all([
      store.list('claude').catch(() => [] as ConversationRecord[]),
      store.list('native').catch(() => [] as ConversationRecord[]),
    ]);

    await refreshChatsearchIndex({
      homeRoot,
      tagLabels,
      lanes: [
        {
          provider: 'claude',
          lane: 'claude',
          records: claudeRecords,
          resolveTranscriptPath: (r) =>
            path.join(homeRoot, '.claude', 'projects', ccProjectSlug(r.originalPath), `${r.id}.jsonl`),
        },
        {
          provider: 'native',
          lane: 'native',
          records: nativeRecords,
          // RAW slug, not ccProjectSlug — the two encodings diverge deliberately
          // (ccProjectSlug uppercases a lowercase Windows drive letter).
          resolveTranscriptPath: (r) =>
            path.join(home.root, 'sessions', cwdToProjectSlug(r.originalPath), `${r.id}.jsonl`),
        },
      ],
    });
  } catch {
    // A failed refresh leaves the previous index in place. The next trigger
    // retries; a stale index is surfaced by the CLI's own age banner.
  } finally {
    inFlight = false;
  }
}

/** Public trigger — safe to call from anywhere in main. Never throws. */
export function requestChatsearchRefresh(): void {
  if (!started) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void refreshFromLiveState(); }, META_DEBOUNCE_MS);
  debounceTimer.unref?.();
}

export function startChatsearchIndex(): void {
  stopChatsearchIndex();
  started = true;
  unsubscribeMeta = onConversationMetaChanged(() => { requestChatsearchRefresh(); });
  // Startup scan is the load-bearing one: Claude Code sessions happen whether or
  // not the app is running, so the index is usually behind at launch.
  void refreshFromLiveState();
}

export function stopChatsearchIndex(): void {
  started = false;
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  unsubscribeMeta?.();
  unsubscribeMeta = null;
}
