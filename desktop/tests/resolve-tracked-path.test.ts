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

  it('SAME-OS different home (both Windows) → NOT remapped, stays external', () => {
    // Known limitation: the cross-OS gate can't safely remap here (no on-disk
    // check in a pure helper). Reads "deleted" — unchanged from before the fix,
    // never worse. Same-USERNAME same-OS devices hit step 1 (identical paths).
    expect(resolveTrackedPath('C:\\Users\\Destin\\YouCoded\\Projects\\cook\\recipe.md',
      'C:\\Users\\desti\\YouCoded\\Projects\\cook')).toEqual({
      kind: 'external', path: 'recipe.md',
      absolutePath: 'C:/Users/Destin/YouCoded/Projects/cook/recipe.md',
    });
  });

  it('REGRESSION GUARD: same-OS external whose path contains the project name → external', () => {
    // The bug this guards: without the cross-OS gate, project "docs" would remap
    // this real, existing external file to internal `readme.md` → phantom
    // "deleted" (WORSE than external, which is openable).
    expect(resolveTrackedPath('/home/desti/other-repo/docs/readme.md',
      '/home/desti/YouCoded/Projects/docs')).toEqual({
      kind: 'external', path: 'readme.md',
      absolutePath: '/home/desti/other-repo/docs/readme.md',
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

  it('CROSS-DEVICE case-insensitive project-name match (Windows→Linux, case drift)', () => {
    // Windows-recorded (capital Cook) resumed on Linux (lowercase cook): cross-OS
    // gate fires, case-insensitive segment match still finds it.
    expect(resolveTrackedPath('C:\\Users\\desti\\YouCoded\\Projects\\Cook\\recipe.md',
      '/home/desti/youcoded/projects/cook')).toEqual({
      kind: 'internal', path: 'recipe.md', absolutePath: null,
    });
  });
});
