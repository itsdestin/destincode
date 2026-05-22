import { promises as fs } from 'fs';
import { join } from 'path';
import { ProjectSidecar } from '../../shared/artifacts/types';
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
