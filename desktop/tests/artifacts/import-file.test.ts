import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

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
});
