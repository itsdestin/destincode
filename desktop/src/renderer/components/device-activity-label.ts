// desktop/src/renderer/components/device-activity-label.ts
// Pure derivation of the "Your devices" row activity label from real sync
// recency (2026-07-17 sync-menu-recency spec). Renderer-safe — no fs/os/window,
// no Node APIs — because this same module ships to the Android WebView. Mirrors
// the style of sync-dot-state.ts (its sibling): all logic lives here as pure
// functions so the exact wording bands are unit-pinned and never drift.
//
// WHY this replaced the frozen "last seen {launch time}": lastSeen is a
// launch-time heartbeat that only propagates over git, so a device that is on
// and actively syncing still read "last seen a few hours ago" on every other
// device. lastSyncByDevice (carried over the SyncHub Durable Object, keyed by
// machineId) gives the real "last successful sync" time instead.

// Relative time from a MILLISECOND epoch timestamp. `now` is injectable so the
// helper stays pure/testable (no hidden Date.now() read). Full words on purpose
// — the "Your devices" list is spec'd as plain text with no status glyphs, and
// the recency band ("Last synced 12 minutes ago") reads better spelled out.
// This is the SINGLE wording ladder for the sync menu — both the recency band
// below and the launch-time fallback route through it (no duplicate ladder).
export function relativeMs(ms: number, now: number = Date.now()): string {
  if (!ms || !Number.isFinite(ms)) return 'unknown';
  const seconds = Math.floor((now - ms) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export interface DeviceActivityInput {
  /** Is this the current machine? Its row shows a live "Syncing…" while active. */
  isSelf: boolean;
  /** A sync is in flight right now (local signal, self only). */
  syncInProgress: boolean;
  /** Epoch-ms of this device's most recent successful sync, or null if unknown
   *  (older main process with no lastSyncByDevice map, or a never-synced peer). */
  lastSyncAt: number | null;
  /** Launch-time heartbeat epoch-ms (device registry) — the graceful fallback. */
  gitLastSeen: number;
}

// < 5 min ⇒ "Synced just now"; ≥ 5 min ⇒ "Last synced {relative} ago".
const RECENT_WINDOW_MS = 5 * 60_000;

/**
 * The activity label for one device row. Bands:
 *   self + syncing      → "Syncing…"        (live, local-only)
 *   synced < 5 min ago  → "Synced just now"
 *   synced ≥ 5 min ago  → "Last synced {relative} ago"
 *   no sync record      → "last seen {relative}"  (launch-time fallback)
 *
 * Clock-skew safe: `at` is SERVER time compared against the viewer's local
 * clock, so we clamp `max(0, now − at)` — a device whose clock runs ahead can
 * never render a negative/future age (same guard as friends-data.ts).
 */
export function deviceActivityLabel(input: DeviceActivityInput, now: number = Date.now()): string {
  // Self mid-sync trumps everything — it's the one live signal the row shows.
  if (input.isSelf && input.syncInProgress) return 'Syncing…';

  // No sync record → degrade to the old launch-time wording. This is the
  // graceful path when the main process predates lastSyncByDevice, or a peer
  // has never synced: nothing breaks, the row just reads the heartbeat.
  if (input.lastSyncAt == null) return `last seen ${relativeMs(input.gitLastSeen, now)}`;

  // Clamp so a skewed/future timestamp reads "just now", never a negative age.
  const age = Math.max(0, now - input.lastSyncAt);
  if (age < RECENT_WINDOW_MS) return 'Synced just now';
  return `Last synced ${relativeMs(input.lastSyncAt, now)}`;
}
