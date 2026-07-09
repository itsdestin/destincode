import { describe, expect, it } from 'vitest';
import { detectDelimiter, parseDelimited } from '../../src/renderer/components/artifact-views/csv-parse';

describe('detectDelimiter', () => {
  it('defaults to comma', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });
  it('picks tab when the first line is tab-heavy', () => {
    expect(detectDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
  });
  it('picks semicolon for European-locale exports', () => {
    expect(detectDelimiter('a;b;c\n1;2;3')).toBe(';');
  });
  it('forces tab for .tsv regardless of content', () => {
    expect(detectDelimiter('a,b\tc', 'tsv')).toBe('\t');
  });
  it('ignores delimiters inside quotes when counting', () => {
    expect(detectDelimiter('"a;b;c;d",x\n1,2')).toBe(',');
  });
});

describe('parseDelimited', () => {
  it('parses simple rows', () => {
    expect(parseDelimited('a,b\n1,2\n', ',')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('handles CRLF line endings', () => {
    expect(parseDelimited('a,b\r\n1,2\r\n', ',')).toEqual([['a', 'b'], ['1', '2']]);
  });
  it('handles quoted fields containing the delimiter', () => {
    expect(parseDelimited('"a,b",c', ',')).toEqual([['a,b', 'c']]);
  });
  it('handles quoted fields containing newlines', () => {
    expect(parseDelimited('"line1\nline2",x', ',')).toEqual([['line1\nline2', 'x']]);
  });
  it('unescapes doubled quotes', () => {
    expect(parseDelimited('"say ""hi""",x', ',')).toEqual([['say "hi"', 'x']]);
  });
  it('keeps empty fields', () => {
    expect(parseDelimited('a,,c', ',')).toEqual([['a', '', 'c']]);
  });
  it('parses the final row without a trailing newline', () => {
    expect(parseDelimited('a,b\n1,2', ',')).toEqual([['a', 'b'], ['1', '2']]);
  });
});
