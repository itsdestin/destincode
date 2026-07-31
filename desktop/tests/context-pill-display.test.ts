// Context pill display modes — the percentage vs "used / window" toggle.
//
// The load-bearing property here is that BOTH modes are colored by the same
// percentage, so switching the display never changes what green/amber/red mean.
// These tests pin the formatting decisions; the color band itself is applied by
// the caller from the same `pct` in both branches (StatusBar.tsx).
import { describe, it, expect } from 'vitest';
import { formatContextPill, derivedUsedTokens } from '../src/renderer/components/StatusBar';
import { parseContextDisplay } from '../src/renderer/state/theme-context';

describe('formatContextPill', () => {
  it('percent mode renders the percentage with a Remaining suffix', () => {
    expect(formatContextPill(45, 35_200, 64_000, 'percent')).toEqual({ value: '45%', suffix: 'Remaining' });
  });

  it('tokens mode renders used / window and drops the suffix', () => {
    // "35.2k / 64.0k" already reads as a quantity — a trailing "Remaining" would
    // actively misdescribe it, since the leading number is what has been USED.
    expect(formatContextPill(45, 35_200, 64_000, 'tokens')).toEqual({ value: '35.2k / 64.0k', suffix: '' });
  });

  it('falls back to percent when the window size is unknown', () => {
    // Native sessions can have a null context window (unknown model). Rendering
    // "35.2k / null" or a blank pill would be worse than the percentage.
    expect(formatContextPill(45, 35_200, null, 'tokens')).toEqual({ value: '45%', suffix: 'Remaining' });
  });

  it('falls back to percent when the used count is unknown', () => {
    expect(formatContextPill(45, null, 64_000, 'tokens')).toEqual({ value: '45%', suffix: 'Remaining' });
  });

  it('falls back to percent for a zero/degenerate window rather than dividing by it', () => {
    expect(formatContextPill(100, 0, 0, 'tokens')).toEqual({ value: '100%', suffix: 'Remaining' });
  });

  it('renders small token counts without a k suffix', () => {
    expect(formatContextPill(99, 120, 800, 'tokens').value).toBe('120 / 800');
  });

  it('percent mode ignores the token figures entirely', () => {
    // Guards against a refactor that starts preferring tokens when they happen
    // to be present — the pref must be the only thing that decides.
    expect(formatContextPill(12, 999_999, 1_000_000, 'percent')).toEqual({ value: '12%', suffix: 'Remaining' });
  });
});

describe('derivedUsedTokens', () => {
  it('derives consumed tokens from percent-remaining and the window', () => {
    expect(derivedUsedTokens(25, 64_000)).toBe(48_000);   // 75% consumed
    expect(derivedUsedTokens(100, 64_000)).toBe(0);       // untouched session
    expect(derivedUsedTokens(0, 64_000)).toBe(64_000);    // full
  });

  it('returns null when the window is unknown or degenerate', () => {
    expect(derivedUsedTokens(50, null)).toBeNull();
    expect(derivedUsedTokens(50, undefined)).toBeNull();
    expect(derivedUsedTokens(50, 0)).toBeNull();
  });

  it('clamps an out-of-range percentage instead of producing a negative or over-full count', () => {
    // A statusline that reports >100 or <0 must not yield a nonsense token count.
    expect(derivedUsedTokens(120, 64_000)).toBe(0);
    expect(derivedUsedTokens(-5, 64_000)).toBe(64_000);
  });
});

describe('parseContextDisplay', () => {
  it('accepts the two real modes', () => {
    expect(parseContextDisplay('percent')).toBe('percent');
    expect(parseContextDisplay('tokens')).toBe('tokens');
  });

  it('defaults anything else to percent — the long-standing behavior', () => {
    // localStorage is user-writable and survives downgrades, so a corrupt or
    // unknown value must resolve to the safe default, never a third mode.
    expect(parseContextDisplay(null)).toBe('percent');
    expect(parseContextDisplay(undefined)).toBe('percent');
    expect(parseContextDisplay('')).toBe('percent');
    expect(parseContextDisplay('Tokens')).toBe('percent');   // case-sensitive by design
    expect(parseContextDisplay('garbage')).toBe('percent');
  });
});
