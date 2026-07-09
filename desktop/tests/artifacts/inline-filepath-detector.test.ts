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

  it('matches a path followed by sentence-final punctuation', () => {
    // "The file is /docs/plan.md." — the trailing period is prose, not path.
    expect(detectFilepaths('The file is /docs/plan.md.')[0].path).toBe('/docs/plan.md');
    expect(detectFilepaths('Did you mean src/app.tsx?')[0].path).toBe('src/app.tsx');
    expect(detectFilepaths('Done — see docs/notes.md!')[0].path).toBe('docs/notes.md');
    expect(detectFilepaths('See /docs/plan.md. Then continue.')[0].path).toBe('/docs/plan.md');
  });

  it('is not cut short by an interior dot that looks like an extension', () => {
    // `.md` here is mid-path (followed by `.html`, not whitespace) — the match
    // must be the FULL path, not a premature stop at `.md`.
    const matches = detectFilepaths('see src/x.md.html now');
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe('src/x.md.html');
  });

  it('rejects protocol-less domains that look like bare relative paths', () => {
    expect(detectFilepaths('per w3.org/intro.html the spec says')).toEqual([]);
    expect(detectFilepaths('see example.com/page.html')).toEqual([]);
  });

  it('keeps dotted directory names that are not domains', () => {
    const matches = detectFilepaths('open docs.old/file.md');
    expect(matches).toHaveLength(1);
    expect(matches[0].path).toBe('docs.old/file.md');
  });
});
