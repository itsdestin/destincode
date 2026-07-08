import { promises as fs } from 'fs';
import { join, dirname, extname } from 'path';
import { ProjectSidecar } from '../../shared/artifacts/types';
import { newArtifactId, newVersionId } from '../../shared/artifacts/ulid';
import { SIDECAR_SCHEMA_VERSION } from '../../shared/artifacts/types';
import { casWrite } from './cas-write';

export const SIDECAR_RELATIVE = '.youcoded/artifacts.json';

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

export async function writeSidecar(
  projectRoot: string,
  expectedUpdatedAt: string | null,
  next: ProjectSidecar
): Promise<{ committed: boolean }> {
  const path = join(projectRoot, SIDECAR_RELATIVE);
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
