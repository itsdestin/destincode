// desktop/src/main/sync-spaces/self-sync-status.ts
// Pure derivation of the "this device" sync recency shown in the devices list.
//
// WHY this exists (2026-07-30 spec §4, the "last seen 22 hours ago" screenshot
// bug): buildStatusData used to read ONLY ~/.claude/toolkit-state/.sync-marker,
// which just the LEGACY Drive/iCloud push path stamps — absent on GitHub-era
// installs, so the self row fell back to the launch-time "last seen" while
// peer rows (SyncHub map) looked live. Primary evidence is now the sync-spaces
// persisted lastSync map; the legacy marker survives only as a fallback/max for
// installs still using the extra-backups system.
/** Returns SECONDS (the status:data wire unit — SyncPanel multiplies by 1000). */
export function deriveSelfLastSyncEpochSec(
  spacesLastSyncMs: number | null,
  legacyMarkerRaw: string | null,
): number | null {
  const legacySec = legacyMarkerRaw ? (parseInt(legacyMarkerRaw, 10) || null) : null;
  const spacesSec = spacesLastSyncMs != null ? Math.floor(spacesLastSyncMs / 1000) : null;
  if (spacesSec == null) return legacySec;
  if (legacySec == null) return spacesSec;
  return Math.max(spacesSec, legacySec);
}
