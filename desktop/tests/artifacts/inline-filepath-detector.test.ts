import { describe, expect, it } from 'vitest';
import { detectFilepaths } from '../../src/renderer/hooks/useInlineFilepathDetector';

describe('detectFilepaths', () => {
  it('matches an absolute Unix path with whitelisted extension', () => {
    const matches = detectFilepaths('See /home/user/docs/plan.md for details');
    expect(matches).toEqual([{ path: '/home/user/docs/plan.md', start: 4, end: 27 }]);
  });

  it('matches a Windows path', () => {
    const matches = detectFilepaths('Wrote C:\\Users\\desti\\notes.md just now');
    expect(matches[0].path).toBe('C:\\Users\\desti\\notes.md');
  });

  it('matches a tilde path', () => {
    const matches = detectFilepaths('saved to ~/Documents/foo.txt');
    expect(matches[0].path).toBe('~/Documents/foo.txt');
  });

  it('matches a relative path', () => {
    const matches = detectFilepaths('open ./docs/plan.md please');
    expect(matches[0].path).toBe('./docs/plan.md');
  });

  it('does not match unwhitelisted extensions', () => {
    expect(detectFilepaths('see /tmp/x.exe')).toEqual([]);
    expect(detectFilepaths('see /tmp/x.log')).toEqual([]);
  });

  it('does not match mid-word paths', () => {
    expect(detectFilepaths('abc/foo.md.bak')).toEqual([]);
  });

  it('does not match a bare filename without separator', () => {
    expect(detectFilepaths('see plan.md')).toEqual([]);
  });

  it('matches a bare relative path with one slash (no ./ prefix)', () => {
    // Claude commonly outputs paths like `docs/foo.md` rather than `./docs/foo.md`.
    const matches = detectFilepaths('I added a line to docs/knowledge-debt.md');
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe('docs/knowledge-debt.md');
  });

  it('matches a multi-segment bare relative path', () => {
    const matches = detectFilepaths('see src/main/foo.ts');
    expect(matches[0].path).toBe('src/main/foo.ts');
  });
});
