import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MAX_IMPORT_FILE_COUNT } from '../src/main/sync-spaces/guards';
import { ccProjectSlug } from '../src/main/project-conversations';
import { upsertProject, remapProjectPath, listProjects } from '../src/main/artifacts/central-index';
import { canonicalize } from '../src/shared/artifacts/canonicalize';
import { checkImport, countFilesBounded } from '../src/main/sync-spaces/import-project';

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

describe('countFilesBounded', () => {
  it('counts regular files and skips DEFAULT_IGNORES dirs', () => {
    const root = path.join(tmp, 'proj');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'a.txt'), 'a');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), 'b');
    fs.writeFileSync(path.join(root, 'node_modules', 'x', 'huge.js'), 'x');
    expect(countFilesBounded(root, 100)).toBe(2);
  });

  it('stops early once the limit is exceeded', () => {
    const root = path.join(tmp, 'many');
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < 10; i++) fs.writeFileSync(path.join(root, `f${i}.txt`), 'x');
    expect(countFilesBounded(root, 3)).toBe(4); // limit+1: enough to know it's over
  });
});

describe('checkImport', () => {
  function ctx(over: Partial<Parameters<typeof checkImport>[0]> = {}) {
    const youcodedRoot = path.join(tmp, 'YouCoded');
    const projectsRoot = path.join(youcodedRoot, 'Projects');
    fs.mkdirSync(projectsRoot, { recursive: true });
    const source = path.join(tmp, 'mywork');
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(path.join(source, 'notes.md'), 'hi');
    return { sourcePath: source, name: 'mywork', projectsRoot, youcodedRoot, liveCwds: [] as string[], ...over };
  }

  it('passes for a plain folder', () => {
    expect(checkImport(ctx())).toBeNull();
  });

  it('rejects a missing source', () => {
    expect(checkImport(ctx({ sourcePath: path.join(tmp, 'ghost') }))).toMatch(/no longer exists/);
  });

  it('rejects a file source', () => {
    const f = path.join(tmp, 'file.txt');
    fs.writeFileSync(f, 'x');
    expect(checkImport(ctx({ sourcePath: f }))).toMatch(/file, not a folder/);
  });

  it('passes validateSyncName failures through verbatim', () => {
    expect(checkImport(ctx({ name: 'bad:name' }))).toMatch(/character not allowed/);
  });

  it('rejects a source already inside ~/YouCoded', () => {
    const c = ctx();
    const inside = path.join(c.youcodedRoot, 'Personal', 'notes');
    fs.mkdirSync(inside, { recursive: true });
    expect(checkImport({ ...c, sourcePath: inside })).toMatch(/already inside your YouCoded folder/);
  });

  it('rejects a source that CONTAINS ~/YouCoded (would move the destination into itself)', () => {
    const c = ctx();
    expect(checkImport({ ...c, sourcePath: tmp, name: 'everything' })).toMatch(/contains your YouCoded folder/);
  });

  it('rejects when the destination name is taken', () => {
    const c = ctx();
    fs.mkdirSync(path.join(c.projectsRoot, 'mywork'), { recursive: true });
    expect(checkImport(c)).toMatch(/already exists/);
  });

  it('rejects while a live session has its cwd inside the source', () => {
    const c = ctx();
    expect(checkImport({ ...c, liveCwds: [path.join(c.sourcePath, 'sub')] })).toMatch(/session is currently open/);
    expect(checkImport({ ...c, liveCwds: [c.sourcePath] })).toMatch(/session is currently open/);
    expect(checkImport({ ...c, liveCwds: [path.join(tmp, 'elsewhere')] })).toBeNull();
  });
});
