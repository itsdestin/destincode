// desktop/src/renderer/components/sync-dot-state.ts
// Pure derivation of per-project sync state from syncSpaces.status() data.
// Renderer-safe (no fs/path — this file also ships to the Android WebView).
// The three dot states and their exact wording are pinned by the 2026-07-09
// project-sync-management-ux spec; the picker shows the dot, the tooltip and
// the Project View hero show these words.

export interface SyncStatusData {
  enabled: boolean;
  // `displayName`/`state` are the read-time overlay from the cross-device project
  // registry (2026-07-12): a stopped project reads as detached, not errored.
  spaces: Array<{ id: string; root: string; displayName?: string; state?: 'active' | 'stopped' }>;
  // Engine events since app boot (last 50). `at` is stamped at broadcast time
  // (ms epoch); older payloads may lack it.
  recentEvents: Array<{ type: string; spaceId: string; at?: number; message?: string }>;
}

export interface SyncDot { color: 'green' | 'red' | 'gray'; label: string }

// Windows-tolerant normalize: forward slashes, no trailing slash, lowercased.
// (canonicalize() lives in shared/artifacts but drags in more than we need
// here; root-vs-root equality only needs slash/case folding.)
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

export function findSpaceFor(folderPath: string, status: SyncStatusData | null): SyncStatusData['spaces'][number] | null {
  if (!status) return null;
  return status.spaces.find((s) => norm(s.root) === norm(folderPath)) ?? null;
}

function latestEventFor(spaceId: string, status: SyncStatusData) {
  for (let i = status.recentEvents.length - 1; i >= 0; i--) {
    if (status.recentEvents[i].spaceId === spaceId) return status.recentEvents[i];
  }
  return null;
}

export function syncDotFor(folderPath: string, status: SyncStatusData | null): SyncDot | null {
  if (!status) return null; // status() rejected (e.g. Android) — render no dot at all
  const space = findSpaceFor(folderPath, status);
  if (!space) return { color: 'gray', label: 'Only on this computer' };
  // A stopped project is detached on every device (permanent tombstone) — it
  // reads as "not syncing", never as an error, regardless of the global toggle.
  if (space.state === 'stopped') return { color: 'gray', label: 'Sync stopped' };
  if (!status.enabled) return { color: 'gray', label: 'Sync is turned off — will sync once you turn on Sync in Settings' };
  const last = latestEventFor(space.id, status);
  if (last?.type === 'error') return { color: 'red', label: "Sync isn't working — open Manage projects" };
  return { color: 'green', label: 'Syncs across your devices' };
}

/** "just now" / "N minutes ago" / "N hours ago" / null when unknown.
 *  `now` is injectable for tests. */
export function lastSyncedLabel(spaceId: string, status: SyncStatusData | null, now: number = Date.now()): string | null {
  if (!status) return null;
  let latest: number | null = null;
  for (const e of status.recentEvents) {
    if (e.spaceId === spaceId && e.type === 'synced' && typeof e.at === 'number') {
      if (latest === null || e.at > latest) latest = e.at;
    }
  }
  if (latest === null) return null;
  const mins = Math.floor((now - latest) / 60_000);
  if (mins < 1) return 'just now';
  if (mins === 1) return '1 minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.floor(mins / 60);
  return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
}
