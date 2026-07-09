import { describe, it, expect } from 'vitest';
import { normalizeRepoUrl } from '../src/main/project/repo-url';

describe('normalizeRepoUrl', () => {
  it('normalizes ssh form', () => {
    expect(normalizeRepoUrl('git@github.com:itsdestin/youcoded.git'))
      .toEqual({ owner: 'itsdestin', name: 'youcoded', webUrl: 'https://github.com/itsdestin/youcoded' });
  });
  it('normalizes https form with .git', () => {
    expect(normalizeRepoUrl('https://github.com/itsdestin/youcoded.git'))
      .toEqual({ owner: 'itsdestin', name: 'youcoded', webUrl: 'https://github.com/itsdestin/youcoded' });
  });
  it('normalizes https form without .git', () => {
    expect(normalizeRepoUrl('https://github.com/itsdestin/youcoded'))
      .toEqual({ owner: 'itsdestin', name: 'youcoded', webUrl: 'https://github.com/itsdestin/youcoded' });
  });
  it('returns null for non-github hosts', () => {
    expect(normalizeRepoUrl('git@gitlab.com:foo/bar.git')).toBeNull();
  });
  it('returns null for garbage', () => {
    expect(normalizeRepoUrl('not a url')).toBeNull();
  });
});
