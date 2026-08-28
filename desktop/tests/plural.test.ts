// plural() — the one pluraliser for user-facing counts (P-21 #3).
import { describe, it, expect } from 'vitest';
import { plural } from '../src/shared/plural';

describe('plural', () => {
  it('uses the singular for exactly one', () => {
    expect(plural(1, 'install')).toBe('1 install');
    expect(plural(1, 'like')).toBe('1 like');
  });

  it('adds an s for everything else, zero included', () => {
    expect(plural(0, 'install')).toBe('0 installs');
    expect(plural(2, 'like')).toBe('2 likes');
  });

  it('formats the number with locale separators', () => {
    expect(plural(1204, 'install')).toBe((1204).toLocaleString() + ' installs');
  });

  it('accepts an irregular plural form', () => {
    expect(plural(1, 'entry', 'entries')).toBe('1 entry');
    expect(plural(3, 'entry', 'entries')).toBe('3 entries');
  });
});
