import type { ArtifactRecord } from '../../shared/artifacts/types';

export type ArtifactAction =
  | { type: 'SESSION_ARTIFACTS_LOADED'; sessionId: string; artifacts: ArtifactRecord[] }
  | { type: 'ARTIFACT_CHANGED'; projectRoot: string; artifactId: string }
  | { type: 'DRAWER_OPENED' }
  | { type: 'DRAWER_CLOSED' }
  | { type: 'ACTIVE_ARTIFACT_SET'; artifactId: string }
  // Clears activeArtifactId back to null (back gesture in detail view goes to list).
  | { type: 'ACTIVE_ARTIFACT_CLEARED' }
  | { type: 'PROJECT_VIEW_OPENED' }
  | { type: 'PROJECT_VIEW_CLOSED' };
