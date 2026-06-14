import type { ArtifactRecord } from '../../shared/artifacts/types';
import type { ArtifactAction } from './artifact-actions';

export interface ArtifactState {
  sessionArtifacts: Record<string, ArtifactRecord[]>; // by sessionId
  projectArtifacts: Record<string, ArtifactRecord[]>; // by projectRoot
  pendingRefresh: Record<string, boolean>;            // by projectRoot
  // Drawer open/closed is scoped per session and remembered across switches.
  // A new/unseen session has no entry → closed by default. Consumers read the
  // ACTIVE session's flag; the open/close actions carry the sessionId.
  drawerOpenBySession: Record<string, boolean>;
  drawerExpanded: boolean;                            // panel fills the content region
  projectViewOpen: boolean;
  activeArtifactId: string | null;
}

export const initialArtifactState: ArtifactState = {
  sessionArtifacts: {},
  projectArtifacts: {},
  pendingRefresh: {},
  drawerOpenBySession: {},
  drawerExpanded: false,
  projectViewOpen: false,
  activeArtifactId: null,
};

export function artifactReducer(s: ArtifactState, a: ArtifactAction): ArtifactState {
  switch (a.type) {
    case 'SESSION_ARTIFACTS_LOADED':
      return { ...s, sessionArtifacts: { ...s.sessionArtifacts, [a.sessionId]: a.artifacts } };
    case 'ARTIFACT_CHANGED':
      return { ...s, pendingRefresh: { ...s.pendingRefresh, [a.projectRoot]: true } };
    case 'DRAWER_OPENED':
      return { ...s, drawerOpenBySession: { ...s.drawerOpenBySession, [a.sessionId]: true } };
    case 'DRAWER_CLOSED':
      // Reset expand so a re-opened drawer starts at its normal width.
      return {
        ...s,
        drawerOpenBySession: { ...s.drawerOpenBySession, [a.sessionId]: false },
        drawerExpanded: false,
        activeArtifactId: null,
      };
    case 'DRAWER_EXPAND_TOGGLED':
      return { ...s, drawerExpanded: !s.drawerExpanded };
    case 'ACTIVE_ARTIFACT_SET':
      return { ...s, activeArtifactId: a.artifactId };
    // Back gesture in detail view: return to list without closing the drawer.
    case 'ACTIVE_ARTIFACT_CLEARED':
      return { ...s, activeArtifactId: null };
    case 'PROJECT_VIEW_OPENED':
      return { ...s, projectViewOpen: true };
    case 'PROJECT_VIEW_CLOSED':
      return { ...s, projectViewOpen: false };
    default:
      return s;
  }
}
