import { describe, it, expect } from 'vitest';
import { artifactReducer, initialArtifactState } from '../../src/renderer/state/artifact-tracker';

const open = (s = initialArtifactState) =>
  artifactReducer(s, { type: 'GIT_REVIEW_OPENED', sessionId: 's1' } as any);

describe('git review view state', () => {
  it('defaults closed', () => {
    expect(initialArtifactState.gitReviewBySession).toEqual({});
  });

  it('GIT_REVIEW_OPENED / GIT_REVIEW_CLOSED flip the per-session flag', () => {
    let s = open();
    expect(s.gitReviewBySession['s1']).toBe(true);
    s = artifactReducer(s, { type: 'GIT_REVIEW_CLOSED', sessionId: 's1' } as any);
    expect(s.gitReviewBySession['s1']).toBe(false);
  });

  it('DRAWER_CLOSED clears the flag for that session', () => {
    let s = open();
    s = artifactReducer(s, { type: 'DRAWER_CLOSED', sessionId: 's1' } as any);
    expect(s.gitReviewBySession['s1']).toBeFalsy();
  });

  it('selecting a different artifact exits review (view follows the file)', () => {
    let s = open();
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 's1', artifactId: 'a2' } as any);
    expect(s.gitReviewBySession['s1']).toBe(false);
  });

  it('is per-session', () => {
    const s = open();
    expect(s.gitReviewBySession['s2']).toBeUndefined();
  });
});
