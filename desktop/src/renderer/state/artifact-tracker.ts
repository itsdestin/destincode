import type { ArtifactRecord } from '../../shared/artifacts/types';
import type { ArtifactAction } from './artifact-actions';

export interface ArtifactState {
  sessionArtifacts: Record<string, ArtifactRecord[]>; // by sessionId
  sessionCwd: Record<string, string>;                 // sessionId → working dir
  projectArtifacts: Record<string, ArtifactRecord[]>; // by projectRoot
  // A pill click that couldn't resolve (per session). SessionDrawer shows this
  // instead of the "no files yet" empty state; cleared on the next pill click,
  // a successful selection, or drawer close.
  pillError: Record<string, string | null>;
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
  /** Per-session: the drawer is showing the git review sub-view for the active file. */
  gitReviewBySession: Record<string, boolean>;
}

export const initialArtifactState: ArtifactState = {
  sessionArtifacts: {},
  sessionCwd: {},
  projectArtifacts: {},
  pillError: {},
  drawerOpenBySession: {},
  drawerExpanded: false,
  projectViewOpen: false,
  activeArtifactBySession: {},
  gitReviewBySession: {},
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
    case 'PILL_RESOLVE_FAILED':
      return { ...s, pillError: { ...s.pillError, [a.sessionId]: a.message } };
    case 'PILL_ERROR_CLEARED':
      return { ...s, pillError: { ...s.pillError, [a.sessionId]: null } };
    case 'DRAWER_OPENED':
      return { ...s, drawerOpenBySession: { ...s.drawerOpenBySession, [a.sessionId]: true } };
    case 'DRAWER_CLOSED':
      // Reset expand + clear this session's selection (and any pill-error note)
      // so a re-opened drawer starts at its normal width on the list.
      return {
        ...s,
        drawerOpenBySession: { ...s.drawerOpenBySession, [a.sessionId]: false },
        drawerExpanded: false,
        activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: null },
        pillError: { ...s.pillError, [a.sessionId]: null },
        gitReviewBySession: { ...s.gitReviewBySession, [a.sessionId]: false },
      };
    case 'DRAWER_EXPAND_TOGGLED':
      return { ...s, drawerExpanded: !s.drawerExpanded };
    case 'ACTIVE_ARTIFACT_SET':
      return {
        ...s,
        activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: a.artifactId },
        // A successful open supersedes any earlier failure note.
        pillError: { ...s.pillError, [a.sessionId]: null },
        // Clicking a file in the list always lands on the file view — the review
        // view belongs to the file it was opened from, not the newly selected one.
        gitReviewBySession: { ...s.gitReviewBySession, [a.sessionId]: false },
      };
    // Back gesture in detail view: return to list without closing the drawer.
    case 'ACTIVE_ARTIFACT_CLEARED':
      return { ...s, activeArtifactBySession: { ...s.activeArtifactBySession, [a.sessionId]: null } };
    case 'PROJECT_VIEW_OPENED':
      return { ...s, projectViewOpen: true };
    case 'PROJECT_VIEW_CLOSED':
      return { ...s, projectViewOpen: false };
    case 'GIT_REVIEW_OPENED':
      return { ...s, gitReviewBySession: { ...s.gitReviewBySession, [a.sessionId]: true } };
    case 'GIT_REVIEW_CLOSED':
      return { ...s, gitReviewBySession: { ...s.gitReviewBySession, [a.sessionId]: false } };
    default:
      return s;
  }
}
