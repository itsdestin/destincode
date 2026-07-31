import type { TimelineEntry } from './chat-types';

/**
 * Where the model's context begins.
 *
 * `/compact` and `/clear` both draw a line under the conversation: everything
 * above is out of the model's context but still the user's to re-read. ChatView
 * fades those entries and labels them archived.
 *
 * WHY this is a module rather than a closure inside ChatView's render: it is the
 * whole of the /clear fix's visible half, and testing it inside ChatView means
 * mounting a component that pulls highlight.js — which cannot load through this
 * worktree's node_modules symlink. A copy of the logic in a test file would test
 * the copy, not the app (a trap this branch has already fallen into more than
 * once), so the app imports this and the test imports the same thing.
 *
 * Only `compact` and `clear` are boundaries. An `info` marker is a divider, not
 * a context reset.
 */
export function findArchiveBoundary(timeline: readonly TimelineEntry[]): {
  index: number;
  kind: 'compact' | 'clear' | null;
} {
  for (let i = timeline.length - 1; i >= 0; i--) {
    const e = timeline[i];
    if (e.kind === 'system-marker' && (e.marker.variant === 'compact' || e.marker.variant === 'clear')) {
      return { index: i, kind: e.marker.variant };
    }
  }
  return { index: -1, kind: null };
}
