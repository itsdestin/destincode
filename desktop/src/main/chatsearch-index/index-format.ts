/**
 * chatsearch — the ON-DISK FORMAT contract. Pure; no fs.
 *
 * WHY this is its own module: the CLI that reads these files is a standalone
 * Node script in the wecoded-marketplace repo and CANNOT import this TypeScript.
 * The app owns the producer side, the CLI owns the consumer side, and the FILE
 * FORMAT is the only thing between them. Golden tests on both sides pin it.
 * Any change here is a breaking change for the CLI — bump the version.
 */

import type { IndexTurn } from './index-core';

export const CHATSEARCH_FORMAT_VERSION = 1;

/** Per-conversation stats derived from the turns index (Task 4 produces these). */
export interface ConversationStats {
  sizeBytes: number;
  turnCount: number;
  firstTurnTs: string;
  lastTurnTs: string;
}

/** One conversation's denormalized metadata. The CLI needs NO store knowledge. */
export interface ChatsearchMetaEntry extends ConversationStats {
  id: string;
  provider: string;
  projectName: string;
  originalPath: string;
  /** '' when untitled — placeholders ('Untitled', 'New Session') normalize to ''. */
  title: string;
  lastActive: string;
  createdAt: string;
  /** Resolved from the flag map, never raw FlagState. */
  complete: boolean;
  priority: boolean;
  /** Tag LABELS resolved through the registry — never raw `tag:<id>` keys. */
  tags: string[];
  note: string;
  /** Absolute local path, so `show --turns` never derives a slug. */
  transcriptPath: string;
  /** True when the transcript is gone. The row is KEPT — see the spec's Decided. */
  tombstone: boolean;
}

export interface ChatsearchMetaFile {
  v: number;
  provider: string;
  refreshedAt: string;
  /** Absolute path of the conversation store this index mirrors. WHY: the CLI
   *  stamps it into outbox requests so an app instance whose store root is
   *  genuinely different (the user's home directory moved, or a second
   *  machine's synced folder) leaves the request alone instead of applying it
   *  to the wrong conversations. Fix (comment only): this is NOT what stops a
   *  run-dev.sh instance from draining — verified that a dev instance and the
   *  built app resolve the IDENTICAL store root (YOUCODED_PROFILE only shifts
   *  userData, main.ts:251-253; ManagedRoots derives ~/YouCoded/Personal from
   *  os.homedir() regardless, managed-roots.ts:17-20; conversations/service.ts:
   *  166-167). The dev-instance gate in outbox-drain.ts (isDevInstance) is the
   *  only thing that stops that case. Additive — format version stays 1; the
   *  CLI ignores fields it doesn't know. */
  storeRoot: string;
  conversations: Record<string, ChatsearchMetaEntry>;
}

/** Incremental-refresh bookkeeping, one entry per conversation. */
export interface TurnsStateFile {
  v: number;
  provider: string;
  /**
   * Size (bytes) of the turns file as of the last successful write of THIS state
   * file. Lets refreshTurns detect and repair a crash between the two writes
   * (turns file written, process dies before state is updated) by truncating any
   * orphaned tail back to this size. Undefined for state files written before
   * this field existed — treated as "unknown," never as a signal to truncate.
   */
  turnsBytes?: number;
  conversations: Record<string, {
    /** Byte offset consumed so far. */
    offset: number;
    /** Transcript size at that point — a smaller size means it was rewritten. */
    size: number;
    turnCount: number;
    firstTurnTs: string;
    lastTurnTs: string;
  }>;
}

/**
 * One turn as a single physical line. Keys are short because this file is the
 * bulk of the index and the CLI greps it.
 */
export function encodeTurnLine(t: IndexTurn): string {
  // JSON.stringify escapes newlines, so one turn is always exactly one line.
  return JSON.stringify({ c: t.conversationId, t: t.turn, ts: t.ts, x: t.text });
}

/** Inverse of encodeTurnLine. Returns null for anything malformed — never throws. */
export function decodeTurnLine(line: string): IndexTurn | null {
  if (!line.trim()) return null;
  let raw: unknown;
  try { raw = JSON.parse(line); } catch { return null; }
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.c !== 'string' || typeof o.t !== 'number') return null;
  if (typeof o.ts !== 'string' || typeof o.x !== 'string') return null;
  return { conversationId: o.c, turn: o.t, ts: o.ts, text: o.x };
}
