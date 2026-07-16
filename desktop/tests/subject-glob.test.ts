import { describe, it, expect } from 'vitest';
import { subjectMatches } from '../src/main/harness/tools/subject-glob';

describe('subjectMatches', () => {
  it('matches * within a segmentless subject (command strings)', () => {
    expect(subjectMatches('git push origin master', 'git push*')).toBe(true);
    expect(subjectMatches('git pull', 'git push*')).toBe(false);
    expect(subjectMatches('npm rm cache', '* rm *')).toBe(true);
  });
  it('matches ? and literal dots', () => {
    expect(subjectMatches('a.txt', '?.txt')).toBe(true);
    expect(subjectMatches('ab.txt', '?.txt')).toBe(false);
    expect(subjectMatches('aXtxt', 'a.txt')).toBe(false);
  });
  it('is case-insensitive on the subject (Windows paths, casual commands)', () => {
    expect(subjectMatches('Git Push origin', 'git push*')).toBe(true);
  });
  it('undefined pattern matches everything', () => {
    expect(subjectMatches('anything', undefined)).toBe(true);
  });
  it('star matches the empty string (bare "git push")', () => {
    expect(subjectMatches('git push', 'git push*')).toBe(true);
  });
});
