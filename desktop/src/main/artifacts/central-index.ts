import { promises as fs } from 'fs';
import { join } from 'path';
import {
  CentralIndex, CentralIndexProject, INDEX_SCHEMA_VERSION,
} from '../../shared/artifacts/types';
import { casWrite } from './cas-write';

export const INDEX_FILE = 'youcoded-projects-index.json';

const MAX_RETRIES = 5;

export async function readIndex(claudeDir: string): Promise<CentralIndex> {
  const path = join(claudeDir, INDEX_FILE);
  try {
    const raw = await fs.readFile(path, 'utf8');
    return JSON.parse(raw) as CentralIndex;
  } catch (e: any) {
    if (e.code === 'ENOENT') {
      return { $schema: INDEX_SCHEMA_VERSION, projects: [] };
    }
    throw e;
  }
}

async function writeIndex(claudeDir: string, index: CentralIndex) {
  // Best-effort write without CAS for v1 — index contention is rare
  const path = join(claudeDir, INDEX_FILE);
  await casWrite(path, null, JSON.stringify(index, null, 2));
}

export async function upsertProject(
  claudeDir: string,
  project: CentralIndexProject
): Promise<void> {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const idx = await readIndex(claudeDir);
    const i = idx.projects.findIndex((p) => p.id === project.id);
    if (i >= 0) idx.projects[i] = project;
    else idx.projects.push(project);
    try {
      await writeIndex(claudeDir, idx);
      return;
    } catch (e) {
      if (attempt === MAX_RETRIES - 1) throw e;
    }
  }
}

export async function removeProject(claudeDir: string, projectId: string): Promise<void> {
  const idx = await readIndex(claudeDir);
  idx.projects = idx.projects.filter((p) => p.id !== projectId);
  await writeIndex(claudeDir, idx);
}

export async function listProjects(claudeDir: string): Promise<CentralIndexProject[]> {
  const idx = await readIndex(claudeDir);
  return idx.projects;
}
