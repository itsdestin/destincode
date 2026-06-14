import type { ArtifactRecord } from '../../shared/artifacts/types';

export type ArtifactAction =
  | { type: 'SESSION_ARTIFACTS_LOADED'; sessionId: string; artifacts: ArtifactRecord[] }
  | { type: 'ARTIFACT_CHANGED'; projectRoot: string; artifactId: string }
  // Open/close is per-session (remembered across session switches), so both
  // carry the sessionId whose drawer is being toggled.
  | { type: 'DRAWER_OPENED'; sessionId: string }
  | { type: 'DRAWER_CLOSED'; sessionId: string }
  // Expand-in-place: the drawer grows to fill the framed-shell content region
  // (chat pane hidden) while the header/input chrome stay put. Toggled by the
  // panel's expand button.
  | { type: 'DRAWER_EXPAND_TOGGLED' }
  | { type: 'ACTIVE_ARTIFACT_SET'; artifactId: string }
  // Clears activeArtifactId back to null (back gesture in detail view goes to list).
  | { type: 'ACTIVE_ARTIFACT_CLEARED' }
  | { type: 'PROJECT_VIEW_OPENED' }
  | { type: 'PROJECT_VIEW_CLOSED' };
