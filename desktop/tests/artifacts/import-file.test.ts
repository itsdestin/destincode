import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { importFile } from '../../src/main/artifacts/import-file';

let tmp: string, root: string, outside: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-file-'));
  root = path.join(tmp, 'proj');
  outside = path.join(tmp, 'outside');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const src = (name: string, body = 'hello') => {
  const p = path.join(outside, name);
  fs.writeFileSync(p, body);
  return p;
};

describe('importFile', () => {
  it('copies a file into the destination folder and leaves the source', async () => {
    const s = src('budget.xlsx');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: path.join(root, 'docs'),
      mode: 'copy', onCollision: 'skip',
    });
    expect(r).toMatchObject({ ok: true, skipped: false });
    expect(fs.readFileSync(path.join(root, 'docs', 'budget.xlsx'), 'utf8')).toBe('hello');
    expect(fs.existsSync(s)).toBe(true);
  });

  it('moves a file — destination written, source removed', async () => {
    const s = src('notes.md');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: root,
      mode: 'move', onCollision: 'skip',
    });
    expect(r).toMatchObject({ ok: true, skipped: false });
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('hello');
    expect(fs.existsSync(s)).toBe(false);
  });

  it('skip leaves an existing destination untouched and reports skipped', async () => {
    fs.writeFileSync(path.join(root, 'notes.md'), 'ORIGINAL');
    const s = src('notes.md', 'NEW');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: root,
      mode: 'copy', onCollision: 'skip',
    });
    expect(r).toEqual({ ok: true, skipped: true });
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('ORIGINAL');
  });

  it('skip does NOT delete the source in move mode', async () => {
    // A skipped move must be a no-op, not a silent delete of the user's file.
    fs.writeFileSync(path.join(root, 'notes.md'), 'ORIGINAL');
    const s = src('notes.md', 'NEW');
    await importFile({
      projectRoot: root, sourcePath: s, destDir: root,
      mode: 'move', onCollision: 'skip',
    });
    expect(fs.existsSync(s)).toBe(true);
  });

  it('replace overwrites the existing destination', async () => {
    fs.writeFileSync(path.join(root, 'notes.md'), 'ORIGINAL');
    const s = src('notes.md', 'NEW');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: root,
      mode: 'copy', onCollision: 'replace',
    });
    expect(r).toMatchObject({ ok: true, relPath: 'notes.md' });
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('NEW');
  });

  it('keep-both suffixes the name and preserves the extension', async () => {
    fs.writeFileSync(path.join(root, 'notes.md'), 'ORIGINAL');
    const s = src('notes.md', 'NEW');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: root,
      mode: 'copy', onCollision: 'keep-both',
    });
    expect(r).toMatchObject({ ok: true, relPath: 'notes (2).md' });
    expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('ORIGINAL');
    expect(fs.readFileSync(path.join(root, 'notes (2).md'), 'utf8')).toBe('NEW');
  });

  it('keep-both keeps counting past an existing suffixed file', async () => {
    fs.writeFileSync(path.join(root, 'notes.md'), 'A');
    fs.writeFileSync(path.join(root, 'notes (2).md'), 'B');
    const s = src('notes.md', 'C');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: root,
      mode: 'copy', onCollision: 'keep-both',
    });
    expect(r).toMatchObject({ ok: true, relPath: 'notes (3).md' });
  });

  it('rejects a destination outside the project root', async () => {
    const s = src('evil.md');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: path.join(root, '..', 'outside'),
      mode: 'copy', onCollision: 'replace',
    });
    expect(r).toMatchObject({ ok: false });
    expect((r as any).ok).toBe(false);
    expect(fs.existsSync(path.join(outside, 'evil.md'))).toBe(true); // untouched
  });

  it('refuses to import into .claude/ without a protected-path confirm', async () => {
    // needs-confirm exists so writing an agent hook or settings file is a
    // deliberate act. The Move/Copy dialog does not satisfy it.
    fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
    const s = src('settings.json', '{}');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: path.join(root, '.claude'),
      mode: 'copy', onCollision: 'replace',
    });
    expect(r).toMatchObject({ ok: false, error: 'needs-confirm' });
    expect(fs.existsSync(path.join(root, '.claude', 'settings.json'))).toBe(false);
  });

  it('refuses to overwrite a dotenv file', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'SECRET=1');
    const s = src('.env', 'SECRET=2');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: root,
      mode: 'copy', onCollision: 'replace',
    });
    expect(r).toMatchObject({ ok: false, error: 'needs-confirm' });
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe('SECRET=1');
  });

  it('regression: refuses (does not report skipped) for an outside-root destDir even when a same-named file already exists there', async () => {
    // Before the fix, exists(path.join(destDir, name)) ran BEFORE
    // authorizeArtifactWrite, and onCollision: 'skip' returned success
    // straight off that probe — reporting { ok: true, skipped: true } for a
    // destDir that was never checked against projectRoot. That turned the
    // function into an existence-oracle for arbitrary paths.
    const destOutside = path.join(tmp, 'outside-dest');
    fs.mkdirSync(destOutside, { recursive: true });
    fs.writeFileSync(path.join(destOutside, 'evil.md'), 'PRE-EXISTING OUTSIDE');
    const s = src('evil.md', 'NEW');
    const r = await importFile({
      projectRoot: root, sourcePath: s, destDir: destOutside,
      mode: 'copy', onCollision: 'skip',
    });
    expect(r.ok).toBe(false);
    expect((r as any).skipped).not.toBe(true);
    expect(fs.readFileSync(path.join(destOutside, 'evil.md'), 'utf8')).toBe('PRE-EXISTING OUTSIDE');
  });

  it('reports the real error code when the source does not exist', async () => {
    const r = await importFile({
      projectRoot: root, sourcePath: path.join(outside, 'ghost.md'), destDir: root,
      mode: 'copy', onCollision: 'replace',
    });
    expect(r).toMatchObject({ ok: false, error: 'ENOENT' });
  });

  // ── C1: importing a file ONTO ITSELF ────────────────────────────────────
  // Reachable from the UI: browse to docs/ in Project Files → "+ Add file" →
  // pick docs/notes.md. The collision is detected correctly; the question is
  // what happens next. fs.copyFile short-circuits when both sides are the same
  // inode, so the size verification stats one file twice and passes, and the
  // move then unlinked the only copy — reporting { ok: true } over a deletion.
  describe('self-import (source IS the destination file)', () => {
    it('move + replace onto itself leaves the file intact', async () => {
      const self = path.join(root, 'docs', 'notes.md');
      fs.writeFileSync(self, 'MINE');
      const r = await importFile({
        projectRoot: root, sourcePath: self, destDir: path.join(root, 'docs'),
        mode: 'move', onCollision: 'replace',
      });
      expect(fs.existsSync(self)).toBe(true);
      expect(fs.readFileSync(self, 'utf8')).toBe('MINE');
      expect(r).toMatchObject({ ok: true, skipped: true, reason: 'already-in-place' });
    });

    it('move + keep both onto itself does not rename the user\'s file', async () => {
      const self = path.join(root, 'docs', 'notes.md');
      fs.writeFileSync(self, 'MINE');
      const r = await importFile({
        projectRoot: root, sourcePath: self, destDir: path.join(root, 'docs'),
        mode: 'move', onCollision: 'keep-both',
      });
      expect(fs.existsSync(self)).toBe(true);
      expect(fs.existsSync(path.join(root, 'docs', 'notes (2).md'))).toBe(false);
      expect(r).toMatchObject({ ok: true, skipped: true, reason: 'already-in-place' });
    });

    it('copy onto itself is a no-op that reports where the file already is', async () => {
      const self = path.join(root, 'docs', 'notes.md');
      fs.writeFileSync(self, 'MINE');
      const r = await importFile({
        projectRoot: root, sourcePath: self, destDir: path.join(root, 'docs'),
        mode: 'copy', onCollision: 'replace',
      });
      expect(r).toMatchObject({ ok: true, skipped: true, reason: 'already-in-place' });
      expect((r as any).relPath.replace(/\\/g, '/')).toBe('docs/notes.md');
      expect(fs.readdirSync(path.join(root, 'docs'))).toEqual(['notes.md']);
    });

    it('reaches the same file through a symlinked destination folder', async () => {
      // The picker can hand back a path that walks through a symlink, so a
      // plain string compare would miss it. Skipped where symlinks need
      // elevation (Windows without developer mode).
      const link = path.join(root, 'linked');
      try { fs.symlinkSync(path.join(root, 'docs'), link, 'dir'); }
      catch { return; }
      const self = path.join(root, 'docs', 'notes.md');
      fs.writeFileSync(self, 'MINE');
      const r = await importFile({
        projectRoot: root, sourcePath: path.join(link, 'notes.md'), destDir: path.join(root, 'docs'),
        mode: 'move', onCollision: 'replace',
      });
      expect(fs.existsSync(self)).toBe(true);
      expect(r).toMatchObject({ ok: true, skipped: true, reason: 'already-in-place' });
    });
  });

  // ── I2: 'replace' only applies to collisions the user was SHOWN ─────────
  describe('disclosedCollisions gates replace', () => {
    it('falls back to keep-both for a collision the dialog never named', async () => {
      // The renderer builds its collision list from on-disk discovery, which
      // skips noise files (package-lock.json, *.map, …) and truncates at its
      // caps. A user who picked Replace to handle notes.md never consented to
      // overwriting a package-lock.json they were not told about.
      fs.writeFileSync(path.join(root, 'package-lock.json'), 'ORIGINAL');
      const s = src('package-lock.json', 'NEW');
      const r = await importFile({
        projectRoot: root, sourcePath: s, destDir: root,
        mode: 'copy', onCollision: 'replace', disclosedCollisions: ['notes.md'],
      });
      expect(r).toMatchObject({ ok: true, relPath: 'package-lock (2).json' });
      expect(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).toBe('ORIGINAL');
    });

    it('still replaces a collision that WAS disclosed', async () => {
      fs.writeFileSync(path.join(root, 'notes.md'), 'ORIGINAL');
      const s = src('notes.md', 'NEW');
      const r = await importFile({
        projectRoot: root, sourcePath: s, destDir: root,
        mode: 'copy', onCollision: 'replace', disclosedCollisions: ['notes.md'],
      });
      expect(r).toMatchObject({ ok: true, relPath: 'notes.md' });
      expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('NEW');
    });

    it('never deletes an undisclosed collision in move mode either', async () => {
      fs.writeFileSync(path.join(root, 'package-lock.json'), 'ORIGINAL');
      const s = src('package-lock.json', 'NEW');
      await importFile({
        projectRoot: root, sourcePath: s, destDir: root,
        mode: 'move', onCollision: 'replace', disclosedCollisions: [],
      });
      expect(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')).toBe('ORIGINAL');
      expect(fs.readFileSync(path.join(root, 'package-lock (2).json'), 'utf8')).toBe('NEW');
    });
  });

  // ── I3: a failed copy must not destroy the destination ─────────────────
  describe('failed copy rollback', () => {
    // Stand in for a real mid-write failure. fs.copyFile opens the destination
    // with O_TRUNC and streams into it, so an ENOSPC/EIO partway through leaves
    // a PARTIAL file behind — that half-written state is the whole point, and a
    // plain mockRejectedValue would not reproduce it.
    const failMidWrite = (code: string) =>
      vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (_s: any, dest: any) => {
        fs.writeFileSync(dest as string, 'PART');
        throw Object.assign(new Error(`simulated ${code}`), { code });
      });

    it('leaves the pre-existing destination intact when the copy fails', async () => {
      // Writing straight onto destPath left the user's file as a truncated stub
      // and returned COPY_FAILED over the wreckage. Copying into a temp and
      // renaming means the failure never touches the real destination.
      fs.writeFileSync(path.join(root, 'notes.md'), 'ORIGINAL');
      const s = src('notes.md', 'NEW');
      failMidWrite('ENOSPC');
      const r = await importFile({
        projectRoot: root, sourcePath: s, destDir: root,
        mode: 'copy', onCollision: 'replace', disclosedCollisions: ['notes.md'],
      });
      expect(r).toMatchObject({ ok: false, error: 'ENOSPC' });
      expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('ORIGINAL');
      // …and no temp debris left behind in the project folder.
      expect(fs.readdirSync(root).filter((f) => f.endsWith('.part'))).toEqual([]);
    });

    it('leaves no partial file at all when a move\'s copy fails', async () => {
      const s = src('notes.md', 'NEW');
      failMidWrite('EIO');
      const r = await importFile({
        projectRoot: root, sourcePath: s, destDir: root, mode: 'move', onCollision: 'skip',
      });
      expect(r).toMatchObject({ ok: false, error: 'EIO' });
      expect(fs.existsSync(s)).toBe(true);                          // source untouched
      expect(fs.existsSync(path.join(root, 'notes.md'))).toBe(false); // no stub
      expect(fs.readdirSync(root).filter((f) => f.endsWith('.part'))).toEqual([]);
    });

    it('leaves the destination intact when the copy comes up short', async () => {
      // COPY_INCOMPLETE (a short write that did not throw) is the other path
      // that used to return over an already-clobbered destination.
      fs.writeFileSync(path.join(root, 'notes.md'), 'ORIGINAL');
      const s = src('notes.md', 'A MUCH LONGER BODY');
      vi.spyOn(fs.promises, 'copyFile').mockImplementationOnce(async (_s: any, dest: any) => {
        fs.writeFileSync(dest as string, 'SHORT');
      });
      const r = await importFile({
        projectRoot: root, sourcePath: s, destDir: root,
        mode: 'move', onCollision: 'replace', disclosedCollisions: ['notes.md'],
      });
      expect(r).toMatchObject({ ok: false, error: 'COPY_INCOMPLETE' });
      expect(fs.readFileSync(path.join(root, 'notes.md'), 'utf8')).toBe('ORIGINAL');
      expect(fs.existsSync(s)).toBe(true);
      expect(fs.readdirSync(root).filter((f) => f.endsWith('.part'))).toEqual([]);
    });
  });
});
