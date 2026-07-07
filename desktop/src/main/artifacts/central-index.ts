import { promises as fs } from 'fs';
import { join } from 'path';
import {
  CentralIndex, CentralIndexProject, INDEX_SCHEMA_VERSION,
} from '../../shared/artifacts/types';
import { mutateFileUnderLock } from './cas-write';

export const INDEX_FILE = 'youcoded-projects-index.json';

const MAX_RETRIES = 5;

function parseIndex(raw: string | null): CentralIndex {
  if (raw === null) return { $schema: INDEX_SCHEMA_VERSION, projects: [] };
  return JSON.parse(raw) as CentralIndex;
}

export async function readIndex(claudeDir: string): Promise<CentralIndex> {
  const path = join(claudeDir, INDEX_FILE);
  try {
    const raw = await fs.readFile(path, 'utf8');
    return parseIndex(raw);
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return { $schema: INDEX_SCHEMA_VERSION, projects: [] };
    }
    throw e;
  }
}

// The index has no per-entry version field, so the lost-update guard is a
// read-modify-write performed entirely INSIDE the file lock (mutateFileUnderLock).
// The previous shape — read outside the lock, then a CAS-less casWrite — let two
// interleaved writers (two async tasks, or the dev + built app sharing
// ~/.claude) both read v0 and have the second write clobber the first's project
// entry. Retries only cover lock-acquisition timeouts now.
async function mutateIndex(
  claudeDir: string,
  mutate: (idx: CentralIndex) => void
): Promise<void> {
  const path = join(claudeDir, INDEX_FILE);
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const ok = await mutateFileUnderLock(path, (raw) => {
      const idx = parseIndex(raw);
      mutate(idx);
      return JSON.stringify(idx, null, 2);
    });
    if (ok) return;
  }
  throw new Error(`central-index: could not acquire lock for ${path}`);
}

export async function upsertProject(
  claudeDir: string,
  project: CentralIndexProject
): Promise<void> {
  await mutateIndex(claudeDir, (idx) => {
    const i = idx.projects.findIndex((p) => p.id === project.id);
    if (i >= 0) idx.projects[i] = project;
    else idx.projects.push(project);
  });
}

export async function removeProject(claudeDir: string, projectId: string): Promise<void> {
  await mutateIndex(claudeDir, (idx) => {
    idx.projects = idx.projects.filter((p) => p.id !== projectId);
  });
}

export async function listProjects(claudeDir: string): Promise<CentralIndexProject[]> {
  const idx = await readIndex(claudeDir);
  return idx.projects;
}
