// useOpenFilepath — the ONE resolve-and-open path for "a file mentioned in
// chat". Extracted from FilepathToken (2026-08-25) so the SendUserFile card
// opens files by exactly the same rules as a filepath pill: session list →
// whole project → artifactify. Two copies of this logic would drift; the pill
// and the card must never disagree about whether a click opens something.
//
// Contract: clicking a file in chat ALWAYS opens the artifact viewer, NEVER
// Project View (artifacts rule → UI invariants).
import { useCallback } from 'react';
import { useArtifactOptional } from '../state/ArtifactContext';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { findBestMatch, buildArtifactifyArgs } from '../components/filepath-match';

export function useOpenFilepath(sessionId: string): (path: string) => Promise<void> {
  // Optional: the buddy window / sandbox render without ArtifactProvider. The
  // caller still renders its pill/card; the click is a no-op there.
  const artifactCtx = useArtifactOptional();

  return useCallback(async (path: string) => {
    if (!artifactCtx) return;
    const { state, dispatch } = artifactCtx;
    const name = path.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? path;

    // Open the drawer first so there's an immediate response regardless of how
    // the lookup below resolves. If resolution fails, set a pill-error note —
    // otherwise the drawer's generic "no files yet" empty state would directly
    // contradict the file the user just clicked.
    dispatch({ type: 'DRAWER_OPENED', sessionId });
    dispatch({ type: 'PILL_ERROR_CLEARED', sessionId });
    const failed = () => dispatch({
      type: 'PILL_RESOLVE_FAILED',
      sessionId,
      message: `Couldn’t open ${name} — the file wasn’t found in this project.`,
    });

    // 1. Already in this session's live list? Select it. findBestMatch prefers
    //    an exact path match over the suffix-tolerant fallback so a same-named
    //    file elsewhere can't shadow it.
    const sessMatch = findBestMatch(state.sessionArtifacts[sessionId] ?? [], path);
    if (sessMatch) {
      dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: sessMatch.id });
      return;
    }

    // 2. Not in this session — resolve against the WHOLE project: every tracked
    //    artifact (any session, including deleted) plus on-disk files, and
    //    inject the match into the session list so the drawer can show it.
    const cwd = state.sessionCwd?.[sessionId];
    if (!cwd) { failed(); return; } // nothing to resolve without a root — say so
    try {
      const [projRes, filesRes] = await Promise.all([
        (window.claude as any).artifacts.listProject(cwd),
        (window.claude as any).artifacts.listAllFiles(cwd),
      ]);
      const trackedList: ArtifactRecord[] = projRes?.ok ? (projRes.artifacts ?? []) : [];
      const filesList: ArtifactRecord[] = filesRes?.ok ? (filesRes.files ?? []) : [];
      const projMatch: ArtifactRecord | undefined =
        findBestMatch(trackedList, path) ?? findBestMatch(filesList, path);
      if (projMatch) {
        dispatch({ type: 'SESSION_ARTIFACT_UPSERTED', sessionId, artifact: projMatch });
        dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: projMatch.id });
        return;
      }

      // 3. Nothing matched anywhere — ARTIFACTIFY the path. A file visible in
      //    chat must open no matter how it was created or where it lives.
      //    appendVersion records it (author 'user', type 'read'); this is the
      //    only path that PERSISTS a brand-new artifact.
      const args = buildArtifactifyArgs(path, cwd);
      if (!args) { failed(); return; } // e.g. a ~/ path the renderer can't expand
      await (window.claude as any).artifacts.appendVersion(cwd, sessionId, args);
      const refreshed = await (window.claude as any).artifacts.listSession(sessionId, cwd);
      let selected = false;
      if (refreshed?.ok && Array.isArray(refreshed.artifacts)) {
        dispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: refreshed.artifacts });
        const added = findBestMatch(refreshed.artifacts as ArtifactRecord[], path);
        if (added) {
          dispatch({ type: 'ACTIVE_ARTIFACT_SET', sessionId, artifactId: added.id });
          selected = true;
        }
      }
      if (!selected) failed();
    } catch { failed(); }
  }, [artifactCtx, sessionId]);
}
