import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, promises as fsPromises } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureProject,
  applyGitTreatment,
  ensureProjectCoalesced,
  applyGitTreatmentCoalesced,
  resetProjectMemosForTests,
} from '../../src/main/artifacts/project-manager';
import { readIndex } from '../../src/main/artifacts/central-index';

describe('ensureProject', () => {
  let claudeDir: string;
  let projectRoot: string;
  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'pm-claude-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'pm-proj-'));
  });

  it('creates a new project entry in the index when path is unknown and no sidecar exists', async () => {
    const result = await ensureProject(claudeDir, projectRoot, 'sess-1');
    expect(result.created).toBe(true);
    const idx = await readIndex(claudeDir);
    expect(idx.projects).toHaveLength(1);
    // Sidecar NOT yet written (lazy)
    expect(existsSync(join(projectRoot, '.youcoded'))).toBe(false);
  });

  it('updates lastSession when path is already known', async () => {
    await ensureProject(claudeDir, projectRoot, 'sess-1');
    const result = await ensureProject(claudeDir, projectRoot, 'sess-2');
    expect(result.created).toBe(false);
    const idx = await readIndex(claudeDir);
    expect(idx.projects[0].lastSession).toBe('sess-2');
  });

  it('auto-recovers when sidecar exists at the path (project-moved case)', async () => {
    mkdirSync(join(projectRoot, '.youcoded'));
    writeFileSync(
      join(projectRoot, '.youcoded/artifacts.json'),
      JSON.stringify({
        $schema: 1, projectId: 'pre-existing', name: 'foo',
        createdAt: 'x', updatedAt: 'x',
        artifacts: [], manualExcludes: [], manualIncludes: [],
      })
    );
    const result = await ensureProject(claudeDir, projectRoot, 'sess-1');
    const idx = await readIndex(claudeDir);
    expect(idx.projects[0].id).toBe('pre-existing');
  });
});

describe('applyGitTreatment', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'pm-git-'));
  });

  it('does nothing in a non-git directory', async () => {
    await applyGitTreatment(projectRoot);
    expect(existsSync(join(projectRoot, '.gitignore'))).toBe(false);
  });

  it('creates .gitignore with .youcoded/ in a git repo with no existing .gitignore', async () => {
    mkdirSync(join(projectRoot, '.git'));
    await applyGitTreatment(projectRoot);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf8')).toContain('.youcoded/');
  });

  it('appends to an existing .gitignore without duplicating', async () => {
    mkdirSync(join(projectRoot, '.git'));
    writeFileSync(join(projectRoot, '.gitignore'), 'node_modules\n');
    await applyGitTreatment(projectRoot);
    const content = readFileSync(join(projectRoot, '.gitignore'), 'utf8');
    expect(content).toMatch(/node_modules/);
    expect(content).toMatch(/\.youcoded\//);

    // Idempotent
    await applyGitTreatment(projectRoot);
    const occurrences = (readFileSync(join(projectRoot, '.gitignore'), 'utf8').match(/\.youcoded\//g) || []).length;
    expect(occurrences).toBe(1);
  });
});

// 2026-08-15 OOM incident: the APPEND_VERSION handler ran ensureProject +
// applyGitTreatment once per tracked tool call, and a replayed conversation
// delivers ~1,000 of those at once — a thousand index rewrites queued on a
// 3-second mkdir lock. The coalesced twins answer a burst with one real call.
describe('ensureProjectCoalesced / applyGitTreatmentCoalesced', () => {
  let claudeDir: string;
  let projectRoot: string;
  beforeEach(() => {
    resetProjectMemosForTests();
    claudeDir = mkdtempSync(join(tmpdir(), 'pmc-claude-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'pmc-proj-'));
  });
  afterEach(() => { vi.restoreAllMocks(); resetProjectMemosForTests(); });

  it('a burst of 200 concurrent ensureProject calls for one (project, session) rewrites the index once', async () => {
    const writes = vi.spyOn(fsPromises, 'writeFile');
    const results = await Promise.all(
      Array.from({ length: 200 }, () => ensureProjectCoalesced(claudeDir, projectRoot, 'sess-1'))
    );
    expect(new Set(results.map((r) => r.project.id)).size).toBe(1);
    const indexWrites = writes.mock.calls.filter((c) => String(c[0]).includes('.tmp')).length;
    expect(indexWrites).toBe(1);
    const idx = await readIndex(claudeDir);
    expect(idx.projects).toHaveLength(1);
  });

  it('a different session is NOT coalesced with the first (lastSession must move)', async () => {
    await ensureProjectCoalesced(claudeDir, projectRoot, 'sess-1');
    await ensureProjectCoalesced(claudeDir, projectRoot, 'sess-2');
    const idx = await readIndex(claudeDir);
    expect(idx.projects[0].lastSession).toBe('sess-2');
  });

  it('after the TTL the real call runs again', async () => {
    const t0 = 1_000_000;
    await ensureProjectCoalesced(claudeDir, projectRoot, 'sess-1', t0);
    const spy = vi.spyOn(fsPromises, 'writeFile');
    await ensureProjectCoalesced(claudeDir, projectRoot, 'sess-1', t0 + 1_000);
    expect(spy).not.toHaveBeenCalled();
    await ensureProjectCoalesced(claudeDir, projectRoot, 'sess-1', t0 + 60_000);
    expect(spy.mock.calls.filter((c) => String(c[0]).includes('.tmp')).length).toBe(1);
  });

  it('a failure is not cached — the next caller retries', async () => {
    const spy = vi.spyOn(fsPromises, 'readFile').mockRejectedValueOnce(Object.assign(new Error('EIO'), { code: 'EIO' }));
    await expect(ensureProjectCoalesced(claudeDir, projectRoot, 'sess-1')).rejects.toThrow('EIO');
    spy.mockRestore();
    const r = await ensureProjectCoalesced(claudeDir, projectRoot, 'sess-1');
    expect(r.project.id).toBeTruthy();
  });

  it('applyGitTreatmentCoalesced reads .gitignore once per burst and still writes the entry', async () => {
    mkdirSync(join(projectRoot, '.git'));
    const reads = vi.spyOn(fsPromises, 'readFile');
    await Promise.all(Array.from({ length: 100 }, () => applyGitTreatmentCoalesced(projectRoot)));
    expect(reads.mock.calls.filter((c) => String(c[0]).endsWith('.gitignore')).length).toBe(1);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf8')).toContain('.youcoded/');
  });
});
