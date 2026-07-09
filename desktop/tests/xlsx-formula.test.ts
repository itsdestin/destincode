import { describe, it, expect } from 'vitest';
import { evalFormula } from '../src/renderer/components/artifact-views/xlsx-formula';

// Simulate a sheet: B column = quantities, C = prices (matches the screenshot).
const cells: Record<string, number | string> = {
  B2: 10, C2: 0.5, B3: 24, C3: 0.3, B4: 5, C4: 2.75, B5: 8, C5: 4.2, B6: 12, C6: 0.25,
  A1: 'Item', A7: 'Grand Total',
};
const resolve = (ref: string) => (ref in cells ? cells[ref] : null);

describe('evalFormula', () => {
  it('multiplies cell refs (=B4*C4)', () => {
    expect(evalFormula('=B4*C4', resolve)).toBeCloseTo(13.75);
  });
  it('adds (=B2+C2)', () => {
    expect(evalFormula('=B2+C2', resolve)).toBeCloseTo(10.5);
  });
  it('SUM over a range', () => {
    expect(evalFormula('=SUM(B2:B6)', resolve)).toBe(59);
  });
  it('SUM of products (grand total pattern)', () => {
    // =B2*C2+B3*C3+B4*C4+B5*C5+B6*C6
    expect(evalFormula('=B2*C2+B3*C3+B4*C4+B5*C5+B6*C6', resolve)).toBeCloseTo(5 + 7.2 + 13.75 + 33.6 + 3);
  });
  it('AVERAGE / MIN / MAX / COUNT', () => {
    expect(evalFormula('=AVERAGE(B2:B6)', resolve)).toBeCloseTo(11.8);
    expect(evalFormula('=MIN(B2:B6)', resolve)).toBe(5);
    expect(evalFormula('=MAX(B2:B6)', resolve)).toBe(24);
    expect(evalFormula('=COUNT(B2:B6)', resolve)).toBe(5);
  });
  it('parens + precedence', () => {
    expect(evalFormula('=(B2+B3)*2', resolve)).toBe(68);
    expect(evalFormula('=B2+B3*2', resolve)).toBe(58);
  });
  it('percent and power', () => {
    expect(evalFormula('=50%', resolve)).toBeCloseTo(0.5);
    expect(evalFormula('=2^10', resolve)).toBe(1024);
  });
  it('ROUND and IF', () => {
    expect(evalFormula('=ROUND(C4,1)', resolve)).toBe(2.8);
    expect(evalFormula('=IF(B4>3,"big","small")', resolve)).toBe('big');
  });
  it('empty cells count as 0 in arithmetic', () => {
    expect(evalFormula('=B2+Z9', resolve)).toBe(10);
  });
  it('throws on unsupported function so caller can fall back', () => {
    expect(() => evalFormula('=VLOOKUP(A1,B:C,2)', resolve)).toThrow();
  });
  it('IF short-circuits — unsupported function in the UNTAKEN branch is fine', () => {
    // Real Excel only evaluates the taken branch. B4=5 so cond is true and the
    // VLOOKUP in the else-branch must never run (previously it threw and the
    // whole cell went blank). (Args must still TOKENIZE — column ranges like
    // B:C fail at the lexer, before short-circuiting can help.)
    expect(evalFormula('=IF(B4>3,SUM(B2:B6),VLOOKUP(A1,B2,2))', resolve)).toBe(59);
    expect(evalFormula('=IF(B4>99,VLOOKUP(A1,B2,2),SUM(B2:B6))', resolve)).toBe(59);
  });
  it('IF short-circuits division by zero in the untaken branch', () => {
    // Also exercises empty-cell-as-0 numeric comparison (Z9 is blank → Z9=0 TRUE).
    expect(evalFormula('=IF(Z9=0,0,1/Z9)', resolve)).toBe(0);
  });
  it('nested IF branches skip correctly (paren depth tracking)', () => {
    expect(evalFormula('=IF(B4>3,IF(B2>5,"both","one"),VLOOKUP(A1,B2,2))', resolve)).toBe('both');
  });
  it('division by zero throws (renders blank, not Infinity)', () => {
    expect(() => evalFormula('=1/0', resolve)).toThrow();
    expect(() => evalFormula('=B2/Z9', resolve)).toThrow();
  });
});
