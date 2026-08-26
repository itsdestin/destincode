// The over-cap read decision (spec §4.2), pinned as a pure function.
//
// Why these cases and not others: each one is a shape that made a PREVIOUS
// version of this feature show something false. A half-written last line reads
// as file corruption; a minified file with no newline at all would have come
// back as an empty pane; a short header line followed by one enormous line
// would have come back as five bytes under a banner claiming megabytes; and an
// over-cap image used to be refused by the TEXT editor's error message, which
// is the bug this whole workstream exists to fix.
import { describe, it, expect } from 'vitest';
import { textPrefix, decideOverCapRead } from '../src/shared/artifacts/over-cap-read';

const enc = new TextEncoder();

describe('textPrefix', () => {
  it('cuts back to the last newline so no line is shown half-written', () => {
    expect(textPrefix(enc.encode('alpha\nbravo\ncharlie-cut'), 20)).toBe('alpha\nbravo\n');
  });

  it('returns everything when the buffer already fits', () => {
    expect(textPrefix(enc.encode('alpha\nbravo\n'), 999)).toBe('alpha\nbravo\n');
  });

  // Minified JS and one-line JSON have NO newline. The newline rule alone would
  // return an empty string and a blank pane.
  it('falls back to a character boundary when there is no newline at all', () => {
    expect(textPrefix(enc.encode('x'.repeat(100)), 40)).toBe('x'.repeat(40));
  });

  // A short header line followed by one enormous line would otherwise yield a
  // five-byte pane under a banner claiming to show megabytes.
  it('ignores a newline that would throw away most of the window', () => {
    const buf = enc.encode('head\n' + 'x'.repeat(200));
    expect(textPrefix(buf, 100).length).toBe(100);
  });

  it('never splits a multi-byte character', () => {
    const buf = enc.encode('x'.repeat(40) + 'é' + 'x'.repeat(40)); // é = C3 A9
    expect(textPrefix(buf, 41)).toBe('x'.repeat(40));
    expect(textPrefix(buf, 42)).toBe('x'.repeat(40) + 'é');
  });

  it('returns an empty string for an empty buffer', () => {
    expect(textPrefix(new Uint8Array(0), 10)).toBe('');
  });
});

describe('decideOverCapRead', () => {
  it('hands an over-cap binary file to the handoff, not the text path', () => {
    const head = new Uint8Array(64); // all-zero: a NUL byte makes it binary
    const res = decideOverCapRead(head, head);
    expect(res.binary).toBe(true);
    expect(res.content).toBeNull();
    expect(res.truncated).toBe(false);
  });

  it('returns a newline-trimmed prefix for over-cap text', () => {
    const buf = enc.encode(('a'.repeat(99) + '\n').repeat(2000));
    const res = decideOverCapRead(buf.subarray(0, 8192), buf);
    expect(res.truncated).toBe(true);
    expect(res.binary).toBe(false);
    expect(res.content!.endsWith('\n')).toBe(true);
  });
});
