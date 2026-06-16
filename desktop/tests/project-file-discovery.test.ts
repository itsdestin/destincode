import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { discoverProjectFiles, invalidateDiscoveryCache } from '../src/main/artifacts/project-file-discovery';

let root: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'disco-'));
  // Documents at various depths
  fs.writeFileSync(path.join(root, 'README.md'), '# hi');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'note');
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# spec');
  fs.writeFileSync(path.join(root, 'data.xlsx'), 'binary');
  // Source code IS discovered now — "All files" is a full browser (every type).
  fs.writeFileSync(path.join(root, 'index.ts'), 'code');
  fs.writeFileSync(path.join(root, 'app.py'), 'code');
  // High-noise byproducts that must NOT be discovered (lockfiles, maps, minified).
  fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
  fs.writeFileSync(path.join(root, 'bundle.js.map'), '{}');
  // Excluded directories must be skipped entirely
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'README.md'), 'dep');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'NOTES.md'), 'git');
  fs.mkdirSync(path.join(root, '.hidden'));
  fs.writeFileSync(path.join(root, '.hidden', 'secret.md'), 'hidden');
});

afterAll(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
});

describe('discoverProjectFiles', () => {
  it('finds ALL file types (incl. code, incl. nested) but skips noise byproducts', async () => {
    invalidateDiscoveryCache(root);
    const { files, truncated } = await discoverProjectFiles(root);
    const rels = files.map((f) => f.path).sort();
    // Code (index.ts, app.py) IS included now; lockfile + .map are NOT.
    expect(rels).toEqual(['README.md', 'app.py', 'data.xlsx', 'docs/spec.md', 'index.ts', 'notes.txt']);
    expect(rels).not.toContain('package-lock.json');
    expect(rels).not.toContain('bundle.js.map');
    expect(truncated).toBe(false);
  });

  it('skips node_modules, .git, and dot-directories', async () => {
    invalidateDiscoveryCache(root);
    const { files } = await discoverProjectFiles(root);
    const rels = files.map((f) => f.path);
    expect(rels.some((r) => r.includes('node_modules'))).toBe(false);
    expect(rels.some((r) => r.includes('.git'))).toBe(false);
    expect(rels.some((r) => r.includes('.hidden'))).toBe(false);
  });

  it('marks every discovered record as discovered with id == relative path', async () => {
    invalidateDiscoveryCache(root);
    const { files } = await discoverProjectFiles(root);
    for (const f of files) {
      expect(f.discovered).toBe(true);
      expect(f.id).toBe(f.path);     // id is the canonical relative path
      expect(f.kind).toBe('internal');
      expect(f.status).toBe('active');
    }
  });

  it('does NOT descend into nested git repos (deterministic, bounded scan)', async () => {
    // A nested repo (its own .git) holds documents — those belong to that repo,
    // not this project, so the crawl must stop at its boundary. This is what
    // keeps the youcoded-dev workspace count from ballooning over its cloned
    // sub-repos + worktree, and what makes the count stable run-to-run.
    const sub = path.join(root, 'subrepo');
    fs.mkdirSync(path.join(sub, '.git'), { recursive: true });
    fs.writeFileSync(path.join(sub, 'INNER.md'), 'inner repo doc');
    // A nested git WORKTREE marks its root with a .git FILE (not a dir).
    const wt = path.join(root, 'worktree');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /elsewhere');
    fs.writeFileSync(path.join(wt, 'WT.md'), 'worktree doc');
    try {
      invalidateDiscoveryCache(root);
      const { files } = await discoverProjectFiles(root);
      const rels = files.map((f) => f.path);
      expect(rels.some((r) => r.includes('subrepo'))).toBe(false);
      expect(rels.some((r) => r.includes('worktree'))).toBe(false);
    } finally {
      fs.rmSync(sub, { recursive: true, force: true });
      fs.rmSync(wt, { recursive: true, force: true });
      invalidateDiscoveryCache(root);
    }
  });

  it('caches within the TTL (same array instance) until invalidated', async () => {
    invalidateDiscoveryCache(root);
    const a = await discoverProjectFiles(root);
    const b = await discoverProjectFiles(root);
    expect(b).toBe(a); // cached result reused
    invalidateDiscoveryCache(root);
    const c = await discoverProjectFiles(root);
    expect(c).not.toBe(a); // fresh scan after invalidation
  });
});
