import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MAX_IMPORT_FILE_COUNT } from '../src/main/sync-spaces/guards';
import { ccProjectSlug } from '../src/main/project-conversations';
import { upsertProject, remapProjectPath, listProjects } from '../src/main/artifacts/central-index';
import { canonicalize } from '../src/shared/artifacts/canonicalize';

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-import-')); });
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

describe('import enablers', () => {
  it('MAX_IMPORT_FILE_COUNT is a sane positive bound', () => {
    expect(MAX_IMPORT_FILE_COUNT).toBeGreaterThan(1000);
  });

  it('ccProjectSlug is exported and uppercases the drive before slugifying', () => {
    // On non-Windows paths this is a plain slugify; the drive-case rule only
    // fires on the ^[a-z]: prefix.
    expect(ccProjectSlug('c:/Users/x/proj')).toBe(ccProjectSlug('C:/Users/x/proj'));
  });

  it('remapProjectPath rewrites path (and name) of the entry matching the old canonical path', async () => {
    const oldRoot = path.join(tmp, 'oldproj');
    const newRoot = path.join(tmp, 'newproj');
    await upsertProject(tmp, {
      id: 'ULID1', name: 'oldproj', path: canonicalize(oldRoot, null),
      lastIndexed: new Date().toISOString(), lastSession: null,
      contentTypes: ['artifacts'], stats: { artifactCount: 3 },
    } as any);
    await remapProjectPath(tmp, canonicalize(oldRoot, null), canonicalize(newRoot, null), 'newproj');
    const projects = await listProjects(tmp);
    expect(projects).toHaveLength(1);
    expect(projects[0].path).toBe(canonicalize(newRoot, null));
    expect(projects[0].name).toBe('newproj');
    expect(projects[0].id).toBe('ULID1');            // identity survives the move
    expect(projects[0].stats.artifactCount).toBe(3); // stats survive the move
  });

  it('remapProjectPath is a no-op when no entry matches', async () => {
    await remapProjectPath(tmp, canonicalize(path.join(tmp, 'ghost'), null), canonicalize(path.join(tmp, 'x'), null));
    expect(await listProjects(tmp)).toEqual([]);
  });
});
