// Live count of a session's still-present artifacts.
//
// Extracted from ArtifactDrawerButton so the narrow-viewport overflow menu can
// show the same number on its "Session artifacts" row. Two ways a file stops
// being present:
//   1. status === 'deleted' — an explicit Delete tool version (rare; CC has no
//      Delete tool, so this mostly never happens).
//   2. "orphan" — the file was removed via `bash rm` (which produces NO
//      artifact event), so the record stays status:'active' but the file is
//      gone from disk. The drawer detects these with checkExistence; we mirror
//      that here so the badge reflects what's actually on disk, not the full
//      session activity log.

import { useEffect, useState } from 'react';
import { useArtifact } from '../state/ArtifactContext';

export function useArtifactCount(activeSessionId: string | null, projectRoot?: string): number {
  const { state } = useArtifact();
  const sessionArtifacts = activeSessionId ? (state.sessionArtifacts[activeSessionId] ?? []) : [];
  const drawerOpen = activeSessionId ? (state.drawerOpenBySession[activeSessionId] ?? false) : false;

  const [missingIds, setMissingIds] = useState<Set<string>>(() => new Set());
  const liveIds = sessionArtifacts.filter((a) => a.status !== 'deleted').map((a) => a.id);
  const idsKey = liveIds.join(',');

  // Re-checks when the list changes or the drawer toggles (same triggers the
  // drawer itself uses).
  useEffect(() => {
    if (!projectRoot || liveIds.length === 0) { setMissingIds(new Set()); return; }
    let cancelled = false;
    (window.claude as any).artifacts.checkExistence(projectRoot, liveIds)
      .then((res: any) => { if (!cancelled && res?.ok) setMissingIds(new Set(res.missingIds ?? [])); })
      .catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectRoot, idsKey, drawerOpen]);

  return sessionArtifacts.filter((a) => a.status !== 'deleted' && !missingIds.has(a.id)).length;
}
