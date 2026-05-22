import { promises as fs } from 'fs';
import { join } from 'path';
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
  type: 'create' | 'edit' | 'delete';
  author: 'agent' | 'user';
}

export async function appendVersion(
  projectRoot: string,
  projectId: string,
  projectName: string,
  input: AppendVersionInput
): Promise<{ committed: boolean }> {
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
    if (existing) {
      existing.versions.push(versionEvent);
      existing.lastModified = now;
      existing.status = input.type === 'delete' ? 'deleted' : 'active';
    } else {
      sidecar.artifacts.push({
        id: newArtifactId(),
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
    if (result.committed) return { committed: true };
    await sleep(10 * (attempt + 1));
  }
  return { committed: false };
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
