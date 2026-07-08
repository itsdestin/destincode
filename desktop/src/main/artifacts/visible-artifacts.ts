import { canonicalize } from '../../shared/artifacts/canonicalize';

interface TrackableArtifact {
  kind: string;
  path: string;
  absolutePath?: string | null;
  versions?: Array<{ type: string }>;
}

/**
 * Single predicate for which sidecar artifacts are TRACKED-visible — i.e. what
 * the Artifacts tab and its counts show. The rules:
 *
 *   1. Manually INCLUDED ("+ Add file") → always visible, any kind. Includes
 *      WIN over excludes, so "+ Add file" is also the recovery path for a
 *      mistaken Exclude.
 *   2. Manually EXCLUDED → hidden, any kind.
 *   3. Internal files → visible only with at least one NON-READ version
 *      (create/edit/delete = Claude's actual work, or a user save). A file
 *      that was merely VIEWED via a pill click ('read' versions only) does NOT
 *      belong in "files Claude made" — it stays in All files and the session
 *      drawer (an activity log, where "viewed" is at home).
 *   4. External files → hidden unless included (rule 1).
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
