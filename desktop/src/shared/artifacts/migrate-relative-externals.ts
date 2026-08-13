// One-time repair for sidecar records written before the 2026-08-12
// resolveTrackedPath fix, which stored a RELATIVE string in `absolutePath` — a
// field contractually absolute. Consumers hand that to realpath/fs.access/File(),
// which resolve it against the PROCESS cwd, so files that exist in the project
// render as "no longer on disk".
//
// WHY this re-runs resolveTrackedPath rather than implementing its own rules:
// the classifier already knows every case (relative → internal, cross-OS remap
// via the project-root segment, genuinely-external passthrough). Reusing it
// makes the repair correct BY CONSTRUCTION and keeps the two from drifting.
// It also means no filesystem access is needed — the 8 legacy records pointing
// outside any project root are left alone for free, because the cross-OS remap
// only fires when it finds the project-root basename as a path segment.
//
// Pure (no fs/path/os) so the merge logic is unit-testable and so this can
// never touch a live sidecar by accident. `reclassified` doubles as the caller's
// run-once gate — see runSidecarMigration in main/artifacts/artifact-store.ts.
import type { ProjectSidecar, ArtifactRecord, VersionEvent } from './types';
import { resolveTrackedPath } from './resolve-tracked-path';

export interface MigrationResult {
  sidecar: ProjectSidecar;
  reclassified: number;
  merged: number;
}

/** ULIDs sort lexicographically by creation time, so the smaller id is older. */
function older(a: ArtifactRecord, b: ArtifactRecord): ArtifactRecord {
  return a.id <= b.id ? a : b;
}

function mergeVersions(a: VersionEvent[], b: VersionEvent[]): VersionEvent[] {
  const byId = new Map<string, VersionEvent>();
  for (const v of [...a, ...b]) byId.set(v.id, v);   // dedup — re-runs cannot duplicate history
  return [...byId.values()].sort((x, y) => x.ts.localeCompare(y.ts));
}

/** `status` is a cache derived from the latest version (types.ts). */
function statusFrom(versions: VersionEvent[], fallback: ArtifactRecord['status']) {
  const last = versions[versions.length - 1];
  if (!last) return fallback;
  return last.type === 'delete' ? 'deleted' : 'active';
}

function mergeRecords(keep: ArtifactRecord, drop: ArtifactRecord): ArtifactRecord {
  const versions = mergeVersions(keep.versions, drop.versions);
  return {
    ...keep,
    kind: 'internal',
    absolutePath: null,
    versions,
    status: statusFrom(versions, keep.status),
    lastModified: keep.lastModified >= drop.lastModified ? keep.lastModified : drop.lastModified,
    tags: [...new Set([...keep.tags, ...drop.tags])],
    comments: [...keep.comments, ...drop.comments],
  };
}

export function migrateRelativeExternals(
  sidecar: ProjectSidecar,
  projectRoot: string
): MigrationResult {
  let reclassified = 0;
  let merged = 0;

  // Internal records indexed by path — the collision targets. 10 of the 18 real
  // relative-external records land on one of these, so a plain field rewrite
  // would leave two internal records at the same path with split histories.
  // Keys are RAW, not canonicalized — see the task's "Path matching is raw" note.
  const byPath = new Map<string, ArtifactRecord>();
  const out: ArtifactRecord[] = [];

  for (const a of sidecar.artifacts) {
    if (a.kind === 'internal') {
      byPath.set(a.path, a);
      out.push(a);
    }
  }

  for (const a of sidecar.artifacts) {
    if (a.kind === 'internal') continue;
    if (a.absolutePath === null) { out.push(a); continue; }

    const resolved = resolveTrackedPath(a.absolutePath, projectRoot);
    if (resolved.kind !== 'internal') { out.push(a); continue; }   // genuinely external — untouched

    reclassified++;
    const existing = byPath.get(resolved.path);
    if (existing) {
      // Merge into whichever record is older; it keeps the id most likely to be
      // referenced by an open draft or the current selection. The merged record
      // replaces `existing` IN PLACE regardless of which id wins, so ordering is
      // stable and a later external resolving to the same path finds it here.
      const keep = older(existing, a);
      const drop = keep === existing ? a : existing;
      const mergedRec = mergeRecords({ ...keep, path: resolved.path }, drop);
      const idx = out.indexOf(existing);
      out.splice(idx, 1, mergedRec);
      byPath.set(resolved.path, mergedRec);
      merged++;
    } else {
      // BOTH fields must change: `path` holds the basename for externals but the
      // root-relative path for internals. Changing one without the other yields
      // join(root, basename) — a real orphan in place of a false one.
      const converted: ArtifactRecord = {
        ...a, kind: 'internal', path: resolved.path, absolutePath: null,
      };
      out.push(converted);
      byPath.set(resolved.path, converted);
    }
  }

  return { sidecar: { ...sidecar, artifacts: out }, reclassified, merged };
}
