import { canonicalize } from '../../shared/artifacts/canonicalize';

interface TrackableArtifact {
  kind: string;
  path: string;
  absolutePath?: string | null;
  versions?: Array<{ type: string }>;
}

/**
 * Single predicate for which sidecar artifacts are TRACKED-visible — i.e. what
 * LIST_PROJECT returns and what the tracked counts total. The rules:
 *
 *   1. Manually INCLUDED (a manualIncludes pin) → always visible, any kind.
 *      Includes WIN over excludes. Nothing WRITES pins any more: "+ Add file"
 *      became a Move/Copy import on 2026-07-23 (see rule 4), so this rule now
 *      exists to keep pins written by the old flow visible after an upgrade —
 *      it is NOT a recovery path for a mistaken Exclude, because no UI can
 *      create a pin. (The INCLUDE_EXTERNAL handler still can; nothing calls it.)
 *   2. Manually EXCLUDED → hidden, any kind. One-way in-app, per rule 1.
 *   3. Internal files → visible only with at least one NON-READ version
 *      (create/edit/delete = Claude's actual work, or a user save). A file
 *      that was merely VIEWED via a pill click ('read' versions only) does NOT
 *      belong in "files Claude made" — it stays in All files and the session
 *      drawer (an activity log, where "viewed" is at home).
 *   4. External files → hidden unless included (rule 1). WHY: tried making this
 *      mirror rule 3 (2026-07-23) so externals were visible on edit history
 *      alone; against the real sidecar an ungated external set was ~95%
 *      incidental noise (scratchpad temps, other-device paths, .claude/
 *      internals), so it was reverted back to pin-gated.
 *
 * All include/exclude entries are canonical ABSOLUTE paths (the EXCLUDE /
 * INCLUDE_EXTERNAL handlers normalize them); internal artifact paths are
 * resolved against projectRoot before comparison. Canonicalizing BOTH sides is
 * load-bearing: the tracker stores raw absolutePath (uppercase drive on
 * Windows) while the manual lists store canonical (lowercase drive) — a raw
 * Set.has() always missed and "Add file"-ed externals silently vanished.
 * This helper is the one place these comparisons happen; don't re-inline it.
 */
export function trackedArtifacts<T extends TrackableArtifact>(
  artifacts: T[],
  manualIncludes: Array<{ path: string }>,
  manualExcludes: string[] = [],
  projectRoot = ''
): T[] {
  const included = new Set(manualIncludes.map((i) => canonicalize(i.path, null)));
  const excluded = new Set(manualExcludes.map((p) => canonicalize(p, null)));
  const rootCanon = projectRoot ? canonicalize(projectRoot, null) : '';

  const absoluteKey = (a: TrackableArtifact): string | null => {
    if (a.kind === 'internal') {
      if (!rootCanon) return null; // no root supplied — can't build an absolute key
      return canonicalize(`${rootCanon}/${a.path.replace(/\\/g, '/')}`, null);
    }
    return a.absolutePath ? canonicalize(a.absolutePath, null) : null;
  };

  return artifacts.filter((a) => {
    const key = absoluteKey(a);
    if (key && included.has(key)) return true;   // rule 1 — pinned wins
    if (key && excluded.has(key)) return false;  // rule 2 — hidden
    if (a.kind !== 'internal') return false;     // rule 4 — externals need a pin
    // rule 3 — internal: Claude's work only (any non-read version)
    return (a.versions ?? []).some((v) => v.type !== 'read');
  });
}
