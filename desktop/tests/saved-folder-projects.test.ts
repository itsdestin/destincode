import { describe, it, expect } from 'vitest';
import { buildSavedFolderProjects } from '../src/main/artifacts/saved-folder-projects';
import type { CentralIndexProject } from '../src/shared/artifacts/types';

const indexed: CentralIndexProject = {
  id: '01HZ-REAL-ULID',
  name: 'Indexed Name',
  path: 'c:/Users/desti/youcoded-dev',
  lastIndexed: '2026-06-01T00:00:00.000Z',
  lastSession: '2026-06-10T00:00:00.000Z',
  contentTypes: ['artifacts'],
  stats: { artifactCount: 42 },
};

describe('buildSavedFolderProjects', () => {
  it('reuses the central-index entry (id + stats) when a saved folder matches by canonical path', () => {
    // Saved path uses a Windows uppercase drive + backslashes; the index path is
    // canonical (lowercase drive, forward slashes). They must still match.
    const result = buildSavedFolderProjects(
      [{ path: 'C:\\Users\\desti\\youcoded-dev', nickname: 'My Workspace', addedAt: 1 }],
      [indexed],
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('01HZ-REAL-ULID'); // real id preserved → artifact lookups resolve
    expect(result[0].stats.artifactCount).toBe(42);
    expect(result[0].name).toBe('My Workspace'); // user's nickname wins for display
  });

  it('synthesizes an entry (id = canonical path) for a saved folder with no index match', () => {
    const result = buildSavedFolderProjects(
      [{ path: 'C:\\Users\\desti\\notes', nickname: '', addedAt: 1 }],
      [indexed],
    );
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('c:/Users/desti/notes'); // synth id = canonical path
    expect(result[0].path).toBe('c:/Users/desti/notes');
    expect(result[0].name).toBe('notes'); // basename when no nickname
    expect(result[0].stats.artifactCount).toBe(0);
  });

  it('drops index projects that are not in the saved-folders list', () => {
    // Only the saved folder appears; the indexed-but-unsaved project is excluded.
    const result = buildSavedFolderProjects(
      [{ path: 'C:\\Users\\desti\\notes', nickname: 'Notes', addedAt: 1 }],
      [indexed],
    );
    expect(result.map((p) => p.path)).toEqual(['c:/Users/desti/notes']);
  });

  it('preserves saved-folder order and de-duplicates canonically-equal folders', () => {
    const result = buildSavedFolderProjects(
      [
        { path: 'C:\\Users\\desti\\a', nickname: 'A', addedAt: 1 },
        { path: 'C:\\Users\\desti\\b', nickname: 'B', addedAt: 2 },
        { path: 'c:/Users/desti/a', nickname: 'A-dup', addedAt: 3 }, // canonically == first
      ],
      [],
    );
    expect(result.map((p) => p.name)).toEqual(['A', 'B']);
  });

  it('carries a saved folder description onto the project record', () => {
    const out = buildSavedFolderProjects(
      [{ path: '/home/d/proj', nickname: 'Proj', description: 'my notes' }],
      [],
    );
    expect(out[0].description).toBe('my notes');
  });

  it('prefers the saved folder description over an indexed entry', () => {
    const indexed = {
      id: '/home/d/proj', name: 'proj', path: '/home/d/proj', lastIndexed: '',
      lastSession: null, contentTypes: [], stats: { artifactCount: 0 },
    } as any;
    const out = buildSavedFolderProjects(
      [{ path: '/home/d/proj', nickname: 'Proj', description: 'mine' }],
      [indexed],
    );
    expect(out[0].description).toBe('mine');
  });
});
