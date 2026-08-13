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

  // ── Relative recorded paths (native harness) ────────────────────────────
  // The native harness Write/Edit/Read tools accept a relative file_path and
  // resolve it with path.resolve(ctx.cwd, p) (harness/tools/guards.ts), but the
  // transcript event carries the RAW arg. The tracker passes session.cwd as
  // projectRoot (App.tsx:1507) — the SAME value — so a relative recorded path is
  // by definition in-project and must file as internal. Filing it external with
  // a relative absolutePath produced the 2026-08-12 "no longer on disk" false
  // positive on files that exist.

  it('relative recorded path → internal, NOT external', () => {
    expect(resolveTrackedPath('play.html', '/home/desti/proj')).toEqual({
      kind: 'internal', path: 'play.html', absolutePath: null,
    });
  });

  it('relative nested path → internal preserving subdirs', () => {
    expect(resolveTrackedPath('flappy-bird/play.html', '/home/desti/proj')).toEqual({
      kind: 'internal', path: 'flappy-bird/play.html', absolutePath: null,
    });
  });

  it('leading ./ is stripped', () => {
    expect(resolveTrackedPath('./ROADMAP.md', '/home/desti/proj')).toEqual({
      kind: 'internal', path: 'ROADMAP.md', absolutePath: null,
    });
  });

  // PRE-EXISTING BUG, fixed by the absoluteness gate on step 2. Without it the
  // cross-OS remap fires on a RELATIVE path (its OS-ness trivially differs from
  // a Windows root), finds 'proj' at index 0, and returns internal 'notes.md' —
  // but the harness resolved this arg to C:/Users/desti/proj/proj/notes.md.
  it('relative path under a Windows root is joined, not remapped', () => {
    expect(resolveTrackedPath('proj/notes.md', 'C:/Users/desti/proj')).toEqual({
      kind: 'internal', path: 'proj/notes.md', absolutePath: null,
    });
  });

  // REGRESSION TRAP: 'C:/Users/...' is NOT absolute by POSIX rules, so on Linux
  // a naive "not absolute → internal" check swallows every cross-device Windows
  // record and yields the garbage internal path join(root, 'C:/Users/...').
  // This case has no project-root segment to remap, so step 2 cannot fire and
  // it falls through to the new branch — which must reject it.
  it('unremappable Windows path on a Linux root stays EXTERNAL', () => {
    expect(resolveTrackedPath('C:\\Users\\desti\\AppData\\Local\\Temp\\paste.png',
      '/home/desti/proj')).toEqual({
      kind: 'external', path: 'paste.png',
      absolutePath: 'C:/Users/desti/AppData/Local/Temp/paste.png',
    });
  });

  // A '..' segment escapes the root once joined, manufacturing a phantom
  // internal artifact that authorizeArtifactRead then rejects. Leave external.
  it('relative path escaping the root with .. stays EXTERNAL', () => {
    expect(resolveTrackedPath('../other/notes.md', '/home/desti/proj')).toEqual({
      kind: 'external', path: 'notes.md', absolutePath: '../other/notes.md',
    });
  });

  it('empty recorded path stays EXTERNAL (unchanged behavior)', () => {
    expect(resolveTrackedPath('', '/home/desti/proj')).toEqual({
      kind: 'external', path: '', absolutePath: '',
    });
  });
});
