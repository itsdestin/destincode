import { describe, it, expect } from 'vitest';
import { truncateOutput, composeNotice, takeHeadLines, takeTailLines } from '../src/main/harness/tools/truncate';
import type { ResultBounds } from '../src/main/harness/tools/types';

describe('truncateOutput', () => {
  it('passes short output through untouched', () => {
    const r = truncateOutput('hello', { maxChars: 100 });
    expect(r.text).toBe('hello');
    expect(r.truncated).toBe(false);
  });
  it('keeps head + tail and appends an actionable trailer', () => {
    const big = 'x'.repeat(50_000);
    const r = truncateOutput(big, { maxChars: 10_000 });
    expect(r.text.length).toBeLessThan(11_000);
    expect(r.truncated).toBe(true);
    // The trailer moved to composeNotice (rendered by defineTool). truncateOutput
    // now only reports the fact; it never writes advice into the text itself.
    expect(r.totalChars).toBe(50_000);
  });
  it('caps line count too', () => {
    const many = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join('\n');
    const r = truncateOutput(many, { maxChars: 1_000_000, maxLines: 100 });
    expect(r.text.split('\n').length).toBeLessThanOrEqual(102); // 80 (head) + 1 (omitted marker) + 20 (tail)
    expect(r.truncated).toBe(true);
  });
  it('never grows the output at tiny caps (slice(-0) guard)', () => {
    // maxChars <= 4 => Math.floor(maxChars*0.2) === 0; slice(-0) would return
    // the WHOLE string and make output larger than the input. Must stay shorter.
    const big = 'y'.repeat(100);
    const r = truncateOutput(big, { maxChars: 3 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThan(big.length);

    // maxLines <= 4 => same defect on the line path.
    const many = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n');
    const r2 = truncateOutput(many, { maxChars: 1_000_000, maxLines: 2 });
    expect(r2.truncated).toBe(true);
    expect(r2.text.length).toBeLessThan(many.length);
  });
});

describe('composeNotice', () => {
  const bounds: ResultBounds = { shown: 500, total: 1200, unit: 'matches', moreHint: 'narrow the pattern' };

  it('renders nothing when neither a tool bound nor a cap fired', () => {
    expect(composeNotice(undefined, null)).toBe('');
  });

  it('renders a declared bound with the tool\'s own hint', () => {
    expect(composeNotice(bounds, null)).toBe(
      '\n[showing 500 of 1200 matches — narrow the pattern]',
    );
  });

  // Correction, not a weakening: the OLD wording ('at least 2000' when shown
  // is also 2000) read as a tautology — "showing 2000 of at least 2000 files"
  // says "that's all of them", the opposite of what total: null means (the
  // walk stopped counting; more may exist). This asserts the fixed wording,
  // which states plainly that more may exist and the count is unknown.
  it('renders an unknown total as "more may exist, count unknown" — never a number that reads as complete', () => {
    const open: ResultBounds = { shown: 2000, total: null, unit: 'files', moreHint: 'narrow the glob' };
    const out = composeNotice(open, null);
    expect(out).toBe(
      '\n[showing 2000 files (more may exist — exact total unknown) — narrow the glob]',
    );
    // The bug this replaces: a rendering where the "total" side is the SAME
    // number as `shown`, which reads as "that is all of them" rather than "we
    // don't know how many more there are".
    expect(out).not.toMatch(/of 2000 files/);
    expect(out).not.toContain('at least');
  });

  it('names both facts in ONE line when a tool bound and a cap both fire', () => {
    const out = composeNotice(bounds, { shown: 30_000, total: 4_200_000 });
    expect(out.split('\n').filter(Boolean)).toHaveLength(1);
    expect(out).toContain('30000 of 4200000 chars');
    expect(out).toContain('500 of 1200 matches');
    expect(out).toContain('narrow the pattern');
  });

  it('never invents advice when a cap fires and the tool declared no bounds', () => {
    const out = composeNotice(undefined, { shown: 30_000, total: 90_000 });
    expect(out).toBe('\n[output truncated: showing 30000 of 90000 chars]');
    expect(out).not.toContain('offset');
    expect(out).not.toContain('limit');
  });

  // Task 19: the gap three independent reviews found. `bounds` describes what the
  // TOOL dropped; the pipeline cap in defineTool is a SEPARATE event that fires on
  // its own schedule. When only the cap fires, the model used to get a bare byte
  // count and no way to widen — the COMMON case for content-mode Grep, not an edge.
  it('uses the tool\'s static hint when the pipeline cap fires and the tool declared no bounds', () => {
    const out = composeNotice(undefined, { shown: 4169, total: 6691 }, 'narrow the pattern');
    expect(out).toContain('4169 of 6691 chars');
    expect(out).toContain('narrow the pattern');
  });

  it('still emits no advice when neither a bound nor a static hint is available', () => {
    // Honest fallback preserved: we never invent advice we do not have.
    expect(composeNotice(undefined, { shown: 10, total: 20 }, undefined))
      .toBe('\n[output truncated: showing 10 of 20 chars]');
  });

  it('prefers the bound\'s own hint over the static one when both exist', () => {
    const b = { shown: 5, total: 9, unit: 'files' as const, moreHint: 'specific hint' };
    expect(composeNotice(b, null, 'static hint')).toContain('specific hint');
    expect(composeNotice(b, null, 'static hint')).not.toContain('static hint');
  });
});

describe('truncateOutput reports the true input size', () => {
  it('returns totalChars of the ORIGINAL text, not the retained slice', () => {
    const big = 'x'.repeat(50_000);
    const r = truncateOutput(big, { maxChars: 10_000 });
    expect(r.truncated).toBe(true);
    expect(r.totalChars).toBe(50_000);
  });

  it('no longer appends its own advice string', () => {
    const big = 'x'.repeat(50_000);
    const r = truncateOutput(big, { maxChars: 10_000 });
    expect(r.text).not.toContain('offset/limit');
    expect(r.text).not.toContain('[truncated —');
  });
});

// Bash-only line-aware slicing (2026-08-10 harness review, Claim 5). Additive
// to truncateOutput/composeNotice above, not a replacement — see the WHY block
// in truncate.ts for why these stay separate functions rather than changing
// the shared pair WebFetch also routes through.
describe('takeHeadLines', () => {
  it('passes short text through untouched when it fits both budgets', () => {
    const r = takeHeadLines('a\nb\nc', 100, 10);
    expect(r).toEqual({ text: 'a\nb\nc', lines: 3, chars: 5 });
  });

  it('stops at the LINE budget when lines are short (chars would allow more)', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    const r = takeHeadLines(text, 1_000_000, 5);
    expect(r.lines).toBe(5);
    expect(r.text.split('\n')).toEqual(['line0', 'line1', 'line2', 'line3', 'line4']);
  });

  it('stops at the CHAR budget when lines are long (line count would allow more)', () => {
    // 5 lines of 20 chars each (21 with the joining '\n'): a 60-char budget
    // fits exactly 2 full lines (42 chars) but not a 3rd (63 chars), while the
    // line budget (100) would allow all 5 — the char budget must win.
    const text = Array.from({ length: 5 }, (_, i) => `line${i}`.padEnd(20, '_')).join('\n');
    const r = takeHeadLines(text, 60, 100);
    expect(r.lines).toBe(2);
    expect(r.chars).toBeLessThanOrEqual(60);
    // Never a partial line: every kept line is one of the original whole lines.
    const originalLines = text.split('\n');
    for (const line of r.text.split('\n')) expect(originalLines).toContain(line);
  });

  // The exact defect the review measured: a seq-like run must never hand back
  // a line with digits missing from either end.
  it('never returns a line cut mid-token — the seq 1 20000 regression', () => {
    const text = Array.from({ length: 20_000 }, (_, i) => String(i + 1)).join('\n');
    const r = takeHeadLines(text, 2_000, 50);
    for (const line of r.text.split('\n')) {
      expect(line).toMatch(/^\d+$/); // a corrupted cut would produce a truncated numeral or empty fragment
    }
  });

  it('falls back to a labeled partial slice when a single line alone exceeds the whole budget', () => {
    const oneHugeLine = 'y'.repeat(5000);
    const r = takeHeadLines(oneHugeLine, 2000, 50);
    expect(r.chars).toBe(2000);
    expect(r.lines).toBe(0); // signals "not a whole line" to the caller
    expect(r.text.length).toBe(2000);
  });

  it('returns empty for empty input', () => {
    expect(takeHeadLines('', 100, 10)).toEqual({ text: '', lines: 0, chars: 0 });
  });
});

describe('takeTailLines', () => {
  it('passes short text through untouched when it fits both budgets', () => {
    const r = takeTailLines('a\nb\nc', 100, 10);
    expect(r).toEqual({ text: 'a\nb\nc', lines: 3, chars: 5 });
  });

  it('keeps the LAST N lines, not the first', () => {
    const text = Array.from({ length: 100 }, (_, i) => `line${i}`).join('\n');
    const r = takeTailLines(text, 1_000_000, 5);
    expect(r.text.split('\n')).toEqual(['line95', 'line96', 'line97', 'line98', 'line99']);
  });

  it('never returns a line cut mid-token from the end — the seq 1 20000 regression', () => {
    const text = Array.from({ length: 20_000 }, (_, i) => String(i + 1)).join('\n');
    const r = takeTailLines(text, 2_000, 50);
    for (const line of r.text.split('\n')) {
      expect(line).toMatch(/^\d+$/);
    }
    // The very last kept line must be the command's true last line, unmangled.
    expect(r.text.split('\n').at(-1)).toBe('20000');
  });

  it('falls back to a labeled partial slice (from the END of the line) when a single line exceeds the budget', () => {
    const oneHugeLine = 'a'.repeat(3000) + 'TAIL-MARK';
    const r = takeTailLines(oneHugeLine, 2000, 50);
    expect(r.lines).toBe(0);
    expect(r.text.endsWith('TAIL-MARK')).toBe(true);
    expect(r.text.length).toBe(2000);
  });
});
