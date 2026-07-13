import { describe, it, expect } from 'vitest';
import { resolveTrackedPath } from '../src/shared/artifacts/resolve-tracked-path';

describe('resolveTrackedPath', () => {
  it('same-device path under the project root → internal relative', () => {
    expect(resolveTrackedPath('C:\\Users\\desti\\YouCoded\\Projects\\cook\\recipe.md',
      'C:\\Users\\desti\\YouCoded\\Projects\\cook')).toEqual({
      kind: 'internal', path: 'recipe.md', absolutePath: null,
    });
  });

  it('nested same-device path → internal relative with subdirs', () => {
    expect(resolveTrackedPath('/home/desti/YouCoded/Projects/cook/sub/recipe.md',
      '/home/desti/YouCoded/Projects/cook')).toEqual({
      kind: 'internal', path: 'sub/recipe.md', absolutePath: null,
    });
  });

  it('the project root itself → internal with empty relative path', () => {
    expect(resolveTrackedPath('/home/desti/YouCoded/Projects/cook',
      '/home/desti/YouCoded/Projects/cook')).toEqual({
      kind: 'internal', path: '', absolutePath: null,
    });
  });

  it('CROSS-DEVICE: Windows-recorded path resumed on Linux → remapped internal', () => {
    // Device A (Windows) recorded this absolute path; device B (Linux) has the
    // synced folder at a different absolute location. The bug this fixes:
    // without remap this filed as external → "deleted" in the artifact viewer.
    expect(resolveTrackedPath('C:\\Users\\desti\\YouCoded\\Projects\\cook\\recipe.md',
      '/home/desti/YouCoded/Projects/cook')).toEqual({
      kind: 'internal', path: 'recipe.md', absolutePath: null,
    });
  });

  it('CROSS-DEVICE with subdirs → remapped internal preserving the tail', () => {
    expect(resolveTrackedPath('C:\\Users\\desti\\YouCoded\\Projects\\cook\\dips\\salsa.md',
      '/home/desti/YouCoded/Projects/cook')).toEqual({
      kind: 'internal', path: 'dips/salsa.md', absolutePath: null,
    });
  });

  it('CROSS-DEVICE with a different Windows home → remapped internal', () => {
    expect(resolveTrackedPath('C:\\Users\\Destin\\YouCoded\\Projects\\cook\\recipe.md',
      'C:\\Users\\desti\\YouCoded\\Projects\\cook')).toEqual({
      kind: 'internal', path: 'recipe.md', absolutePath: null,
    });
  });

  it('genuinely external file (no project-name segment) → external', () => {
    expect(resolveTrackedPath('/tmp/scratch/notes.md',
      '/home/desti/YouCoded/Projects/cook')).toEqual({
      kind: 'external', path: 'notes.md', absolutePath: '/tmp/scratch/notes.md',
    });
  });

  it('external path whose FOLDER equals the project name (no tail) → external', () => {
    // The project name appears but as the final segment (a directory, not a file
    // inside it) — nothing to remap, stays external.
    expect(resolveTrackedPath('/somewhere/else/cook',
      '/home/desti/YouCoded/Projects/cook')).toEqual({
      kind: 'external', path: 'cook', absolutePath: '/somewhere/else/cook',
    });
  });

  it('trailing slash on the project root is tolerated', () => {
    expect(resolveTrackedPath('/home/desti/YouCoded/Projects/cook/recipe.md',
      '/home/desti/YouCoded/Projects/cook/')).toEqual({
      kind: 'internal', path: 'recipe.md', absolutePath: null,
    });
  });

  it('case-insensitive project-name match (Windows drive/case drift)', () => {
    expect(resolveTrackedPath('C:\\Users\\desti\\YouCoded\\Projects\\Cook\\recipe.md',
      'c:\\users\\desti\\youcoded\\projects\\cook')).toEqual({
      kind: 'internal', path: 'recipe.md', absolutePath: null,
    });
  });
});
