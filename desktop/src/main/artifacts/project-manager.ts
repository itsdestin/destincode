import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { newProjectId } from '../../shared/artifacts/ulid';
import { readSidecar } from './artifact-store';
import { readIndex, upsertProject, removeProject } from './central-index';
import { CentralIndexProject } from '../../shared/artifacts/types';

export interface EnsureProjectResult {
  project: CentralIndexProject;
  created: boolean;
}

export async function ensureProject(
  claudeDir: string,
  projectRoot: string,
  sessionId: string
): Promise<EnsureProjectResult> {
  const canonicalRoot = canonicalize(projectRoot, null);
  const now = new Date().toISOString();
  const idx = await readIndex(claudeDir);
  const existing = idx.projects.find((p) => p.path === canonicalRoot);

  if (existing) {
    const updated: CentralIndexProject = { ...existing, lastSession: sessionId, lastIndexed: now };
    await upsertProject(claudeDir, updated);
    return { project: updated, created: false };
  }

  // Check sidecar for auto-recovery
  const sidecar = await readSidecar(projectRoot);
  let projectId: string;
  let name: string;
  if (sidecar && 'projectId' in sidecar) {
    projectId = sidecar.projectId;
    name = sidecar.name;
  } else {
    projectId = newProjectId();
    name = basename(projectRoot);
  }

  const project: CentralIndexProject = {
    id: projectId,
    name,
    path: canonicalRoot,
    lastIndexed: now,
    lastSession: sessionId,
    contentTypes: ['artifacts'],
    stats: { artifactCount: 0 },
  };
  await upsertProject(claudeDir, project);
  return { project, created: true };
}

export async function applyGitTreatment(projectRoot: string): Promise<void> {
  if (!existsSync(join(projectRoot, '.git'))) return;
  const gitignorePath = join(projectRoot, '.gitignore');
  let current = '';
  try {
    current = await fs.readFile(gitignorePath, 'utf8');
  } catch (e: any) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (/^\.youcoded\/?\s*$/m.test(current)) return;
  const next = (current && !current.endsWith('\n') ? current + '\n' : current) + '.youcoded/\n';
  await fs.writeFile(gitignorePath + '.tmp', next, 'utf8');
  await fs.rename(gitignorePath + '.tmp', gitignorePath);
}

export async function detectOrphan(
  projectRoot: string,
  path: string,
  kind: 'internal' | 'external',
  absolutePath: string | null
): Promise<boolean> {
  // Determine the full path based on artifact kind
  const fullPath = kind === 'internal' ? join(projectRoot, path) : absolutePath!;
  // Return true if the file does not exist
  return !existsSync(fullPath);
}

export async function rebuildIndex(claudeDir: string): Promise<void> {
  // Read current index
  const idx = await readIndex(claudeDir);
  const survivingIds = new Set<string>();

  // Iterate over all projects and check if their sidecars still exist
  for (const p of idx.projects) {
    const sidecar = await readSidecar(p.path);
    // If sidecar exists and is well-formed (has projectId), keep the project
    if (sidecar && 'projectId' in sidecar) {
      // Refresh the project with updated stats
      const refreshed: CentralIndexProject = {
        ...p,
        stats: { artifactCount: sidecar.artifacts.length },
        lastIndexed: new Date().toISOString(),
      };
      await upsertProject(claudeDir, refreshed);
      survivingIds.add(p.id);
    }
  }

  // Remove projects whose sidecars were not found
  for (const p of idx.projects) {
    if (!survivingIds.has(p.id)) {
      await removeProject(claudeDir, p.id);
    }
  }
}
