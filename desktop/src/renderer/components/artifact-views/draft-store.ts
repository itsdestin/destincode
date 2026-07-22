// Draft stash — the SAFETY NET under the D3 unsaved-changes guards.
//
// The guards (useUnsavedGuard + dirty-editor-guard) prompt on the navigations
// that MEAN "I'm leaving this file": selecting another file, closing the
// panel, switching sessions. But the editor lives inside the drawer, and many
// layout changes unmount the drawer wholesale WITHOUT any of those meanings —
// the games panel, the chat↔terminal toggle, Project View, a filepath-pill
// click, and whatever gets added next. Enumerating them is a losing game
// (three were found in one review pass), so instead of guarding every
// trigger, an unmount-while-dirty stashes the draft here and the next mount
// of the same file restores it — edit mode, content, and concurrency token
// intact. Unknown discard paths degrade to "draft survives", never data loss.
//
// Renderer-module state, per window. Cleared on save / cancel / discard /
// use-disk-version — the stash only ever holds drafts the user has neither
// kept nor thrown away.
import { canonicalize } from '../../../shared/artifacts/canonicalize';

export interface StashedDraft {
  draft: string;
  /** The optimistic-concurrency token captured when editing began — restoring
   * it means a save after restore still conflicts if the disk moved. */
  mtimeMs: number | null;
}

const stash = new Map<string, StashedDraft>();

export function draftKey(projectRoot: string, artifactId: string): string {
  return canonicalize(projectRoot, null) + '|' + artifactId;
}

export function stashDraft(key: string, entry: StashedDraft): void {
  stash.set(key, entry);
}

/** Read-and-remove: restoration consumes the entry (the live editor owns the
 * draft again; a second consumer must not resurrect a stale copy). */
export function takeDraft(key: string): StashedDraft | undefined {
  const entry = stash.get(key);
  stash.delete(key);
  return entry;
}

export function clearDraft(key: string): void {
  stash.delete(key);
}
