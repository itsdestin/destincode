// Regression pins for the 2026-08-01 harness tool-honesty review (Tasks 6-9):
// Grep's error advice, Grep/Glob path-format agreement, Grep's per-file/output
// caps, and Glob's "newest first" claim.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { grepErrorMessage, GrepTool, filesAtMaxCount } from '../src/main/harness/tools/grep';
import { GlobTool } from '../src/main/harness/tools/glob';
import type { ToolContext } from '../src/main/harness/tools/types';

function makeCtx(cwd: string): ToolContext {
  return { sessionId: 'test', cwd, signal: new AbortController().signal, readRegistry: new Map(), todos: [] };
}

describe('grepErrorMessage', () => {
  const P = '/ws/youcoded/desktop/src/main';
  const CWD = '/ws';

  it('keeps regex advice when ripgrep actually reported a regex parse error', () => {
    const err = 'rg: regex parse error:\n  (?:ipcMain\\.handle(()\n                    ^\nerror: unclosed group';
    const out = grepErrorMessage(err, P, CWD);
    expect(out).toContain('unclosed group');
    expect(out).toContain('Check the regex syntax.');
  });

  it('names the path and workspace root when ripgrep reported a missing directory', () => {
    const err = `rg: ${P}: IO error for operation on ${P}: No such file or directory (os error 2)`;
    const out = grepErrorMessage(err, P, CWD);
    expect(out).toContain(P);
    expect(out).toContain(CWD);
    // The wrong path was the whole problem. Never send the model regex-hunting.
    expect(out).not.toContain('Check the regex syntax.');
  });

  it('offers NO advice when the failure matches neither shape', () => {
    const out = grepErrorMessage('rg: something entirely unexpected', P, CWD);
    expect(out).toContain('something entirely unexpected');
    expect(out).not.toContain('Check the regex syntax.');
    expect(out).not.toContain('does not exist');
  });
});

describe('Grep and Glob agree on path format', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-paths-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const marker = 1;\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('Grep returns workspace-relative paths for targets inside the workspace', async () => {
    const r = await GrepTool.execute({ pattern: 'marker', output_mode: 'files_with_matches' }, makeCtx(dir));
    expect(r.text).toContain('src/a.ts');
    expect(r.text).not.toContain(dir);
  });

  it('Glob returns the same shape for the same file', async () => {
    const r = await GlobTool.execute({ pattern: '**/*.ts' }, makeCtx(dir));
    expect(r.text).toContain('src/a.ts');
  });
});

describe('filesAtMaxCount', () => {
  it('names files whose count-mode tally sits exactly at the cap', () => {
    const out = 'src/a.ts:500\nsrc/b.ts:12\nsrc/c.ts:500\n';
    expect(filesAtMaxCount(out, 'count', 500)).toEqual(['src/a.ts', 'src/c.ts']);
  });

  it('names files with exactly maxCount returned lines in content mode', () => {
    const out = Array.from({ length: 500 }, (_, i) => `src/a.ts:${i + 1}:hit`).join('\n')
      + '\n' + Array.from({ length: 3 }, (_, i) => `src/b.ts:${i + 1}:hit`).join('\n');
    expect(filesAtMaxCount(out, 'content', 500)).toEqual(['src/a.ts']);
  });

  it('never reports a cap in files_with_matches mode, where -l stops at the first hit', () => {
    expect(filesAtMaxCount('src/a.ts\nsrc/b.ts\n', 'files_with_matches', 500)).toEqual([]);
  });
});

describe('Glob completeness', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-cap-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the genuinely newest N when it caps, not an arbitrary N', async () => {
    // 2,100 files. The NEWEST is written last and lives in a directory the walk
    // reaches late, so the old implementation — which aborted the walk at 2,000
    // hits BEFORE sorting by mtime — could not have included it, while still
    // claiming "newest first". Regression pin for that false claim.
    fs.mkdirSync(path.join(dir, 'a'));
    fs.mkdirSync(path.join(dir, 'z'));
    for (let i = 0; i < 2_050; i++) fs.writeFileSync(path.join(dir, 'a', `f${i}.ts`), '');
    const newest = path.join(dir, 'z', 'newest.ts');
    fs.writeFileSync(newest, '');
    fs.utimesSync(newest, new Date(), new Date(Date.now() + 60_000));

    const r = await GlobTool.execute({ pattern: '**/*.ts' }, makeCtx(dir));
    expect(r.text.split('\n')[0]).toBe('z/newest.ts');
  }, 60_000);

  it('declares how many files it withheld', async () => {
    for (let i = 0; i < 2_050; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), '');
    const r = await GlobTool.execute({ pattern: '*.ts' }, makeCtx(dir));
    expect(r.bounds?.unit).toBe('files');
    expect(r.bounds?.shown).toBe(2_000);
    expect(r.bounds?.total).toBe(2_050);
  }, 60_000);
});
