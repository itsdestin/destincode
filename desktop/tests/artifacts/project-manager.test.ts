import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  ensureProject,
  applyGitTreatment,
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
