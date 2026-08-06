/**
 * chatsearch — the IO shell. Builds and refreshes the derived index files.
 *
 * CONCURRENCY: ~/.youcoded/ is shared by the live app AND every run-dev.sh
 * instance (run-dev isolates only userData and ports). Two builders appending to
 * the same turns file would double-index it, so every refresh cycle runs under a
 * mkdir-based build lock. Every file lands via temp-then-rename.
 */

import fs from 'node:fs';
import path from 'node:path';
import { transcriptSkipReason } from '../conversations/lane-guards';
import { extractCcUserTurns, extractNativeUserTurns, type IndexTurn } from './index-core';
import {
  CHATSEARCH_FORMAT_VERSION,
  encodeTurnLine,
  type ConversationStats,
  type TurnsStateFile,
} from './index-format';

/** A lock older than this is assumed abandoned (crashed builder). */
const BUILD_LOCK_STALE_MS = 5 * 60_000;
/** Read this much per conversation per cycle; the rest catches up next cycle. */
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;

export function chatsearchDir(homeRoot: string): string {
  return path.join(homeRoot, '.youcoded', 'chatsearch');
}

export const turnsPath = (dir: string, provider: string) => path.join(dir, `${provider}-turns.jsonl`);
export const statePath = (dir: string, provider: string) => path.join(dir, `${provider}-turns.state.json`);
export const metaPath = (dir: string, provider: string) => path.join(dir, `${provider}-meta.json`);

/**
 * Atomic write: temp + rename. A reader (the CLI, or another instance) must
 * never observe a half-written file.
 */
export function atomicWriteFileSync(target: string, content: string): void {
  const tmp = `${target}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
}

/**
 * One builder at a time, across processes. Returns a release fn, or null when
 * another instance holds it — in which case the caller SKIPS this cycle rather
 * than waiting, since the next tick will catch up anyway.
 */
export async function acquireBuildLock(dir: string): Promise<(() => void) | null> {
  const lock = path.join(dir, '.build-lock');
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.mkdirSync(lock);
  } catch {
    try {
      const st = fs.statSync(lock);
      if (Date.now() - st.mtimeMs <= BUILD_LOCK_STALE_MS) return null;
      // Stale: a builder crashed without releasing. Take it over.
      fs.rmSync(lock, { recursive: true, force: true });
      fs.mkdirSync(lock);
    } catch {
      return null;
    }
  }
  return () => { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} };
}

export function readState(dir: string, provider: string): TurnsStateFile {
  const empty: TurnsStateFile = { v: CHATSEARCH_FORMAT_VERSION, provider, conversations: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(dir, provider), 'utf8')) as TurnsStateFile;
    if (!parsed || parsed.v !== CHATSEARCH_FORMAT_VERSION) return empty;
    return { ...empty, ...parsed, conversations: parsed.conversations || {} };
  } catch {
    return empty;
  }
}

export interface RefreshTurnsOpts {
  dir: string;
  provider: string;
  /** Which extractor to use. Defaults to the CC one. */
  lane?: 'claude' | 'native';
  conversations: Array<{ id: string; transcriptPath: string }>;
}

/** Read `[from, from+max)` bytes of a file as UTF-8. */
function readChunk(p: string, from: number, max: number): string {
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.alloc(max);
    const bytes = fs.readSync(fd, buf, 0, max, from);
    return buf.subarray(0, bytes).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Bring the turns index up to date and return per-conversation stats.
 *
 * Growth is appended from the recorded offset. A SHRUNK transcript (CC /clear
 * rewrite, compaction, retention deletion) is re-read from zero — resuming from
 * the old offset would splice unrelated bytes together. A transcript that has
 * VANISHED keeps its already-indexed turns: tombstones, never prune.
 */
export async function refreshTurns(opts: RefreshTurnsOpts): Promise<Map<string, ConversationStats>> {
  const { dir, provider } = opts;
  const state = readState(dir, provider);
  const stats = new Map<string, ConversationStats>();

  // Conversations needing a full re-read have their existing lines dropped.
  const rewrite = new Set<string>();
  const appended: IndexTurn[] = [];

  for (const conv of opts.conversations) {
    const prev = state.conversations[conv.id];

    let st: fs.Stats;
    try {
      st = fs.lstatSync(conv.transcriptPath);
    } catch {
      // Gone. Keep whatever we already indexed — that is the tombstone case.
      if (prev) stats.set(conv.id, statsOf(prev));
      continue;
    }
    if (transcriptSkipReason(st)) continue; // symlink — never follow

    let from = prev?.offset ?? 0;
    let startTurn = (prev?.turnCount ?? 0) + 1;
    let firstTurnTs = prev?.firstTurnTs ?? '';
    let lastTurnTs = prev?.lastTurnTs ?? '';

    if (prev && st.size < prev.size) {
      // Rewritten under us — start over for this conversation.
      rewrite.add(conv.id);
      from = 0;
      startTurn = 1;
      firstTurnTs = '';
      lastTurnTs = '';
    }

    if (st.size === from && prev && !rewrite.has(conv.id)) {
      stats.set(conv.id, statsOf(prev));
      continue;
    }

    const chunk = readChunk(conv.transcriptPath, from, Math.min(MAX_CHUNK_BYTES, Math.max(0, st.size - from)));
    const isStartOfFile = from === 0;
    const { turns, consumedBytes } =
      opts.lane === 'native'
        ? extractNativeUserTurns(chunk, conv.id, startTurn, isStartOfFile)
        : extractCcUserTurns(chunk, conv.id, startTurn);

    appended.push(...turns);
    for (const t of turns) {
      if (!firstTurnTs) firstTurnTs = t.ts;
      lastTurnTs = t.ts;
    }

    const next = {
      offset: from + consumedBytes,
      size: st.size,
      turnCount: startTurn - 1 + turns.length,
      firstTurnTs,
      lastTurnTs,
    };
    state.conversations[conv.id] = next;
    stats.set(conv.id, statsOf(next));
  }

  if (appended.length === 0 && rewrite.size === 0) return stats;

  // Rewrite the whole turns file when any conversation was re-read from zero;
  // otherwise append. Appending is the common path — a full rewrite only happens
  // when a transcript was truncated under us.
  const file = turnsPath(dir, provider);
  const newLines = appended.map(encodeTurnLine);

  if (rewrite.size > 0) {
    let kept: string[] = [];
    try {
      kept = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).filter((line) => {
        // Cheap prefix test avoids parsing every line just to check ownership.
        const m = line.match(/^\{"c":"([^"]+)"/);
        return !(m && rewrite.has(m[1]));
      });
    } catch { kept = []; }
    atomicWriteFileSync(file, [...kept, ...newLines].join('\n') + '\n');
  } else {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, newLines.join('\n') + '\n', 'utf8');
  }

  atomicWriteFileSync(statePath(dir, provider), JSON.stringify(state, null, 2));
  return stats;
}

function statsOf(s: { size: number; turnCount: number; firstTurnTs: string; lastTurnTs: string }): ConversationStats {
  return {
    sizeBytes: s.size,
    turnCount: s.turnCount,
    firstTurnTs: s.firstTurnTs,
    lastTurnTs: s.lastTurnTs,
  };
}
