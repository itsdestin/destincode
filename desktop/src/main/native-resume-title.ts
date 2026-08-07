// Resume-time title re-apply for native sessions.
//
// WHY this module exists: the renderer names a resumed session 'Resuming…' as a
// placeholder, and the ONLY thing that ever renames a native session pill is
// native-title-feeder.ts's onTitle — which fires only when the feeder GENERATES
// a title. An already-titled session never regenerates (that guard is correct),
// so nothing re-pushed the stored name and the pill stayed on the placeholder
// for the life of the session. This puts the stored title back on the live
// session right after the resume completes.
//
// Deps are injected (same pattern as native-title-feeder.ts) because the real
// collaborators are a Conversation Store read and two IPC sends — and because a
// fake that cannot fail certifies the bug it should catch (youcoded #177).
import { isRealSessionName } from '../shared/session-title';

export interface ResumeTitleDeps {
  /** Reads the stored title for this native conversation. Native ids are
   *  identity-mapped, so the session id IS the store's record id. */
  getStoredTitle: (sessionId: string) => Promise<string | undefined>;
  /** Pushes the name onto the live session — the same SESSION_RENAMED send +
   *  broadcastRename pair the title feeder's onTitle uses. */
  onTitle: (sessionId: string, title: string) => void;
}

/**
 * Re-broadcast a resumed native session's stored title so its header pill
 * stops showing the 'Resuming…' placeholder.
 *
 * Returns the title that was applied, or null when nothing was applied — which
 * covers both "there was no real title to apply" and "a collaborator threw".
 * The two are deliberately not distinguished: no caller reads the value (it is
 * `void`-called), and the return exists for the tests.
 *
 * NEVER throws and NEVER rejects: a resume must not fail because a title could
 * not be read. A no-op here is harmless — the session is untitled, and the
 * title feeder will generate one at the next turn-complete.
 */
export async function reapplyStoredTitle(
  deps: ResumeTitleDeps,
  sessionId: string,
): Promise<string | null> {
  try {
    const stored = await deps.getStoredTitle(sessionId);
    // Guardrail: only ever plant a REAL name. Broadcasting a placeholder here
    // would overwrite a good live name with 'Untitled' / 'New Session'.
    if (!isRealSessionName(stored)) return null;

    const title = stored!.trim();
    deps.onTitle(sessionId, title);
    return title;
  } catch {
    return null;
  }
}
