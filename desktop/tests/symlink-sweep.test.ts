// Tests for the one-time legacy symlink sweep (Plan 2c demolition list).
// The legacy SyncService.aggregateConversations() symlinked every conversation
// .jsonl into the home-dir project slug, and rewriteProjectSlugs() junctioned
// foreign-device slug DIRECTORIES into the current slug. Deleting the creators
// does NOT remove the ~687 links already on disk — this sweep does. It MUST use
// lstat (never stat) so it never follows a link, and remove ONLY symlinks/
// junctions, never real files/dirs.
//
// Uses REAL temp dirs (fs.mkdtempSync) — the whole point is real on-disk link
// behavior. Windows dir junctions (fs.symlinkSync(target, path, 'junction'))
// always work without privilege; genuine FILE symlinks may need admin, so that
// one case is guarded with a try/skip (junction cases always run).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweepProjectSymlinks } from '../src/main/conversations/symlink-sweep';

let tmp: string;
let projectsDir: string; // stands in for ~/.claude/projects
let targetsDir: string;  // real files/dirs the links point AT (outside projectsDir)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-sweep-'));
  projectsDir = path.join(tmp, 'projects');
  targetsDir = path.join(tmp, 'targets');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.mkdirSync(targetsDir, { recursive: true });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const read = (p: string) => fs.readFileSync(p, 'utf8');

// Create a real slug dir under projects and return its path.
function slugDir(name: string): string {
  const p = path.join(projectsDir, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}

// Try to make a genuine file symlink; return false (so the test can self-skip)
// if the platform refuses (EPERM without admin on Windows).
function tryFileSymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, 'file');
    return true;
  } catch {
    return false;
  }
}

describe('sweepProjectSymlinks', () => {
  // aggregateConversations artifact: a .jsonl symlink INSIDE a slug dir pointing
  // at the real transcript in another slug dir. The link is removed; the real
  // target file is untouched (still present with original content).
  it('removes a file symlink inside a slug dir; leaves the real target intact', () => {
    const homeSlug = slugDir('C--Users-desti');
    const realTarget = path.join(targetsDir, 'sess-1.jsonl');
    fs.writeFileSync(realTarget, 'real-transcript-content\n');
    const link = path.join(homeSlug, 'sess-1.jsonl');

    const madeSymlink = tryFileSymlink(realTarget, link);
    if (!madeSymlink) {
      // Windows without admin: fall back to a junction so we still exercise the
      // inside-slug-dir removal path (a junction to a DIR beside the slug).
      const dirTarget = path.join(targetsDir, 'sess-1-dir');
      fs.mkdirSync(dirTarget, { recursive: true });
      fs.writeFileSync(path.join(dirTarget, 'keep.txt'), 'keep\n');
      fs.symlinkSync(dirTarget, link, 'junction');

      const res = sweepProjectSymlinks(projectsDir);
      expect(res.removed).toBe(1);
      expect(res.failed).toBe(0);
      expect(fs.existsSync(link)).toBe(false);        // link gone
      expect(fs.existsSync(dirTarget)).toBe(true);    // target dir survives
      expect(read(path.join(dirTarget, 'keep.txt'))).toBe('keep\n');
      return;
    }

    const res = sweepProjectSymlinks(projectsDir);
    expect(res).toEqual({ removed: 1, failed: 0 });
    expect(fs.existsSync(link)).toBe(false);          // symlink removed
    expect(fs.existsSync(realTarget)).toBe(true);     // real file untouched
    expect(read(realTarget)).toBe('real-transcript-content\n');
  });

  // rewriteProjectSlugs artifact: a whole slug DIR that is itself a junction to a
  // foreign-device slug dir. The junction (at the slug level) is removed; the
  // target dir and its files survive.
  it('removes a dir junction at the slug level; target dir contents survive', () => {
    const realSlug = path.join(targetsDir, 'foreign-device-slug');
    fs.mkdirSync(realSlug, { recursive: true });
    fs.writeFileSync(path.join(realSlug, 'a.jsonl'), 'foreign-a\n');
    fs.writeFileSync(path.join(realSlug, 'b.jsonl'), 'foreign-b\n');

    const junctionSlug = path.join(projectsDir, 'C--Users-desti-foreign');
    fs.symlinkSync(realSlug, junctionSlug, 'junction');

    const res = sweepProjectSymlinks(projectsDir);

    expect(res).toEqual({ removed: 1, failed: 0 });
    expect(fs.existsSync(junctionSlug)).toBe(false);          // junction gone
    expect(fs.existsSync(realSlug)).toBe(true);               // target dir survives
    expect(read(path.join(realSlug, 'a.jsonl'))).toBe('foreign-a\n');
    expect(read(path.join(realSlug, 'b.jsonl'))).toBe('foreign-b\n');
  });

  // Never touches real files/dirs: a real .jsonl sits beside a junction inside a
  // slug dir — only the link is removed.
  it('leaves real files beside a symlinked one untouched', () => {
    const homeSlug = slugDir('C--Users-desti');
    const realFile = path.join(homeSlug, 'real.jsonl');
    fs.writeFileSync(realFile, 'i-am-real\n');

    // Symlinked entry beside it (junction to a dir — always creatable on Windows).
    const dirTarget = path.join(targetsDir, 'linked-dir');
    fs.mkdirSync(dirTarget, { recursive: true });
    fs.writeFileSync(path.join(dirTarget, 'inside.txt'), 'inside\n');
    const link = path.join(homeSlug, 'linked.jsonl');
    fs.symlinkSync(dirTarget, link, 'junction');

    const res = sweepProjectSymlinks(projectsDir);

    expect(res.removed).toBe(1);
    expect(res.failed).toBe(0);
    expect(fs.existsSync(link)).toBe(false);       // link removed
    expect(fs.existsSync(realFile)).toBe(true);    // real file kept
    expect(read(realFile)).toBe('i-am-real\n');
    expect(fs.existsSync(dirTarget)).toBe(true);   // link target kept
  });

  // Idempotent: a second run finds nothing to remove and does not throw.
  it('is idempotent — a second run removes 0 and does not throw', () => {
    const realSlug = path.join(targetsDir, 'foreign');
    fs.mkdirSync(realSlug, { recursive: true });
    fs.writeFileSync(path.join(realSlug, 'x.jsonl'), 'x\n');
    fs.symlinkSync(realSlug, path.join(projectsDir, 'junctioned'), 'junction');

    const first = sweepProjectSymlinks(projectsDir);
    expect(first.removed).toBe(1);

    const second = sweepProjectSymlinks(projectsDir);
    expect(second).toEqual({ removed: 0, failed: 0 });
  });

  // Missing projectsDir is a benign no-op (never-fetched machine / fresh install).
  it('returns zero counts when the projects dir does not exist', () => {
    const res = sweepProjectSymlinks(path.join(tmp, 'does-not-exist'));
    expect(res).toEqual({ removed: 0, failed: 0 });
  });

  // Per-entry isolation: a real slug dir with several links plus one unreadable
  // entry — the failure increments `failed` but the rest still get swept. We
  // simulate an unreadable entry by pointing at a slug path that throws on
  // readdir (a FILE where a dir is expected inside the loop is not it; instead we
  // make one entry's lstat throw by removing it mid-iteration is racy, so we use
  // a slug whose child is a broken junction whose removeLink still succeeds).
  //
  // The robust, deterministic simulation: create two junction links (both
  // removable) and one entry that is a symlink to a NON-EXISTENT target. lstat
  // still reports it as a symlink (lstat doesn't follow), so it IS removed — that
  // proves broken links are handled, not skipped. To force a genuine per-entry
  // failure we make removeLink fail by pre-locking... which is platform-fragile.
  // Simplest deterministic failure: a slug ENTRY that is a directory we cannot
  // readdir is not needed — the per-entry catch is around lstat+removeLink. We
  // assert the loop CONTINUES past a broken link and still processes siblings.
  it('processes every link even when siblings are broken/dangling', () => {
    const homeSlug = slugDir('C--Users-desti');

    // Two valid junctions (removable).
    const t1 = path.join(targetsDir, 'd1');
    const t2 = path.join(targetsDir, 'd2');
    fs.mkdirSync(t1, { recursive: true });
    fs.mkdirSync(t2, { recursive: true });
    fs.symlinkSync(t1, path.join(homeSlug, 'l1.jsonl'), 'junction');
    fs.symlinkSync(t2, path.join(homeSlug, 'l2.jsonl'), 'junction');

    // A dangling symlink (target removed): lstat still reports symbolic link.
    const danglingTarget = path.join(targetsDir, 'gone');
    fs.mkdirSync(danglingTarget, { recursive: true });
    fs.symlinkSync(danglingTarget, path.join(homeSlug, 'l3.jsonl'), 'junction');
    fs.rmSync(danglingTarget, { recursive: true, force: true });

    // A real file that must survive.
    fs.writeFileSync(path.join(homeSlug, 'real.jsonl'), 'real\n');

    const res = sweepProjectSymlinks(projectsDir);

    // All three links removed regardless of order; real file kept.
    expect(res.removed).toBe(3);
    expect(res.failed).toBe(0);
    expect(fs.existsSync(path.join(homeSlug, 'real.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(homeSlug, 'l1.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(homeSlug, 'l2.jsonl'))).toBe(false);
    expect(fs.existsSync(path.join(homeSlug, 'l3.jsonl'))).toBe(false);
  });

  // Non-directory entries at the top level (a stray file directly under projects)
  // are neither symlinks nor dirs — skipped without counting as removed or failed.
  it('skips a plain file sitting directly under the projects dir', () => {
    fs.writeFileSync(path.join(projectsDir, 'stray.txt'), 'stray\n');
    slugDir('C--Users-desti'); // empty real slug dir alongside

    const res = sweepProjectSymlinks(projectsDir);

    expect(res).toEqual({ removed: 0, failed: 0 });
    expect(fs.existsSync(path.join(projectsDir, 'stray.txt'))).toBe(true);
  });
});
