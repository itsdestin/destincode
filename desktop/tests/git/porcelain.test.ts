import { describe, it, expect } from 'vitest';
import {
  parsePorcelainV2, parseNumstat, parseLogRecords,
  parseUnifiedDiff, countsFromHunks, synthesizeAddHunk,
} from '../../src/main/git/porcelain';

describe('parsePorcelainV2', () => {
  it('extracts branch and per-file staged/unstaged/untracked', () => {
    const text = [
      '# branch.oid 1234567890abcdef',
      '# branch.head master',
      '1 .M N... 100644 100644 100644 aaa bbb src/renderer/state/chat-reducer.ts',
      '1 M. N... 100644 100644 100644 aaa bbb src/shared/types.ts',
      '1 MM N... 100644 100644 100644 aaa bbb src/both.ts',
      '? src/renderer/state/undo-stack.ts',
      '',
    ].join('\n');
    const r = parsePorcelainV2(text);
    expect(r.branch).toBe('master');
    expect(r.files).toEqual([
      { path: 'src/renderer/state/chat-reducer.ts', staged: false, unstaged: true, untracked: false, kind: 'modified' },
      { path: 'src/shared/types.ts', staged: true, unstaged: false, untracked: false, kind: 'modified' },
      { path: 'src/both.ts', staged: true, unstaged: true, untracked: false, kind: 'modified' },
      { path: 'src/renderer/state/undo-stack.ts', staged: false, unstaged: true, untracked: true, kind: 'untracked' },
    ]);
  });

  it('reports detached HEAD as null branch and classifies add/delete/rename', () => {
    const text = [
      '# branch.head (detached)',
      '1 A. N... 000000 100644 100644 000 bbb new.ts',
      '1 .D N... 100644 100644 000000 aaa bbb gone.ts',
      '2 R. N... 100644 100644 100644 aaa bbb R100 renamed.ts\told-name.ts',
      '',
    ].join('\n');
    const r = parsePorcelainV2(text);
    expect(r.branch).toBeNull();
    expect(r.files[0]).toMatchObject({ path: 'new.ts', kind: 'added', staged: true });
    expect(r.files[1]).toMatchObject({ path: 'gone.ts', kind: 'deleted', unstaged: true });
    expect(r.files[2]).toMatchObject({ path: 'renamed.ts', kind: 'renamed', staged: true });
  });
});

describe('parseNumstat', () => {
  it('maps path to added/removed and flags binary', () => {
    const text = '41\t12\tsrc/renderer/state/chat-reducer.ts\n-\t-\tassets/logo.png\n';
    const m = parseNumstat(text);
    expect(m.get('src/renderer/state/chat-reducer.ts')).toEqual({ added: 41, removed: 12, binary: false });
    expect(m.get('assets/logo.png')).toEqual({ added: 0, removed: 0, binary: true });
  });
});

describe('parseLogRecords', () => {
  it('splits unit/record separators into entries', () => {
    const U = '\x1f'; // unit separator between fields
    const R = '\x1e'; // record separator between commits
    const text =
      ['3f1c9a2deadbeef00000000000000000000000', 'fix(reducer): drop stale tool ids', '2026-07-22T14:03:11-05:00'].join(U) + R +
      ['c9718267cafebabe0000000000000000000000', 'fix(ws): consolidate duplicate clients', '2026-07-22T11:00:00-05:00'].join(U) + R;
    const log = parseLogRecords(text);
    expect(log).toHaveLength(2);
    expect(log[0]).toEqual({
      sha: '3f1c9a2deadbeef00000000000000000000000',
      shortSha: '3f1c9a2',
      subject: 'fix(reducer): drop stale tool ids',
      authorDate: '2026-07-22T14:03:11-05:00',
    });
  });
  it('returns [] for empty output', () => {
    expect(parseLogRecords('')).toEqual([]);
  });
});

describe('parseUnifiedDiff', () => {
  it('parses hunks with absolute line numbers', () => {
    const text = [
      'diff --git a/f.ts b/f.ts',
      'index aaa..bbb 100644',
      '--- a/f.ts',
      '+++ b/f.ts',
      '@@ -142,4 +142,6 @@ case block',
      "     case 'TRANSCRIPT_TOOL_RESULT': {",
      '-      const tool = state.toolCalls.get(action.id);',
      '+      const tool = state.toolCalls.get(action.id) ?? null;',
      '+      if (!tool) return state;',
      '       const next = new Map(state.toolCalls);',
      '@@ -231,2 +233,2 @@',
      '-      return old;',
      '+      return fresh;',
      '',
    ].join('\n');
    const r = parseUnifiedDiff(text);
    expect(r.binary).toBe(false);
    expect(r.hunks).toHaveLength(2);
    expect(r.hunks[0]).toMatchObject({ oldStart: 142, oldLines: 4, newStart: 142, newLines: 6 });
    expect(r.hunks[0].lines[1]).toBe('-      const tool = state.toolCalls.get(action.id);');
    expect(r.hunks[1]).toMatchObject({ oldStart: 231, newStart: 233 });
  });
  it('handles single-line hunk headers (no comma) and binary diffs', () => {
    const one = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n');
    expect(one.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 });
    const bin = parseUnifiedDiff('diff --git a/x b/x\nBinary files a/x and b/x differ\n');
    expect(bin.binary).toBe(true);
    expect(bin.hunks).toEqual([]);
  });
});

describe('countsFromHunks / synthesizeAddHunk', () => {
  it('sums additions and removals across hunks', () => {
    const r = parseUnifiedDiff('--- a/f\n+++ b/f\n@@ -1,2 +1,3 @@\n-x\n+y\n+z\n ctx\n');
    expect(countsFromHunks(r.hunks)).toEqual({ added: 2, removed: 1 });
  });
  it('synthesizes an all-additions hunk for an untracked file', () => {
    const h = synthesizeAddHunk('line one\nline two\n');
    expect(h).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+line one', '+line two'] });
  });
});
