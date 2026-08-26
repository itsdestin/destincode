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

/**
 * Coalesced twins of ensureProject / applyGitTreatment for the hot path.
 *
 * WHY (2026-08-15, same incident as the append queue in artifact-store.ts):
 * the artifact tracker calls APPEND_VERSION once per Write/Edit/Read it sees,
 * and a replayed conversation delivers ~1,000 of those at once. Both helpers
 * are idempotent, but they are not free — ensureProject reads AND rewrites the
 * central projects index under the mkdir lock (LOCK_MAX_WAIT_MS = 3 s, so a
 * thousand waiters mostly time out), applyGitTreatment reads .gitignore. Doing
 * that a thousand times per open is pure waste: the answer for a given
 * (project, session) does not change from one tool call to the next.
 *
 * Concurrent callers share ONE in-flight promise; later callers within TTL
 * reuse the settled answer. A rejection is not cached (the next caller retries).
 * The TTLs are short — this is a burst absorber, not a cache the rest of the
 * app can rely on: `lastSession`/`lastIndexed` in the index may lag by up to
 * ENSURE_PROJECT_TTL_MS, which nothing user-facing reads at that granularity.
 */
const ENSURE_PROJECT_TTL_MS = 30_000;
const GIT_TREATMENT_TTL_MS = 60_000;
interface Memo<T> { at: number; value: Promise<T>; }
const ensureProjectMemo = new Map<string, Memo<EnsureProjectResult>>();
const gitTreatmentMemo = new Map<string, Memo<void>>();

function memoized<T>(
  cache: Map<string, Memo<T>>,
  key: string,
  ttlMs: number,
  now: number,
  compute: () => Promise<T>
): Promise<T> {
  const hit = cache.get(key);
  if (hit && now - hit.at < ttlMs) return hit.value;
  const value = compute();
  const entry: Memo<T> = { at: now, value };
  cache.set(key, entry);
  // A failure must not poison the window — drop it so the next caller retries.
  value.catch(() => { if (cache.get(key) === entry) cache.delete(key); });
  return value;
}

export function ensureProjectCoalesced(
  claudeDir: string,
  projectRoot: string,
  sessionId: string,
  now: number = Date.now()
): Promise<EnsureProjectResult> {
  return memoized(
    ensureProjectMemo,
    `${claudeDir}\0${projectRoot}\0${sessionId}`,
    ENSURE_PROJECT_TTL_MS,
    now,
    () => ensureProject(claudeDir, projectRoot, sessionId)
  );
}

export function applyGitTreatmentCoalesced(projectRoot: string, now: number = Date.now()): Promise<void> {
  return memoized(gitTreatmentMemo, projectRoot, GIT_TREATMENT_TTL_MS, now, () => applyGitTreatment(projectRoot));
}

/** Tests only — forget every memoized answer. */
export function resetProjectMemosForTests(): void {
  ensureProjectMemo.clear();
  gitTreatmentMemo.clear();
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
// computed live in LIST_PROJECTS_INDEX). The Kotlin mirrors were pruned
// 2026-08-22.
