import type { ArtifactRecord } from '../../shared/artifacts/types';
import type { ArtifactAction } from './artifact-actions';

export interface ArtifactState {
  sessionArtifacts: Record<string, ArtifactRecord[]>; // by sessionId
  sessionCwd: Record<string, string>;                 // sessionId → working dir
  projectArtifacts: Record<string, ArtifactRecord[]>; // by projectRoot
  pendingRefresh: Record<string, boolean>;            // by projectRoot
  // Drawer open/closed is scoped per session and remembered across switches.
  // A new/unseen session has no entry → closed by default. Consumers read the
  // ACTIVE session's flag; the open/close actions carry the sessionId.
  drawerOpenBySession: Record<string, boolean>;
  drawerExpanded: boolean;                            // panel fills the content region
  projectViewOpen: boolean;
  // Selected artifact is scoped per session (keyed by sessionId), so each
  // session's drawer remembers which file was open across session switches.
  // ProjectView uses the literal 'project-view' key for its own selection.
  activeArtifactBySession: Record<string, string | null>;
}

export const initialArtifactState: ArtifactState = {
  sessionArtifacts: {},
  sessionCwd: {},
  projectArtifacts: {},
  pendingRefresh: {},
  drawerOpenBySession: {},
  drawerExpanded: false,
  projectViewOpen: false,
  activeArtifactBySession: {},
};

export function artifactReducer(s: ArtifactState, a: ArtifactAction): ArtifactState {
  switch (a.type) {
    case 'SESSION_ARTIFACTS_LOADED':
      return { ...s, sessionArtifacts: { ...s.sessionArtifacts, [a.sessionId]: a.artifacts } };
    case 'SESSION_ARTIFACT_UPSERTED': {
      const existing = s.sessionArtifacts[a.sessionId] ?? [];
      const i = existing.findIndex((x) => x.id === a.artifact.id);
      const next = i >= 0
        ? existing.map((x, j) => (j === i ? a.artifact : x))
        : [...existing, a.artifact];
      return { ...s, sessionArtifacts: { ...s.sessionArtifacts, [a.sessionId]: next } };
    }
    case 'SET_SESSION_CWD':
      return { ...s, sessionCwd: { ...s.sessionCwd, [a.sessionId]: a.cwd } };
    case 'ARTIFACT_CHANGED':
      return { ...s, pendingRefresh: { ...s.pendingRefresh, [a.projectRoot]: true } };
    case 'DRAWER_OPENED':
      return { ...s, drawerOpenBySession: { ...s.drawerOpenBySession, [a.sessionId]: true } };
    case 'DRAWER_CLOSED':
      // Reset expand + clear this session's selection so a re-opened drawer
      // starts at its normal width on the list.
      return {
        ...s,
        drawerOpenBySession: { ...s.drawerOpenBySession, [a.sessionId]: false },
        drawerExpanded: false,
        activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: null },
      };
    case 'DRAWER_EXPAND_TOGGLED':
      return { ...s, drawerExpanded: !s.drawerExpanded };
    case 'ACTIVE_ARTIFACT_SET':
      return { ...s, activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: a.artifactId } };
    // Back gesture in detail view: return to list without closing the drawer.
    case 'ACTIVE_ARTIFACT_CLEARED':
      return { ...s, activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: null } };
    case 'PROJECT_VIEW_OPENED':
      return { ...s, projectViewOpen: true };
    case 'PROJECT_VIEW_CLOSED':
      return { ...s, projectViewOpen: false };
    default:
      return s;
  }
}
