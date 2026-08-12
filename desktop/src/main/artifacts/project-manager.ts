import { promises as fs } from 'fs';
import { existsSync } from 'fs';
import { join, basename } from 'path';
import { canonicalize } from '../../shared/artifacts/canonicalize';
import { newProjectId } from '../../shared/artifacts/ulid';
import { readSidecar } from './artifact-store';
import { sweepStaleTmp } from './cas-write';
import { readIndex, upsertProject } from './central-index';
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
  // pid+time-suffixed temp name: two processes writing the same .gitignore
  // must not race the same .tmp — the loser's rename would ENOENT. The tmp
  // lands in the USER'S project root, so sweep crash orphans first and unlink
  // our own tmp on failure — a pid+time name is never overwritten by the next
  // write, so a strand would linger forever (git status noise, Files UI).
  await sweepStaleTmp(projectRoot, '.gitignore');
  const tmpPath = `${gitignorePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tmpPath, next, 'utf8');
    await fs.rename(tmpPath, gitignorePath);
  } catch (e) {
    try { await fs.unlink(tmpPath); } catch { /* already gone */ }
    throw e;
  }
}

// NOTE: detectOrphan / rebuildIndex were removed in the 2026-07-10 dead-code
// sweep — no production caller ever invoked them (orphan detection happens
// live in the drawer/badge via checkExistence, and the sidebar count is
// computed live in LIST_PROJECTS_INDEX). The Kotlin mirrors in
// ProjectManager.kt still exist and should be pruned in an Android session.
