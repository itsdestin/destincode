import { canonicalize } from '../../shared/artifacts/canonicalize';

/**
 * Single predicate for which sidecar artifacts are TRACKED-visible: internal
 * always; external only when manually included.
 *
 * Canonicalizes BOTH sides of the include comparison. manualIncludes[].path is
 * stored canonical (forward slashes, lowercased drive) by INCLUDE_EXTERNAL,
 * while an artifact's absolutePath is stored raw by the tracker (CC hands an
 * uppercase drive on Windows, e.g. C:/…). A raw Set.has() therefore ALWAYS
 * missed on Windows — external artifacts the user explicitly "Add file"-ed
 * silently vanished from counts and the project browser. This helper is the
 * one place that comparison happens; don't re-inline it at call sites.
 */
export function trackedArtifacts<T extends { kind: string; absolutePath?: string | null }>(
  artifacts: T[],
  manualIncludes: Array<{ path: string }>
): T[] {
  const included = new Set(manualIncludes.map((i) => canonicalize(i.path, null)));
  return artifacts.filter(
    (a) =>
      a.kind === 'internal' ||
      (a.kind === 'external' && !!a.absolutePath && included.has(canonicalize(a.absolutePath!, null)))
  );
}
