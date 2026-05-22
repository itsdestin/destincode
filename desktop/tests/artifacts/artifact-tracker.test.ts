import { describe, expect, it } from 'vitest';
import {
  initialArtifactState,
  artifactReducer,
} from '../../src/renderer/state/artifact-tracker';
import type { ArtifactRecord } from '../../src/shared/artifacts/types';

const sampleArtifact: ArtifactRecord = {
  id: 'art_1',
  path: 'a.md',
  kind: 'internal',
  absolutePath: null,
  lastModified: 'now',
  status: 'active',
  versions: [{ id: 'v1', ts: 'now', sessionId: 's1', type: 'create', author: 'agent' }],
  comments: [],
  tags: [],
};

describe('artifactReducer', () => {
  it('SESSION_ARTIFACTS_LOADED replaces sessionArtifacts', () => {
    const next = artifactReducer(initialArtifactState, {
      type: 'SESSION_ARTIFACTS_LOADED',
      sessionId: 's1',
      artifacts: [sampleArtifact],
    });
    expect(next.sessionArtifacts['s1']).toEqual([sampleArtifact]);
  });

  it('ARTIFACT_CHANGED triggers re-fetch flag', () => {
    const next = artifactReducer(initialArtifactState, {
      type: 'ARTIFACT_CHANGED',
      projectRoot: '/p',
      artifactId: 'art_1',
    });
    expect(next.pendingRefresh['/p']).toBe(true);
  });

  it('DRAWER_OPENED sets drawerOpen', () => {
    const next = artifactReducer(initialArtifactState, { type: 'DRAWER_OPENED' });
    expect(next.drawerOpen).toBe(true);
  });

  it('DRAWER_CLOSED clears drawerOpen and activeArtifactId', () => {
    let s = artifactReducer(initialArtifactState, { type: 'DRAWER_OPENED' });
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', artifactId: 'art_1' });
    s = artifactReducer(s, { type: 'DRAWER_CLOSED' });
    expect(s.drawerOpen).toBe(false);
    expect(s.activeArtifactId).toBeNull();
  });
});
