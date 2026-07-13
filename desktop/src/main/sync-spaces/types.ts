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

// `at` is stamped by service.broadcast() at emit time (ms epoch). Optional so
// replayed or older payloads without it still typecheck. The renderer derives
// "Last synced N minutes ago" (Project View hero) from it.
export type SpaceSyncEvent = (
  | { type: 'synced'; spaceId: string; pushed: boolean; updated: boolean }
  | { type: 'conflict'; spaceId: string; copies: string[] }
  | { type: 'oversize'; spaceId: string; files: string[] }
  | { type: 'error'; spaceId: string; message: string }
  // SyncHub (Plan 1b) connection status. spaceId is the literal 'hub' (never a
  // real space id) so every consumer's per-space event scan / sync-dot
  // derivation ignores it naturally while keeping the field shape uniform.
  | { type: 'hub-status'; spaceId: 'hub'; status: 'connected' | 'disconnected' }
  // Cross-device discovery (2026-07-13): the set of managed projects on THIS
  // device changed — a project was materialized from another device or a stop
  // tombstone detached one. The renderer refetches its folder/project lists on
  // this so a newly-synced project appears in the picker + Project View WITHOUT
  // a manual reopen. spaceId is the affected project (informational). Like
  // 'hub-status', it never drives sync-dot state.
  | { type: 'projects-changed'; spaceId: string }
) & { at?: number };
