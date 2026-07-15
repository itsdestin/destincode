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
  // Maintenance hooks (spec §7 "known limit"). OPTIONAL so a future non-git
  // transport (YouCoded Cloud) needn't implement local repack/sizing — the
  // engine calls them with `?.` and treats absence as a no-op.
  /** After every Nth successful sync, run a LOCAL `git gc` to repack the hidden
   *  history. Best-effort; never throws. Never rewrites history (no force-push /
   *  filter-branch), so it cannot desync peers — it only shrinks local disk. */
  maybeGc?(space: SyncSpace): Promise<void>;
  /** Recursive byte size of the hidden sync repo, for the large-history warning.
   *  Bounded + best-effort; returns 0 on error / missing repo. */
  gitDirSizeBytes?(space: SyncSpace): Promise<number>;
}

// `at` is stamped by service.broadcast() at emit time (ms epoch). Optional so
// replayed or older payloads without it still typecheck. The renderer derives
// "Last synced N minutes ago" (Project View hero) from it.
export type SpaceSyncEvent = (
  | { type: 'synced'; spaceId: string; pushed: boolean; updated: boolean }
  | { type: 'conflict'; spaceId: string; copies: string[] }
  | { type: 'oversize'; spaceId: string; files: string[] }
  | { type: 'error'; spaceId: string; message: string }
  // Informational notice — NOT an error. Used for the large-history warning
  // (spec §7). Carries a REAL space id (unlike the 'hub'/'projects' sentinels),
  // but MUST NOT drive the red "sync isn't working" dot: sync still works
  // normally. sync-dot-state.ts's latestEventFor skips it for that reason;
  // SyncPanel renders it in non-alarming (muted, not red) styling.
  | { type: 'notice'; spaceId: string; message: string }
  // SyncHub (Plan 1b) connection status. spaceId is the literal 'hub' (never a
  // real space id) so every consumer's per-space event scan / sync-dot
  // derivation ignores it naturally while keeping the field shape uniform.
  | { type: 'hub-status'; spaceId: 'hub'; status: 'connected' | 'disconnected' }
  // Cross-device discovery (2026-07-13): the set of managed projects on THIS
  // device changed — a project was materialized from another device or a stop
  // tombstone detached one. The renderer refetches its folder/project lists on
  // this so a newly-synced project appears in the picker + Project View WITHOUT
  // a manual reopen. spaceId is the SENTINEL 'projects' (NOT a real project id)
  // — exactly like 'hub-status' uses 'hub' — so `latestEventFor()` in
  // sync-dot-state never surfaces it for a real space and can't mask that
  // space's error/synced event. Consumers match on `type`, never spaceId.
  | { type: 'projects-changed'; spaceId: 'projects' }
) & { at?: number };
