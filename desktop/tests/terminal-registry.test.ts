// Tests the buffer-serialization logic of terminal-registry.getScreenText —
// in particular the tail-read added in the 2026-07-10 perf pass so the hot
// callers (prompt detector per buffer-flush, attention classifier at 1Hz)
// stop serializing the entire scrollback on every read.
import { describe, it, expect, afterEach } from 'vitest';
import { Terminal } from '@xterm/xterm';
import {
  registerTerminal,
  unregisterTerminal,
  getScreenText,
  getVisibleScreenText,
} from '../src/renderer/hooks/terminal-registry';

/**
 * Minimal fake of the xterm Terminal surface getScreenText touches:
 * `buffer.active.{length,getLine}` and `rows`. Each entry is
 * [text, isWrapped]; wrapped lines join onto the previous logical line.
 */
function fakeTerminal(lines: Array<[string, boolean]>, rows = 24): Terminal {
  return {
    rows,
    buffer: {
      active: {
        length: lines.length,
        getLine: (i: number) =>
          lines[i]
            ? {
                isWrapped: lines[i][1],
                translateToString: () => lines[i][0],
              }
            : undefined,
      },
    },
  } as unknown as Terminal;
}

const SID = 'term-test';

afterEach(() => unregisterTerminal(SID));

describe('getScreenText', () => {
  it('joins wrapped lines and returns the full buffer by default', () => {
    registerTerminal(SID, fakeTerminal([
      ['first', false],
      ['second-a', false],
      ['second-b', true],
      ['third', false],
    ]));
    expect(getScreenText(SID)).toBe('first\nsecond-asecond-b\nthird');
  });

  it('returns only the last N buffer rows when tailRows is given', () => {
    const lines: Array<[string, boolean]> = [];
    for (let i = 0; i < 1000; i++) lines.push([`line-${i}`, false]);
    registerTerminal(SID, fakeTerminal(lines));

    const tail = getScreenText(SID, 3)!;
    expect(tail).toBe('line-997\nline-998\nline-999');
  });

  it('never starts a tail read mid-wrapped-line', () => {
    // Buffer: ...,[996 false],[997 true],[998 true],[999 false]
    // A naive tail of 2 would start at 998 (a continuation row) and emit a
    // fragment; the walk-back must include rows 996+997 so the logical line
    // is complete.
    const lines: Array<[string, boolean]> = [];
    for (let i = 0; i < 997; i++) lines.push([`line-${i}`, false]);
    lines.push(['wrapped-head ', false]);   // index 997 — logical line start
    lines.push(['wrapped-tail', true]);     // index 998 — continuation
    lines.push(['last', false]);            // index 999
    registerTerminal(SID, fakeTerminal(lines));

    const tail = getScreenText(SID, 2)!;
    expect(tail).toBe('wrapped-head wrapped-tail\nlast');
  });

  it('tailRows larger than the buffer returns everything', () => {
    registerTerminal(SID, fakeTerminal([
      ['a', false],
      ['b', false],
    ]));
    expect(getScreenText(SID, 500)).toBe('a\nb');
  });

  it('returns null for unknown sessions', () => {
    expect(getScreenText('nope')).toBeNull();
  });
});

describe('getVisibleScreenText', () => {
  it('reads roughly one screen (rows + margin), not the whole scrollback', () => {
    const lines: Array<[string, boolean]> = [];
    for (let i = 0; i < 1000; i++) lines.push([`line-${i}`, false]);
    registerTerminal(SID, fakeTerminal(lines, 24));

    const text = getVisibleScreenText(SID)!;
    const got = text.split('\n');
    // Must include the full visible screen (last 24 rows)…
    expect(got[got.length - 1]).toBe('line-999');
    expect(got.length).toBeGreaterThanOrEqual(24);
    // …but must NOT serialize the whole 1000-line scrollback.
    expect(got.length).toBeLessThan(200);
  });
});
