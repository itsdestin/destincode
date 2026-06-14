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
  // Selected artifact is per-session (keyed by sessionId; ProjectView uses the
  // literal 'project-view' key), so both carry the sessionId being selected in.
  | { type: 'ACTIVE_ARTIFACT_SET'; sessionId: string; artifactId: string }
  // Clears the session's selection back to null (back gesture goes to the list).
  | { type: 'ACTIVE_ARTIFACT_CLEARED'; sessionId: string }
  | { type: 'PROJECT_VIEW_OPENED' }
  | { type: 'PROJECT_VIEW_CLOSED' };
