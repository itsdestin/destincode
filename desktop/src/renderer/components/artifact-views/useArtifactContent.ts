// useArtifactContent — the single owner of the artifacts:get read lifecycle.
// Extracted from SessionDrawer + FilesTab's ArtifactDetail, which carried two
// near-identical copies of this effect and BOTH threw away the response's
// `orphan` flag and error branch — so "still loading", "file deleted", and
// "read failed" all collapsed into content === null, and every artifact open
// flashed "This file is no longer on disk." for the read's duration.
// This hook keeps them apart via ArtifactContentState (see ActiveArtifactView).
import { useCallback, useEffect, useState } from 'react';
import type { ArtifactContentInfo, ArtifactContentState } from './ActiveArtifactView';

// Turn the handler's error codes into specific, accurate user-facing strings —
// unknown codes surface verbatim rather than being replaced with a guessed
// cause (error-message-standards).
function describeReadError(error: unknown): string {
  if (error === 'protected-path') {
    return 'This file is in a protected location (credential and system folders), so YouCoded won’t open it.';
  }
  if (error === 'artifact-not-found') {
    return 'This file could not be resolved inside the project.';
  }
  return `Couldn’t read this file: ${String(error ?? 'unknown error')}`;
}

export interface UseArtifactContentResult {
  content: string | null;
  /** Hosts pass this straight through as onContentChange — saves and
   * external-change refetches update content without re-running the read.
   * Delivering real content also reconciles the phase (missing/error →
   * ready), so a file that reappears on disk recovers without a reselect. */
  setContent: (content: string | null) => void;
  contentInfo: ArtifactContentInfo | null;
  contentState: ArtifactContentState;
  /** Re-runs the read after an error — wired to ErrorState's Retry. */
  retryRead: () => void;
}

export function useArtifactContent(
  projectRoot: string,
  artifactId: string | null | undefined,
): UseArtifactContentResult {
  const [content, setContent] = useState<string | null>(null);
  // get() metadata the content string cannot carry: binary sniff (routes
  // unknown extensions to the code view), tooLarge (renders the size notice).
  const [contentInfo, setContentInfo] = useState<ArtifactContentInfo | null>(null);
  const [contentState, setContentState] = useState<ArtifactContentState>({ phase: 'loading' });
  // Bumping the token re-runs the effect below — the Retry action.
  const [retryToken, setRetryToken] = useState(0);

  useEffect(() => {
    // No selection: park in loading (nothing renders the pane in this state).
    if (!artifactId) {
      setContent(null);
      setContentInfo(null);
      setContentState({ phase: 'loading' });
      return;
    }
    let cancelled = false;
    // Clear the PREVIOUS file's content before the read resolves. Without
    // this, switching artifacts remounts the viewer (ViewerErrorBoundary is
    // keyed by artifact.id) with stale content, so HtmlView's sandboxed iframe
    // gets a srcDoc write for the old file and a second one milliseconds later
    // for the new one — the aborted-then-restarted navigation leaves the frame
    // permanently blank.
    setContent(null);
    setContentInfo(null);
    setContentState({ phase: 'loading' });
    (window.claude as any).artifacts.get(projectRoot, artifactId).then((res: any) => {
      if (cancelled) return;
      if (res && res.ok) {
        setContent(res.content ?? null);
        setContentInfo({ binary: res.binary, tooLarge: res.tooLarge, sizeBytes: res.sizeBytes });
        // orphan:true is the handler's genuine not-found signal (ENOENT /
        // orphaned record) — the ONLY thing allowed to render "no longer on
        // disk". Everything else that resolved ok is ready.
        setContentState(res.orphan ? { phase: 'missing' } : { phase: 'ready' });
      } else {
        setContentState({ phase: 'error', message: describeReadError(res?.error) });
      }
    }).catch((e: any) => {
      // A rejected invoke (e.g. EACCES thrown in the handler) is a read
      // FAILURE, not a deleted file — surface the real error.
      if (!cancelled) {
        setContentState({ phase: 'error', message: describeReadError(e?.message ?? e) });
      }
    });
    return () => { cancelled = true; };
  }, [projectRoot, artifactId, retryToken]);

  const retryRead = useCallback(() => setRetryToken((t) => t + 1), []);

  // Reconcile phase with out-of-band content deliveries (PR #303 review fix):
  // ActiveArtifactView's onChanged watcher effect refetches on external writes
  // and hands the bytes back via onContentChange WITHOUT re-running this
  // hook's read — so a file that was 'missing' and then reappears on disk
  // (agent recreates it → watcher 'add' → refetch) would keep showing "no
  // longer on disk" until reselect. Real content arriving through any path
  // means the file is readable NOW: flip missing/error to ready.
  // A null delivery deliberately flips NOTHING: no caller signals "file is
  // gone" via onContentChange (deletion is only ever detected by the get()
  // orphan response), so treating null as missing here would guess a cause.
  const reconciledSetContent = useCallback((next: string | null) => {
    setContent(next);
    if (next !== null) {
      setContentState((prev) =>
        prev.phase === 'missing' || prev.phase === 'error' ? { phase: 'ready' } : prev);
    }
  }, []);

  return { content, setContent: reconciledSetContent, contentInfo, contentState, retryRead };
}
