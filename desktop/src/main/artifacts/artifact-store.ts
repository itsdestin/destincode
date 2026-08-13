import { promises as fs, constants as fsConstants } from 'fs';
import { join, dirname, extname } from 'path';
import { ProjectSidecar } from '../../shared/artifacts/types';
import { newArtifactId, newVersionId } from '../../shared/artifacts/ulid';
import { SIDECAR_SCHEMA_VERSION } from '../../shared/artifacts/types';
import { casWrite } from './cas-write';
import { migrateRelativeExternals } from '../../shared/artifacts/migrate-relative-externals';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { isAbsoluteRecorded } from './write-authorization';

const SIDECAR_RELATIVE = '.youcoded/artifacts.json';

export type ReadResult = ProjectSidecar | null | { corrupted: true };

export async function readSidecar(projectRoot: string): Promise<ReadResult> {
  const path = join(projectRoot, SIDECAR_RELATIVE);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (e: any) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
  try {
    return JSON.parse(raw) as ProjectSidecar;
  } catch {
    // Corruption detected: back up the file and signal recovery
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await fs.copyFile(path, `${path}.bak.${ts}`);
    return { corrupted: true };
  }
}

/**
 * Advance `updatedAt` past `expected` when the two would collide.
 *
 * Fix (lost update): `updatedAt` is the CAS comparand, and it is a
 * millisecond-resolution ISO timestamp. Two writers landing inside the SAME
 * millisecond used to leave the on-disk token byte-identical to the value a
 * concurrent reader had already read — so that reader's CAS check passed on a
 * value that had in fact changed underneath it (classic ABA) and its stale copy
 * clobbered the other writer's record. Both callers got `committed: true` and
 * one artifact silently vanished; measured at ~50% of same-millisecond pairs.
 *
 * Guaranteeing the written token is strictly greater than the one the writer
 * read makes every successful write strictly increase the on-disk token (a
 * commit only happens when on-disk === expected). A stale reader can then never
 * match, so ABA is impossible. The +1ms floor also makes this robust to a
 * backwards wall-clock jump, which a plain `now` comparand is not.
 *
 * Compares PARSED times, not strings. toISOString() output is fixed-width, but
 * a sidecar synced from Android carries Java Instant.toString(), which omits
 * trailing zero sub-second digits ("…:36Z") — so lexicographic comparison would
 * be wrong on exactly the cross-device files this guard has to protect.
 * Unparseable input (hand-edited sidecar) falls through untouched rather than
 * throwing; the CAS check itself still rejects the write.
 */
function bumpPastExpected(candidate: string, expected: string | null): string {
  if (expected === null) return candidate;
  const expMs = Date.parse(expected);
  const candMs = Date.parse(candidate);
  if (Number.isNaN(expMs) || Number.isNaN(candMs)) return candidate;
  if (candMs > expMs) return candidate;
  return new Date(expMs + 1).toISOString();
}

export async function writeSidecar(
  projectRoot: string,
  expectedUpdatedAt: string | null,
  next: ProjectSidecar
): Promise<{ committed: boolean }> {
  const path = join(projectRoot, SIDECAR_RELATIVE);
  // Enforced HERE rather than in each caller so every sidecar writer inherits
  // it (appendVersion, removeArtifactRecord, renameArtifact, the ipc-handlers
  // manualIncludes/excludes paths, and sync-spaces import-project).
  //
  // This mutates `next`, so on a COMMITTED write the caller's in-memory object
  // matches disk. On a CAS conflict it does not — `next` then carries a
  // timestamp that was never written. Every caller re-reads the sidecar before
  // retrying rather than reusing the object, so nothing observes that; a future
  // caller that retries with the same object must re-read too.
  next.updatedAt = bumpPastExpected(next.updatedAt, expectedUpdatedAt);
  const json = JSON.stringify(next, null, 2);
  const result = await casWrite(
    path,
    expectedUpdatedAt,
    json,
    expectedUpdatedAt === null ? undefined : (raw) => JSON.parse(raw).updatedAt
  );
  return { committed: result.committed };
}

const MAX_RETRIES = 5;

export interface AppendVersionInput {
  path: string;            // canonical
  kind: 'internal' | 'external';
  absolutePath: string | null;
  sessionId: string;
  type: 'create' | 'edit' | 'delete' | 'read';
  author: 'agent' | 'user';
}

export async function appendVersion(
  projectRoot: string,
  projectId: string,
  projectName: string,
  input: AppendVersionInput
): Promise<{ committed: boolean; artifactId: string | null }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await readSidecar(projectRoot);
    let sidecar: ProjectSidecar;
    let expectedUpdatedAt: string | null;
    if (current === null) {
      const now = new Date().toISOString();
      sidecar = {
        $schema: SIDECAR_SCHEMA_VERSION,
        projectId,
        name: projectName,
        createdAt: now,
        updatedAt: now,
        artifacts: [],
        manualExcludes: [],
        manualIncludes: [],
      };
      expectedUpdatedAt = null;
    } else if ('corrupted' in current) {
      const now = new Date().toISOString();
      sidecar = {
        $schema: SIDECAR_SCHEMA_VERSION,
        projectId,
        name: projectName,
        createdAt: now,
        updatedAt: now,
        artifacts: [],
        manualExcludes: [],
        manualIncludes: [],
      };
      expectedUpdatedAt = null;
    } else {
      sidecar = current;
      expectedUpdatedAt = sidecar.updatedAt;
    }

    const existing = sidecar.artifacts.find(
      (a) => a.path === input.path && a.kind === input.kind
    );
    const now = new Date().toISOString();
    const versionEvent = {
      id: newVersionId(),
      ts: now,
      sessionId: input.sessionId,
      type: input.type,
      author: input.author,
    };
    let artifactId: string;
    if (existing) {
      existing.versions.push(versionEvent);
      // A 'read' is not a modification — bumping lastModified for a view
      // reordered "recently modified" sorting every time a pill was clicked.
      // (New records below still get lastModified = now: that's record
      // creation, and the UI labels read-only records "viewed".)
      if (input.type !== 'read') existing.lastModified = now;
      existing.status = input.type === 'delete' ? 'deleted' : 'active';
      artifactId = existing.id;
    } else {
      artifactId = newArtifactId();
      sidecar.artifacts.push({
        id: artifactId,
        path: input.path,
        kind: input.kind,
        absolutePath: input.absolutePath,
        lastModified: now,
        status: input.type === 'delete' ? 'deleted' : 'active',
        versions: [versionEvent],
        comments: [],
        tags: [],
      });
    }
    sidecar.updatedAt = now;

    const result = await writeSidecar(projectRoot, expectedUpdatedAt, sidecar);
    if (result.committed) return { committed: true, artifactId };
    await sleep(10 * (attempt + 1));
  }
  return { committed: false, artifactId: null };
}

/**
 * Remove an artifact RECORD from the sidecar (the tracking entry, never the
 * file on disk). Powers the Session Drawer's per-row remove: clears accidental
 * pill-click "artifactifies" and dead orphan rows. If Claude edits the file
 * again a fresh record is created — removal is not a permanent opt-out (that's
 * what manualExcludes is for).
 */
export async function removeArtifactRecord(
  projectRoot: string,
  artifactId: string
): Promise<{ ok: boolean; error?: string }> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const current = await readSidecar(projectRoot);
    if (current === null || 'corrupted' in current) return { ok: false, error: 'sidecar-missing' };
    const idx = current.artifacts.findIndex((a) => a.id === artifactId);
    if (idx === -1) return { ok: false, error: 'artifact-not-found' };
    const expectedUpdatedAt = current.updatedAt;
    current.artifacts.splice(idx, 1);
    current.updatedAt = new Date().toISOString();
    const result = await writeSidecar(projectRoot, expectedUpdatedAt, current);
    if (result.committed) return { ok: true };
    await sleep(10 * (attempt + 1));
  }
  return { ok: false, error: 'write-conflict' };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Project roots already checked in THIS process. The migration is safe to call
// from hot handlers (LIST_SESSION fires after every tracked write), and the
// pure pass over a 2,800-record array is cheap — but it is not free, and there
// is no reason to redo it every call.
//
// Process-lifetime, deliberately: the sidecar (.youcoded/artifacts.json) is
// per-device and NEVER synced — DEFAULT_IGNORES (sync-spaces/guards.ts) excludes
// .youcoded/ from the sync repo, and project-manager.ts separately adds it to
// the project's own .gitignore — so there is no cross-device write to catch up
// on. What the process-lifetime memo actually buys: a repair skipped by a
// transient failure (see the catch below) is retried automatically the next
// time this app launches, rather than being permanently missed by a persistent
// "already migrated" marker. That is the trade for having no such marker on
// disk — see the plan's design decision 2.
const migrationChecked = new Set<string>();

/**
 * One-time repair of relative-external records (see
 * shared/artifacts/migrate-relative-externals.ts).
 *
 * The run-once gate is `reclassified === 0`, NOT a $schema bump. appendVersion
 * round-trips $schema from disk, so a schema marker would say "repaired"
 * permanently once written, with no way to notice if a later bug (or a
 * hand-edited sidecar) reintroduced a relative-external record. The pure
 * function already tells us whether anything changed; nothing is written when
 * it hasn't.
 *
 * WHY here and not inside readSidecar: readSidecar is a hot path (every get,
 * save, and list call). A function that writes from inside a read is both
 * surprising and a lock-contention risk.
 */
export async function runSidecarMigration(
  projectRoot: string
): Promise<{ migrated: boolean; reclassified: number; merged: number }> {
  const NOTHING = { migrated: false, reclassified: 0, merged: 0 };
  // Fix: key the memo on the CANONICAL form, not the raw string. One IPC caller
  // (APPEND_VERSION's sibling handlers) passes the renderer's projectRoot as
  // typed/received, while two others (LIST_PROJECT, LIST_ALL_FILES) pass a path
  // resolved from the project index — a case- or separator-differing pair for
  // the SAME project would otherwise memo separately and re-run the migration a
  // second time (finding nothing, since the first run already repaired it, but
  // still paying the sidecar read + pure-pass cost). canonicalize() is already
  // how every other cache in this layer (project-watcher.ts's sidecarIdCache,
  // project-file-discovery.ts's cache) keys on project root for this exact
  // reason.
  const key = canonicalize(projectRoot, null);
  if (migrationChecked.has(key)) return NOTHING;

  // Fix: this best-effort repair runs INSIDE three handlers that were
  // read-only before this branch (LIST_SESSION, LIST_PROJECT, LIST_ALL_FILES)
  // and must fail closed rather than break the listing it precedes. The
  // fs.copyFile backup below only swallows EEXIST and rethrows everything
  // else, and writeSidecar's CAS write (casWrite -> atomicWrite) can throw
  // ENOSPC, EROFS, EACCES, or (on Windows, when antivirus holds the file)
  // EPERM. An uncaught rejection here propagates out of those IPC handlers;
  // FilesTab.tsx's `listAllFiles(...).then(...)` has no `.catch`, so an
  // unhandled rejection would leave its loading spinner stuck forever. Report
  // "nothing happened" instead, and memoize so a PERSISTENT failure (e.g. a
  // read-only filesystem) does not retry this same expensive, doomed work on
  // every subsequent list call in this process — the next app launch gets a
  // fresh memo and another attempt.
  try {
    // The sidecar is written continuously by the running app, so a CAS conflict
    // is a real (if rare) outcome. Mirror appendVersion: re-read and retry
    // rather than deferring to "some later project open", which for the
    // busiest project is the least likely to win.
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await readSidecar(projectRoot);
      if (current === null || 'corrupted' in current) {
        migrationChecked.add(key);
        return NOTHING;
      }

      const result = migrateRelativeExternals(current, projectRoot);
      if (result.reclassified === 0) {
        migrationChecked.add(key);   // nothing to do — don't re-scan this process
        return NOTHING;
      }

      // Back up before the first rewrite. This edits weeks of artifact history
      // in place; a copy is the only way back if the merge rule turns out wrong
      // for a record we did not anticipate. FIXED name, written only if
      // absent: a timestamped name would accumulate one file per retry and per
      // relapse.
      const sidecarPath = join(projectRoot, SIDECAR_RELATIVE);
      try {
        await fs.copyFile(sidecarPath, `${sidecarPath}.pre-migration.bak`, fsConstants.COPYFILE_EXCL);
      } catch (e: any) {
        if (e.code !== 'EEXIST') throw e;   // a backup already exists — keep the oldest
      }

      // CAS on the value we read: if another window wrote in between, re-read
      // and recompute rather than clobber.
      const next: ProjectSidecar = result.sidecar;
      const { committed } = await writeSidecar(projectRoot, current.updatedAt, next);
      if (committed) {
        migrationChecked.add(key);
        return { migrated: true, reclassified: result.reclassified, merged: result.merged };
      }
    }
    return NOTHING;   // three conflicts — do NOT memo; the next call retries
  } catch {
    migrationChecked.add(key);   // see the WHY block above — fail closed, don't retry every call
    return NOTHING;
  }
}

export interface RenameResult {
  ok: boolean;
  error?: string;
  newPath?: string;
}

// Rename an artifact's file on disk and update its sidecar record. `newBaseName`
// is the new filename WITHOUT extension — the original extension is preserved so
// the file type can't be changed by accident. Path-traversal names and
// collisions with an existing file are rejected.
//
// The file rename happens exactly ONCE (before the CAS-retry loop). Only the
// sidecar record update is retried, so a write conflict can never double-rename
// the file on disk (which would ENOENT the second time).
export async function renameArtifact(
  projectRoot: string,
  artifactId: string,
  newBaseName: string
): Promise<RenameResult> {
  const clean = newBaseName.trim();
  if (!clean || /[\\/]/.test(clean) || clean === '.' || clean === '..') {
    return { ok: false, error: 'invalid-name' };
  }

  // Validate + compute paths from a single read.
  const first = await readSidecar(projectRoot);
  if (first === null || 'corrupted' in first) return { ok: false, error: 'sidecar-missing' };
  const a0 = first.artifacts.find((a) => a.id === artifactId);
  if (!a0) return { ok: false, error: 'artifact-not-found' };

  const oldAbs = a0.kind === 'internal' ? join(projectRoot, a0.path) : (a0.absolutePath ?? '');
  // Fix: guard against a relative `absolutePath` here too — this is the FIFTH
  // site that builds a path from a record (write-authorization.ts's two
  // functions, artifacts:check-existence, and countArtifacts are the other
  // four). Unguarded, `oldAbs` resolves against the PROCESS cwd for the
  // fs.access/fs.rename calls below, so this could rename (or silently clobber)
  // a file OUTSIDE the project — a real filesystem mutation, not just a stale
  // read. Reachable permanently, not only in the pre-repair window: records
  // whose real path escapes the project root with `..` are deliberately left
  // external with a relative absolutePath by design, and the Session Drawer's
  // click-to-rename has no filter on record kind.
  if (a0.kind === 'external' && !isAbsoluteRecorded(oldAbs)) return { ok: false, error: 'no-path' };
  if (!oldAbs) return { ok: false, error: 'no-path' };
  const dir = dirname(oldAbs);
  const ext = extname(a0.path); // keep the original extension
  const newFilename = clean + ext;
  const newAbs = join(dir, newFilename);
  if (newAbs === oldAbs) return { ok: true, newPath: a0.path }; // no-op (same name)

  // Collision guard — never clobber an existing file.
  try {
    await fs.access(newAbs);
    return { ok: false, error: 'name-taken' };
  } catch { /* ENOENT — the name is free */ }

  // Rename on disk — once.
  try {
    await fs.rename(oldAbs, newAbs);
  } catch (e: any) {
    return { ok: false, error: e?.code === 'ENOENT' ? 'file-missing' : 'rename-failed' };
  }

  // Reflect the new path in the sidecar (CAS-retry; file is already moved).
  const relDir = a0.kind === 'internal' ? dirname(a0.path) : '';
  const newRelPath = a0.kind === 'internal'
    ? (relDir === '.' || relDir === '' ? newFilename : `${relDir.replace(/\\/g, '/')}/${newFilename}`)
    : newFilename;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const cur = await readSidecar(projectRoot);
    // File already moved; if the sidecar vanished/corrupted, report success on
    // the file op — a later listSession re-reads whatever the sidecar holds.
    if (cur === null || 'corrupted' in cur) return { ok: true, newPath: newRelPath };
    const art = cur.artifacts.find((a) => a.id === artifactId);
    if (!art) return { ok: true, newPath: newRelPath };

    const expectedUpdatedAt = cur.updatedAt;
    art.path = newRelPath;
    if (art.kind === 'external') art.absolutePath = newAbs.replace(/\\/g, '/');
    const now = new Date().toISOString();
    art.lastModified = now;
    cur.updatedAt = now;

    const result = await writeSidecar(projectRoot, expectedUpdatedAt, cur);
    if (result.committed) return { ok: true, newPath: newRelPath };
    await sleep(10 * (attempt + 1));
  }
  // Sustained contention only — the file IS renamed, so report success.
  return { ok: true, newPath: newRelPath };
}
