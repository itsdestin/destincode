import type { ArtifactRecord } from '../../shared/artifacts/types';
import type { ArtifactAction } from './artifact-actions';

export interface ArtifactState {
  sessionArtifacts: Record<string, ArtifactRecord[]>; // by sessionId
  projectArtifacts: Record<string, ArtifactRecord[]>; // by projectRoot
  pendingRefresh: Record<string, boolean>;            // by projectRoot
  drawerOpen: boolean;
  projectViewOpen: boolean;
  activeArtifactId: string | null;
}

export const initialArtifactState: ArtifactState = {
  sessionArtifacts: {},
  projectArtifacts: {},
  pendingRefresh: {},
  drawerOpen: false,
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
      return { ...s, drawerOpen: true };
    case 'DRAWER_CLOSED':
      return { ...s, drawerOpen: false, activeArtifactId: null };
    case 'ACTIVE_ARTIFACT_SET':
      return { ...s, activeArtifactId: a.artifactId };
    case 'PROJECT_VIEW_OPENED':
      return { ...s, projectViewOpen: true };
    case 'PROJECT_VIEW_CLOSED':
      return { ...s, projectViewOpen: false };
    default:
      return s;
  }
}
