// Replays the conversation fixtures through the real chat reducer on workbench
// boot. This is the same action sequence a live session produces, so reducer
// drift surfaces here automatically (spec §3.3).
import type { ChatAction } from '../../state/chat-types';
import { loadFixture } from './fixture-loader';

// @ts-ignore TS1343 — Vite rewrites import.meta.glob statically at build time.
const convos = import.meta.glob('./fixtures/conversations/*.jsonl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/** Session ids must match the seeded SessionInfo rows (fixtures/sessions.ts) so
 *  the timeline lands on the session the strip is showing. Keyed by fixture
 *  filename; a fixture with no mapping is skipped rather than dispatched into a
 *  session that does not exist. */
const SESSION_FOR: Record<string, string> = {
  'claude-code': 'wb-1',
  native: 'wb-2',
};

export function seedChat(dispatch: (a: ChatAction) => void): void {
  for (const [path, raw] of Object.entries(convos)) {
    const name = path.split('/').pop()!.replace('.jsonl', '');
    const sessionId = SESSION_FOR[name];
    if (!sessionId) {
      console.warn(`[workbench] conversation fixture "${name}" has no session mapping — skipped`);
      continue;
    }
    dispatch({ type: 'SESSION_INIT', sessionId });
    // The loader stamps sessionId as it builds each action, so they arrive
    // already targeted — no rewriting afterwards.
    const { actions, error } = loadFixture(name, raw, sessionId);
    if (error) { console.warn(`[workbench] ${error}`); continue; }
    for (const a of actions) dispatch(a);
  }
}
