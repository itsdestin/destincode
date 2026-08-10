// Placeholder session names — the strings the app shows on a session pill
// BEFORE a real title exists. They are not titles; they mean "no title yet"
// rendered as text.
//
// WHY this lives in shared/: the renderer plants these names (App.tsx's resume
// paths) and the MAIN process has to recognize them (the native title feeder's
// hasTitle check, and the resume-time re-apply). When they were bare literals
// in App.tsx only, main had never heard of 'Resuming…', so hasTitle read it as
// a real title and permanently blocked auto-title generation for every resumed
// native session. One definition, both processes.
//
// NOTE — deliberately NOT the same predicate as store-core.ts's `realTitle`.
// That one recognizes only '' and 'Untitled', and it governs the cross-device
// CRDT merge that decides which title wins on sync. Widening it would change
// sync results. This predicate is about the LIVE session name in one process.

export const RESUMING_NATIVE = 'Resuming…';   // U+2026 ellipsis — App.tsx native resume
export const RESUMING_CLAUDE = 'Resuming...'; // three ASCII periods — App.tsx CC resume
export const NEW_SESSION = 'New Session';     // fresh-session placeholder
const UNTITLED = 'Untitled';                  // legacy placeholder older clients wrote

const PLACEHOLDER_SESSION_NAMES: ReadonlySet<string> = new Set([
  '',
  NEW_SESSION,
  UNTITLED,
  RESUMING_NATIVE,
  RESUMING_CLAUDE,
]);

/** True when `name` is absent or is one of the app's "no title yet" strings. */
export function isPlaceholderSessionName(name: string | undefined | null): boolean {
  if (!name) return true;
  return PLACEHOLDER_SESSION_NAMES.has(name.trim());
}

/** True when `name` is a genuine, user-meaningful session title. */
export function isRealSessionName(name: string | undefined | null): boolean {
  return !isPlaceholderSessionName(name);
}

/**
 * Does this session already have a title worth keeping? Store title wins;
 * the live session name is the fallback for the window between resume and the
 * store's first upsert. Either side counts, but ONLY if it is a real name —
 * a placeholder on either side must read as "still untitled".
 */
export function hasRealTitle(
  storedTitle: string | undefined | null,
  liveName: string | undefined | null,
): boolean {
  return isRealSessionName(storedTitle) || isRealSessionName(liveName);
}
