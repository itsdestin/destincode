// desktop/src/main/sync-spaces/types.ts
// The sync-space model from spec §4/§5. The SyncTransport seam is the
// compatibility boundary for the future YouCoded Cloud transport (spec §16).

export type SpaceKind = 'project' | 'personal';

export interface SyncSpace {
  id: string;        // 'personal' | 'project:<name>'
  kind: SpaceKind;
  root: string;      // absolute path to the space's folder on this device
}

export interface PushResult {
  pushed: boolean;          // false when nothing changed or no remote configured
  commit?: string;          // HEAD sha after commit, when one was made
  oversize: string[];       // rel paths excluded for exceeding MAX_SYNC_FILE_BYTES
}

export interface PullResult {
  updated: boolean;         // true when remote changes were applied
  conflictCopies: string[]; // rel paths of conflict copies written this pull
}

export interface SpaceVersion { commit: string; date: string; message: string; }

/** Spec §5: push/pull/subscribe/history. subscribe() is Plan 1b (SyncHub) —
 *  1a polls instead, so the interface ships without it and 1b adds it. */
export interface SyncTransport {
  init(space: SyncSpace): Promise<void>;
  hasRemote(space: SyncSpace): Promise<boolean>;
  setRemote(space: SyncSpace, url: string): Promise<void>;
  push(space: SyncSpace, message: string): Promise<PushResult>;
  pull(space: SyncSpace): Promise<PullResult>;
  history(space: SyncSpace, limit?: number): Promise<SpaceVersion[]>;
}

export type SpaceSyncEvent =
  | { type: 'synced'; spaceId: string; pushed: boolean; updated: boolean }
  | { type: 'conflict'; spaceId: string; copies: string[] }
  | { type: 'oversize'; spaceId: string; files: string[] }
  | { type: 'error'; spaceId: string; message: string };
