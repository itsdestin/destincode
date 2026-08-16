// Builds the workbench's chat timelines by replaying conversation fixtures
// through the REAL chat reducer, then serializing the result into the payload
// App.tsx's `on.chatHydrate` subscriber already understands (App.tsx:1465).
//
// WHY the hydrate channel rather than dispatching into ChatProvider directly:
// `dispatch` lives inside <App/>'s provider tree, so nothing outside it can
// reach the reducer. `on.chatHydrate` is a real channel (remote-shim.ts serves
// it so a remote browser gets its timelines on connect), and App already
// subscribes to it unconditionally — so the workbench feeds the timeline through
// a shipping code path instead of an injection point carved into App.
//
// This also satisfies spec §3.3's objection to hand-authored SerializedChatState:
// nothing here is hand-authored. The shape is produced by the reducer and the
// app's own serializer, so it cannot drift from what the app expects.
import { chatReducer } from '../../state/chat-reducer';
import { serializeChatState, type ChatState, type SerializedChatState } from '../../state/chat-types';
import { loadFixture } from './fixture-loader';
import { RUNS } from './specialist-runs';

// @ts-ignore TS1343 — Vite rewrites import.meta.glob statically at build time.
const convos = import.meta.glob('./fixtures/conversations/*.jsonl', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/** Session ids must match the seeded SessionInfo rows (fixtures/sessions.ts) so
 *  each timeline lands on the session the strip is showing. A fixture with no
 *  mapping is skipped rather than dispatched into a session that does not exist. */
const SESSION_FOR: Record<string, string> = {
  'claude-code': 'wb-1',
  native: 'wb-2',
  specialists: 'wb-3',
};

let cached: SerializedChatState | null = null;

/** The hydrate payload for every mapped conversation fixture, merged into one
 *  state the way a real multi-session snapshot arrives. Cached because the
 *  fixtures are static and the reducer replay is pure. */
export function buildHydratePayload(): SerializedChatState {
  if (cached) return cached;

  let state: ChatState = new Map();

  // Sorted so the merge order is deterministic — import.meta.glob's key order is
  // not guaranteed, and a fixture's actions must not interleave with another's.
  for (const [path, raw] of Object.entries(convos).sort(([a], [b]) => a.localeCompare(b))) {
    const name = path.split('/').pop()!.replace('.jsonl', '');
    const sessionId = SESSION_FOR[name];
    if (!sessionId) {
      console.warn(`[workbench] conversation fixture "${name}" has no session mapping — skipped`);
      continue;
    }

    const { actions, error } = loadFixture(name, raw, sessionId);
    if (error) { console.warn(`[workbench] ${error}`); continue; }

    state = chatReducer(state, { type: 'SESSION_INIT', sessionId });
    for (const action of actions) {
      state = chatReducer(state, action);
      // Specialists 1c: remember each declared run so the mock's stop action
      // can flip the right record (mock-shim.ts `specialists.interrupt`).
      if (action.type === 'SPECIALIST_RUN_CHANGED') RUNS.set(action.run.childId, action.run);
    }
  }

  cached = serializeChatState(state);
  return cached;
}
