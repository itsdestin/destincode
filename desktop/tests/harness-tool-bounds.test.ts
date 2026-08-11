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
    // Tightened (Critical 2, 2026-08-06 review): `.toContain('src/a.ts')` was
    // satisfied by "./src/a.ts" too, so this passed against the buggy code
    // that omitted the path arg's fix. Assert the exact line AND the absence
    // of the "./" prefix ripgrep emits when handed '.' explicitly, so this
    // fails again if that regresses.
    expect(r.text).toBe('src/a.ts');
    expect(r.text).not.toContain('./');
    expect(r.text).not.toContain(dir);
  });

  it('Glob returns the same shape for the same file', async () => {
    const r = await GlobTool.execute({ pattern: '**/*.ts' }, makeCtx(dir));
    expect(r.text).toContain('src/a.ts');
  });

  it('Glob returns absolute paths when the search root is outside the workspace, matching Grep', async () => {
    // Regression pin for Important 3: `base` (search-root-relative to cwd)
    // starts with '..' here since `dir` (the search root) is OUTSIDE the
    // workspace passed as ctx.cwd. The buggy rebase() returned the
    // search-root-relative string unchanged ("src/a.ts"), which reads as a
    // workspace file when it is not one.
    // Widened 2026-08-11: the absolute form is now forward-slashed too, so the
    // whole harness speaks one path vocabulary instead of two.
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-workspace-'));
    try {
      const r = await GlobTool.execute({ pattern: '**/*.ts', path: dir }, makeCtx(workspace));
      expect(r.text).not.toContain('\\');
      expect(r.text.endsWith('/src/a.ts')).toBe(true);
      expect(r.text.startsWith(dir.replace(/\\/g, '/'))).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });

  // Added 2026-08-11: the external-directory agreement was asserted for Glob
  // only, so `--path-separator` could have silently split the two tools apart
  // on Windows with every test still green. Pins BOTH directions.
  it('Grep returns absolute paths when the search root is outside the workspace, matching Glob', async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-workspace-'));
    try {
      const r = await GrepTool.execute(
        { pattern: 'marker', output_mode: 'files_with_matches', path: dir },
        makeCtx(workspace),
      );
      expect(r.text).not.toContain('\\');
      expect(r.text.endsWith('/src/a.ts')).toBe(true);
      expect(r.text.startsWith(dir.replace(/\\/g, '/'))).toBe(true);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});

describe('Grep declares no bounds when nothing was dropped', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-nodrop-'));
    fs.writeFileSync(path.join(dir, 'a.ts'), 'export const marker = 1;\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('a one-file, one-match search reports no bounds at all', async () => {
    // Regression pin for Critical 1: the old `totalChars > out.length` check
    // compared against a TRIMMED string, so ripgrep's own trailing '\n' made
    // this fire on every non-empty result — including this one, which held
    // everything. A real fix must declare `bounds: undefined` here.
    const r = await GrepTool.execute({ pattern: 'marker', output_mode: 'content' }, makeCtx(dir));
    expect(r.bounds).toBeUndefined();
    expect(r.text).not.toContain('showing');
    expect(r.text).not.toContain('narrow the pattern');
  });
});

describe('Glob honesty on cancellation', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'glob-cancel-'));
    for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), '');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reports cancellation instead of a truncated partial list, matching Grep', async () => {
    // Regression pin for Important 4: an aborted walk used to return silently,
    // so a cancelled search that had gathered fewer than RESULT_LIMIT hits
    // declared NO bounds and handed back whatever it found as if complete.
    const ac = new AbortController();
    ac.abort();
    const ctx: ToolContext = { sessionId: 'test', cwd: dir, signal: ac.signal, readRegistry: new Map(), todos: [] };
    const r = await GlobTool.execute({ pattern: '*.ts' }, ctx);
    expect(r.text).toBe('Canceled: the user interrupted this search.');
    expect(r.isError).toBe(true);
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

  // Regression pin (2026-08-10 review, Claim 4, GPT-5.6's specific call): ripgrep
  // omits the filename column ENTIRELY when the search target IS a single file
  // rather than a directory -- content-mode lines are bare "N:matchtext", not
  // "file:N:matchtext". The old parser read the first colon-delimited token as
  // the filename, so it silently treated each LINE NUMBER as a distinct "file"
  // (never reaching maxCount under any one key) and the cap-hit disclosure note
  // never rendered for single-file Grep calls, even though the same 500-match
  // cap fired identically. Fixed by passing the known single-file label in.
  it('names the single file when content-mode output has no filename prefix (single-file target)', () => {
    const out = Array.from({ length: 500 }, (_, i) => `${i + 1}:hit`).join('\n');
    expect(filesAtMaxCount(out, 'content', 500, 'src/big-module.ts')).toEqual(['src/big-module.ts']);
  });
});

// New (2026-08-10 review): content-mode Grep was the harness's last oversized
// tool result — a live run measured 17,860-17,898 chars from ONE search,
// flagged by name (Grok 4.5). Per the prior-art doc's Grep-specific
// recommendation (docs/active/investigations/2026-08-10-harness-output-
// truncation-prior-art.md, "Grep / search-result policy"), a grep result's
// value is COMPLETENESS of matches, so the fix caps by MATCH COUNT (~100),
// not chars/lines — mirroring OpenCode's shipped 100-match cap.
describe('Grep content mode: match-count cap', () => {
  let dir: string;
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caps content mode at 100 matches with an EXACT total when nothing else was dropped', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-matchcap-'));
    // 400 matches, one file, well under both the 24k head-buffer window and
    // ripgrep's own 500-per-file --max-count — so the ONLY thing that trims
    // this result is our new match cap, and 400 is a real, measured total
    // (not a floor), so bounds.total must be the exact number, not null.
    const lines = Array.from({ length: 400 }, (_, i) => `export const MATCH_${i} = ${i};`);
    fs.writeFileSync(path.join(dir, 'big.ts'), lines.join('\n') + '\n');
    const r = await GrepTool.execute({ pattern: 'MATCH', output_mode: 'content' }, makeCtx(dir));
    expect(r.bounds).toEqual({
      shown: 100,
      total: 400,
      unit: 'matches',
      moreHint: 'narrow the pattern, add a glob filter, or use output_mode: "count"',
    });
    // House style: the notice names real numbers, not a vague "truncated".
    expect(r.text).toContain('showing 100 of 400 matches');
    expect(r.text).toContain('narrow the pattern');
    // Exactly 100 match lines actually present, not "up to" 100.
    const shownLines = r.text.split('\n').filter((l) => /^big\.ts:\d+:export const MATCH_/.test(l));
    expect(shownLines).toHaveLength(100);
  });

  it('reports an UNKNOWN total (never a false exact number) when ripgrep\'s own per-file cap also fired', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-matchcap-unknown-'));
    // 600 matches in one file: ripgrep itself stops counting this file at its
    // own 500-match --max-count BEFORE our 100-match display cap ever sees
    // the rest, so the true total is unknowable from what we captured. The
    // 2026-08-06 review's "total: null" precedent (composeNotice) applies:
    // never claim an exact total when a DIFFERENT cap already excluded data.
    const lines = Array.from({ length: 600 }, (_, i) => `MATCH line ${i}`);
    fs.writeFileSync(path.join(dir, 'single.ts'), lines.join('\n') + '\n');
    const r = await GrepTool.execute({ pattern: 'MATCH', path: 'single.ts', output_mode: 'content' }, makeCtx(dir));
    expect(r.bounds?.unit).toBe('matches');
    expect(r.bounds?.shown).toBe(100);
    expect(r.bounds?.total).toBeNull();
    expect(r.text).toContain('more may exist — exact total unknown');
    // The pre-existing per-file cap disclosure (filesAtMaxCount) must still
    // fire independently of our new cap — preserved behavior, not replaced.
    expect(r.text).toContain('Note:');
    expect(r.text).toContain('single.ts');
  });

  it('never truncates a KEPT match\'s context, even when -C multiplies volume enough to trip the line-safety margin first', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-matchcap-context-'));
    // 60 matches, each carrying 5 lines of context on both sides (-C 5 = 11
    // content lines + 1 "--" group separator = 12 lines/match), spaced 40
    // filler lines apart so ripgrep never merges neighboring context windows.
    // 60 * 12 = 720 lines of REAL ripgrep output would sail past the 200-line
    // safety margin (CONTENT_LINE_SAFETY in grep.ts) well before 100 matches
    // are reached — this is the exact "-C legitimately multiplies volume"
    // scenario the task flagged. The property under test: whichever match is
    // the LAST one shown must have its FULL trailing context intact — a cap
    // that silently ate context would be its own honesty problem.
    const C = 5;
    const NUM_MATCHES = 60;
    const GAP = 40;
    const fixtureLines: string[] = [];
    for (let i = 0; i < NUM_MATCHES; i++) {
      for (let b = C; b >= 1; b--) fixtureLines.push(`before_${i}_${b}`);
      fixtureLines.push(`MATCH_${i}`);
      for (let a = 1; a <= C; a++) fixtureLines.push(`after_${i}_${a}`);
      for (let g = 0; g < GAP; g++) fixtureLines.push(`filler_${i}_${g}`);
    }
    fs.writeFileSync(path.join(dir, 'spaced.txt'), fixtureLines.join('\n') + '\n');
    const r = await GrepTool.execute({ pattern: 'MATCH_', output_mode: 'content', '-C': C }, makeCtx(dir));

    const shownIndices = [...r.text.matchAll(/MATCH_(\d+)/g)].map((m) => Number(m[1]));
    expect(shownIndices.length).toBeGreaterThan(0);
    const shownCount = shownIndices.length;

    // The line-safety margin (not the 100-match cap) is what stopped this run.
    expect(shownCount).toBeLessThan(100);
    expect(shownCount).toBeLessThan(NUM_MATCHES);
    expect(r.bounds?.shown).toBe(shownCount);
    // Nothing beyond the ~200-line margin was silently dropped mid-file: the
    // per-file cap never fired here (60 << 500), and the buffer never
    // overflowed (720 real output lines is well under the 24k-char window),
    // so the total is exact, not "unknown" — same honesty guarantee as above.
    expect(r.bounds?.total).toBe(NUM_MATCHES);

    // The defining assertion: the LAST shown match's full trailing context
    // (all the way out to `after_<idx>_<C>`) is present...
    expect(r.text).toContain(`after_${shownCount - 1}_${C}`);
    // ...and the FIRST match past the cutoff is entirely absent — the cut
    // landed cleanly at a group boundary, not mid-block.
    expect(r.text).not.toContain(`MATCH_${shownCount}`);
  });

  it('leaves files_with_matches uncapped (path lists are cheap — per the prior-art doc)', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-matchcap-fwm-'));
    for (let i = 0; i < 150; i++) fs.writeFileSync(path.join(dir, `f${i}.ts`), 'export const MATCH = 1;\n');
    const r = await GrepTool.execute({ pattern: 'MATCH', output_mode: 'files_with_matches' }, makeCtx(dir));
    expect(r.bounds).toBeUndefined();
    expect(r.text.split('\n').filter(Boolean)).toHaveLength(150);
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
