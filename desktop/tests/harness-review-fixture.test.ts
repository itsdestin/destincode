import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedFixtureWorkspace, FIXTURE_MANIFEST } from '../src/main/harness/review/fixture-workspace';

let made: string[] = [];
afterEach(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  made = [];
});

describe('seedFixtureWorkspace', () => {
  it('creates the tree inside the OS temp dir, never in a real repo', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    expect(root.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  });

  it('covers every file type the battery exercises', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    for (const { rel } of FIXTURE_MANIFEST) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    }
  });

  it('includes a binary file so the Read binary guard is reachable', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    const buf = fs.readFileSync(path.join(root, 'assets/logo.png'));
    expect(buf.includes(0)).toBe(true);
  });

  it('includes a file large enough to force paging', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    const lines = fs.readFileSync(path.join(root, 'src/big-module.ts'), 'utf8').split('\n');
    expect(lines.length).toBeGreaterThan(2_000);
  });

  it('includes a duplicated string so the ambiguous-Edit guard is reachable', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    const text = fs.readFileSync(path.join(root, 'notes/duplicates.md'), 'utf8');
    expect(text.match(/duplicate phrase hello/g)).toHaveLength(2);
  });

  it('includes a path with spaces', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    expect(fs.existsSync(path.join(root, 'a dir with spaces/a file with spaces.txt'))).toBe(true);
  });

  it('produces byte-identical trees across runs, so two models face the same tree', () => {
    const a = seedFixtureWorkspace();
    const b = seedFixtureWorkspace();
    made.push(a, b);
    for (const { rel } of FIXTURE_MANIFEST) {
      expect(fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(b, rel))), rel).toBe(true);
    }
  });
});
