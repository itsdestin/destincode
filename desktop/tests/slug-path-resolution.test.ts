// Slug → path resolution for the Resume Browser (fix 2026-07-12).
// A CC project slug encodes the cwd with '-' for every path separator, so a
// folder whose own name contains a hyphen ('youcoded-dev') is indistinguishable
// from a nested pair ('youcoded/dev'). walkSlugParts must prefer the LONGEST
// leading folder that exists on disk, or a stray sibling ('youcoded') makes it
// greedily resolve to a nonexistent '…/youcoded/dev' — which made resume fall
// back to $HOME (every hyphenated-folder session "resumed from the home dir").
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { walkSlugParts } from '../src/main/session-browser';

describe('walkSlugParts', () => {
  let tmp: string;
  beforeAll(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slug-')); });
  afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('prefers a hyphenated folder over a greedy shorter sibling (the home-dir bug)', () => {
    fs.mkdirSync(path.join(tmp, 'youcoded'));      // the stray sibling that caused the greedy misfire
    fs.mkdirSync(path.join(tmp, 'youcoded-dev'));  // the real project folder
    // Before the fix this returned <tmp>/youcoded/dev (nonexistent); now it must
    // pick the real folder.
    expect(walkSlugParts(tmp, ['youcoded', 'dev'])).toBe(path.join(tmp, 'youcoded-dev'));
  });

  it('still resolves a genuinely nested path when no hyphenated form exists', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slug2-'));
    fs.mkdirSync(path.join(base, 'proj', 'sub'), { recursive: true });
    expect(walkSlugParts(base, ['proj', 'sub'])).toBe(path.join(base, 'proj', 'sub'));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('resolves a deep hyphenated folder several levels down', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'slug3-'));
    fs.mkdirSync(path.join(base, 'a', 'b', 'my-project'), { recursive: true });
    fs.mkdirSync(path.join(base, 'a', 'b', 'my')); // decoy shorter sibling
    expect(walkSlugParts(base, ['a', 'b', 'my', 'project'])).toBe(path.join(base, 'a', 'b', 'my-project'));
    fs.rmSync(base, { recursive: true, force: true });
  });

  it('falls back to a naive join when nothing on the path exists', () => {
    const base = path.join(tmp, 'ghost'); // never created
    expect(walkSlugParts(base, ['a', 'b'])).toBe(path.join(base, 'a-b'));
  });
});
