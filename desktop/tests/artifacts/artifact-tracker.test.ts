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

  it('PILL_RESOLVE_FAILED stores a per-session note; cleared on selection', () => {
    let s = artifactReducer(initialArtifactState, {
      type: 'PILL_RESOLVE_FAILED',
      sessionId: 's1',
      message: 'Couldn’t open x.md',
    });
    expect(s.pillError['s1']).toBe('Couldn’t open x.md');
    // A successful open supersedes the failure note.
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 's1', artifactId: 'a1' });
    expect(s.pillError['s1']).toBeNull();
  });

  it('PILL_ERROR_CLEARED and DRAWER_CLOSED clear the note', () => {
    let s = artifactReducer(initialArtifactState, {
      type: 'PILL_RESOLVE_FAILED', sessionId: 's1', message: 'nope',
    });
    s = artifactReducer(s, { type: 'PILL_ERROR_CLEARED', sessionId: 's1' });
    expect(s.pillError['s1']).toBeNull();
    s = artifactReducer(s, { type: 'PILL_RESOLVE_FAILED', sessionId: 's1', message: 'nope' });
    s = artifactReducer(s, { type: 'DRAWER_CLOSED', sessionId: 's1' });
    expect(s.pillError['s1']).toBeNull();
  });

  it('DRAWER_OPENED sets the per-session open flag', () => {
    const next = artifactReducer(initialArtifactState, { type: 'DRAWER_OPENED', sessionId: 'sess_a' });
    expect(next.drawerOpenBySession['sess_a']).toBe(true);
  });

  it('drawer open state is scoped per session', () => {
    let s = artifactReducer(initialArtifactState, { type: 'DRAWER_OPENED', sessionId: 'sess_a' });
    // A different session stays closed (no entry → undefined → treated as closed).
    expect(s.drawerOpenBySession['sess_a']).toBe(true);
    expect(s.drawerOpenBySession['sess_b']).toBeUndefined();
    // Opening B doesn't disturb A.
    s = artifactReducer(s, { type: 'DRAWER_OPENED', sessionId: 'sess_b' });
    expect(s.drawerOpenBySession['sess_a']).toBe(true);
    expect(s.drawerOpenBySession['sess_b']).toBe(true);
  });

  it('DRAWER_CLOSED clears that session and its selection', () => {
    let s = artifactReducer(initialArtifactState, { type: 'DRAWER_OPENED', sessionId: 'sess_a' });
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 'sess_a', artifactId: 'art_1' });
    s = artifactReducer(s, { type: 'DRAWER_CLOSED', sessionId: 'sess_a' });
    expect(s.drawerOpenBySession['sess_a']).toBe(false);
    expect(s.activeArtifactBySession['sess_a']).toBeNull();
  });

  it('selected artifact is scoped per session', () => {
    let s = artifactReducer(initialArtifactState, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 'sess_a', artifactId: 'art_1' });
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: 'sess_b', artifactId: 'art_2' });
    expect(s.activeArtifactBySession['sess_a']).toBe('art_1');
    expect(s.activeArtifactBySession['sess_b']).toBe('art_2');
    // Clearing one session leaves the other intact.
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_CLEARED', sessionId: 'sess_a' });
    expect(s.activeArtifactBySession['sess_a']).toBeNull();
    expect(s.activeArtifactBySession['sess_b']).toBe('art_2');
  });
});
