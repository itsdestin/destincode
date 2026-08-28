import { describe, it, expect } from 'vitest';
import { artifactReducer, initialArtifactState } from '../src/renderer/state/artifact-tracker';

const S = 'sess';
const ref = { provider: 'claude' as const, id: 'abc', title: 'T', lastActive: '2026-07-26T00:00:00Z' };

describe('session preview exclusivity', () => {
  it('SESSION_PREVIEW_SET clears the active artifact and opens the drawer', () => {
    let s = artifactReducer(initialArtifactState, { type: 'ACTIVE_ARTIFACT_SET', sessionId: S, artifactId: 'art1' });
    s = artifactReducer(s, { type: 'SESSION_PREVIEW_SET', sessionId: S, provider: 'claude', id: 'abc', title: 'T' });
    expect(s.activeArtifactBySession[S]).toBeNull();
    expect(s.activeSessionPreviewBySession[S]).toEqual({ provider: 'claude', id: 'abc', title: 'T' });
    expect(s.drawerOpenBySession[S]).toBe(true);
  });
  it('ACTIVE_ARTIFACT_SET clears the preview', () => {
    let s = artifactReducer(initialArtifactState, { type: 'SESSION_PREVIEW_SET', sessionId: S, provider: 'claude', id: 'abc', title: 'T' });
    s = artifactReducer(s, { type: 'ACTIVE_ARTIFACT_SET', sessionId: S, artifactId: 'art1' });
    expect(s.activeSessionPreviewBySession[S]).toBeNull();
    expect(s.activeArtifactBySession[S]).toBe('art1');
  });
  it('DRAWER_CLOSED clears both', () => {
    let s = artifactReducer(initialArtifactState, { type: 'SESSION_PREVIEW_SET', sessionId: S, provider: 'claude', id: 'abc', title: 'T' });
    s = artifactReducer(s, { type: 'DRAWER_CLOSED', sessionId: S });
    expect(s.activeSessionPreviewBySession[S]).toBeNull();
    expect(s.activeArtifactBySession[S]).toBeNull();
  });
  it('SESSION_REFERENCED dedupes by provider+id, newest first', () => {
    let s = artifactReducer(initialArtifactState, { type: 'SESSION_REFERENCED', sessionId: S, ref });
    s = artifactReducer(s, { type: 'SESSION_REFERENCED', sessionId: S, ref: { ...ref, id: 'def' } });
    s = artifactReducer(s, { type: 'SESSION_REFERENCED', sessionId: S, ref });
    expect(s.referencedSessionsBySession[S].map((r) => r.id)).toEqual(['abc', 'def']);
  });
});
