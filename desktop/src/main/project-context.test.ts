import { describe, it, expect } from 'vitest';
import { parseRulePaths } from './project-context';

describe('parseRulePaths', () => {
  it('parses a block YAML list under paths:', () => {
    const fm = 'paths:\n  - "youcoded/app/**"\nlast_verified: 2026-07-15\n';
    expect(parseRulePaths(fm)).toEqual(['youcoded/app/**']);
  });

  it('parses a multi-entry block list, stopping at the next key', () => {
    const fm = [
      'paths:',
      '  - "youcoded/desktop/src/main/artifacts/**"',
      '  - "youcoded/desktop/src/renderer/components/project-view/**"',
      'last_verified: 2026-07-15',
      'verify:',
      '  - path: something.ts',
    ].join('\n');
    expect(parseRulePaths(fm)).toEqual([
      'youcoded/desktop/src/main/artifacts/**',
      'youcoded/desktop/src/renderer/components/project-view/**',
    ]);
  });

  it('parses an inline array', () => {
    expect(parseRulePaths('paths: ["**"]\nlast_verified: 2026-05-04\n')).toEqual(['**']);
  });

  it('returns [] when paths: is absent (an eager rule)', () => {
    expect(parseRulePaths('last_verified: 2026-07-15\n')).toEqual([]);
  });

  it('does not let a myPaths: key shadow the real paths: key', () => {
    const fm = 'myPaths: ["decoy"]\npaths:\n  - "real/glob/**"\n';
    expect(parseRulePaths(fm)).toEqual(['real/glob/**']);
  });
});
