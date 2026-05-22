import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  readIndex,
  upsertProject,
  removeProject,
  listProjects,
} from '../../src/main/artifacts/central-index';
import { INDEX_SCHEMA_VERSION } from '../../src/shared/artifacts/types';

describe('central-index', () => {
  let claudeDir: string;
  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'ci-'));
  });

  it('returns an empty index when none exists', async () => {
    const idx = await readIndex(claudeDir);
    expect(idx).toEqual({ $schema: INDEX_SCHEMA_VERSION, projects: [] });
  });

  it('upserts a new project', async () => {
    await upsertProject(claudeDir, {
      id: 'p1', name: 'a', path: '/p/a',
      lastIndexed: '2026-01-01T00:00:00Z',
      lastSession: null, contentTypes: ['artifacts'],
      stats: { artifactCount: 0 },
    });
    const idx = await readIndex(claudeDir);
    expect(idx.projects).toHaveLength(1);
    expect(idx.projects[0].id).toBe('p1');
  });

  it('upserts overwrites an existing project by id', async () => {
    const base = {
      id: 'p1', name: 'a', path: '/p/a',
      lastIndexed: '2026-01-01T00:00:00Z',
      lastSession: null, contentTypes: ['artifacts'] as const,
      stats: { artifactCount: 0 },
    };
    await upsertProject(claudeDir, base);
    await upsertProject(claudeDir, { ...base, name: 'a-renamed', stats: { artifactCount: 5 } });
    const idx = await readIndex(claudeDir);
    expect(idx.projects).toHaveLength(1);
    expect(idx.projects[0].name).toBe('a-renamed');
    expect(idx.projects[0].stats.artifactCount).toBe(5);
  });

  it('removeProject removes by id', async () => {
    await upsertProject(claudeDir, {
      id: 'p1', name: 'a', path: '/p/a',
      lastIndexed: '2026-01-01T00:00:00Z',
      lastSession: null, contentTypes: ['artifacts'],
      stats: { artifactCount: 0 },
    });
    await removeProject(claudeDir, 'p1');
    const idx = await readIndex(claudeDir);
    expect(idx.projects).toHaveLength(0);
  });
});
