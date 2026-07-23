// Pins the jsdiff row output against the DiffRow shape the renderer draws
// (spec §6) — the fallback replaced a hand-rolled LCS, so the row contract
// (kinds, 1-indexed per-side numbering, interleave order) must not drift.
import { describe, it, expect } from 'vitest';
import { diffRowsFromStrings, rowsFromHunk } from '../src/renderer/components/diff/UnifiedDiff';

describe('diffRowsFromStrings (jsdiff fallback)', () => {
  it('produces ctx/del/add rows with per-side 1-indexed numbering', () => {
    const rows = diffRowsFromStrings('a\nb\nc', 'a\nx\nc');
    expect(rows).toEqual([
      { kind: 'ctx', oldN: 1, newN: 1, text: 'a' },
      { kind: 'del', oldN: 2, text: 'b' },
      { kind: 'add', newN: 2, text: 'x' },
      { kind: 'ctx', oldN: 3, newN: 3, text: 'c' },
    ]);
  });

  it('handles pure insertion and pure deletion', () => {
    expect(diffRowsFromStrings('a', 'a\nb')).toEqual([
      { kind: 'ctx', oldN: 1, newN: 1, text: 'a' },
      { kind: 'add', newN: 2, text: 'b' },
    ]);
    expect(diffRowsFromStrings('a\nb', 'a')).toEqual([
      { kind: 'ctx', oldN: 1, newN: 1, text: 'a' },
      { kind: 'del', oldN: 2, text: 'b' },
    ]);
  });

  it('does not emit a phantom row for the trailing newline', () => {
    const rows = diffRowsFromStrings('a\n', 'a\n');
    expect(rows).toEqual([{ kind: 'ctx', oldN: 1, newN: 1, text: 'a' }]);
  });

  it('identical inputs are all context', () => {
    const rows = diffRowsFromStrings('x\ny', 'x\ny');
    expect(rows.every((r) => r.kind === 'ctx')).toBe(true);
    expect(rows).toHaveLength(2);
  });
});

describe('rowsFromHunk (structuredPatch path — unchanged behavior)', () => {
  it('uses ABSOLUTE file line numbers from the hunk header', () => {
    const rows = rowsFromHunk({
      oldStart: 100, oldLines: 3, newStart: 100, newLines: 3,
      lines: [' ctx1', '-gone', '+here', ' ctx2'],
    } as any);
    expect(rows).toEqual([
      { kind: 'ctx', oldN: 100, newN: 100, text: 'ctx1' },
      { kind: 'del', oldN: 101, text: 'gone' },
      { kind: 'add', newN: 101, text: 'here' },
      { kind: 'ctx', oldN: 102, newN: 102, text: 'ctx2' },
    ]);
  });
});
