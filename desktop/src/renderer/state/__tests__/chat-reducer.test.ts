import { describe, it, expect, vi } from 'vitest';
import { chatReducer } from '../chat-reducer';
import { createSessionChatState, serializeChatState } from '../chat-types';
import type { ChatState } from '../chat-types';
import type { ToolCallState } from '../../../shared/types';
import { hasPendingInteraction, canRetrySubmit } from '../pty-input-gate';

function stateWithInFlightTurn(sessionId = 'sess-1', turnId = 'turn-1'): ChatState {
  const session = createSessionChatState();
  session.currentTurnId = turnId;
  session.isThinking = true;
  const runningTool: ToolCallState = {
    toolUseId: 'tool-1',
    toolName: 'Bash',
    status: 'running',
    input: { command: 'sleep 1000' },
  } as any;
  const awaitingTool: ToolCallState = {
    toolUseId: 'tool-2',
    toolName: 'Edit',
    status: 'awaiting-approval',
    input: {},
  } as any;
  session.toolCalls.set('tool-1', runningTool);
  session.toolCalls.set('tool-2', awaitingTool);
  session.activeTurnToolIds.add('tool-1');
  session.activeTurnToolIds.add('tool-2');
  session.assistantTurns.set(turnId, {
    id: turnId,
    segments: [],
    timestamp: 1000,
    stopReason: null,
    model: null,
    usage: null,
    anthropicRequestId: null,
  });
  return new Map([[sessionId, session]]);
}

describe('chatReducer TRANSCRIPT_INTERRUPT', () => {
  it('attaches stopReason=interrupted to the in-flight turn', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    const session = next.get('sess-1')!;
    expect(session.assistantTurns.get('turn-1')?.stopReason).toBe('interrupted');
  });

  it('flips running/awaiting-approval tools to failed with error "Turn interrupted"', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'tool-use',
    });
    const session = next.get('sess-1')!;
    expect(session.toolCalls.get('tool-1')?.status).toBe('failed');
    expect((session.toolCalls.get('tool-1') as any).error).toBe('Turn interrupted');
    expect(session.toolCalls.get('tool-2')?.status).toBe('failed');
    expect((session.toolCalls.get('tool-2') as any).error).toBe('Turn interrupted');
  });

  it('clears turn-scoped state via endTurn()', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    const session = next.get('sess-1')!;
    expect(session.isThinking).toBe(false);
    expect(session.currentTurnId).toBeNull();
    expect(session.activeTurnToolIds.size).toBe(0);
    expect(session.attentionState).toBe('ok');
  });

  it('is a no-op-safe call when there is no in-flight turn', () => {
    const session = createSessionChatState();
    session.isThinking = false;
    session.currentTurnId = null;
    const state: ChatState = new Map([['sess-1', session]]);
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'sess-1',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    const nextSession = next.get('sess-1')!;
    expect(nextSession.isThinking).toBe(false);
    expect(nextSession.currentTurnId).toBeNull();
  });

  it('returns original state if sessionId is unknown', () => {
    const state = stateWithInFlightTurn();
    const next = chatReducer(state, {
      type: 'TRANSCRIPT_INTERRUPT',
      sessionId: 'no-such-session',
      uuid: 'u-1',
      timestamp: 2000,
      kind: 'plain',
    });
    expect(next).toBe(state);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Transcript replay dedup (renderer-crash rehydration). After a renderer
// reload, the mount effect replays every session's transcript from disk while
// the live transcript:event stream is ALSO delivering. An event that lands in
// both streams (uuid present in the replayed file AND re-broadcast live) must
// collapse to a single timeline entry — the reducer is now the dedup layer for
// the two append-prone event types. Keyed on the JSONL line uuid.
// ─────────────────────────────────────────────────────────────────────────
describe('chatReducer transcript replay dedup', () => {
  function initState(sessionId = 'sess-1'): ChatState {
    return new Map([[sessionId, createSessionChatState()]]);
  }

  function userCount(state: ChatState, sessionId = 'sess-1'): number {
    return state.get(sessionId)!.timeline.filter((e) => e.kind === 'user').length;
  }

  it('drops a duplicate TRANSCRIPT_USER_MESSAGE with the same uuid', () => {
    let state = initState();
    const action = {
      type: 'TRANSCRIPT_USER_MESSAGE' as const,
      sessionId: 'sess-1',
      uuid: 'user-uuid-1',
      text: 'hello',
      timestamp: 1000,
    };
    state = chatReducer(state, action);
    state = chatReducer(state, action); // replay re-delivery
    expect(userCount(state)).toBe(1);
  });

  it('keeps two user messages that share text but have DIFFERENT uuids', () => {
    // Guards the rapid-fire "yes yes yes" case — dedup must be uuid-based,
    // never content-based, or legitimate repeats get eaten.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 'sess-1',
      uuid: 'u-a', text: 'yes', timestamp: 1000,
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 'sess-1',
      uuid: 'u-b', text: 'yes', timestamp: 1001,
    });
    expect(userCount(state)).toBe(2);
  });

  it('drops a duplicate TRANSCRIPT_ASSISTANT_TEXT with the same uuid', () => {
    let state = initState();
    const action = {
      type: 'TRANSCRIPT_ASSISTANT_TEXT' as const,
      sessionId: 'sess-1',
      uuid: 'asst-uuid-1',
      text: 'the answer',
      timestamp: 2000,
    };
    state = chatReducer(state, action);
    state = chatReducer(state, action); // replay re-delivery
    const turns = [...state.get('sess-1')!.assistantTurns.values()];
    const textSegments = turns.flatMap((t) => t.segments).filter((s) => s.type === 'text');
    expect(textSegments).toHaveLength(1);
  });

  it('merges native streaming deltas (unique uuids, shared partId) — never drops them', () => {
    // Native emits one assistant-text event per token, each with a FRESH
    // randomUUID but the same partId. uuid dedup must NOT collapse these —
    // they merge into one growing segment by partId.
    let state = initState();
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 'sess-1',
      uuid: 'delta-1', text: 'Hel', timestamp: 3000, partId: 'text-0',
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: 'sess-1',
      uuid: 'delta-2', text: 'lo', timestamp: 3001, partId: 'text-0',
    });
    const turns = [...state.get('sess-1')!.assistantTurns.values()];
    const textSegments = turns.flatMap((t) => t.segments).filter((s) => s.type === 'text');
    expect(textSegments).toHaveLength(1);
    expect((textSegments[0] as any).content).toBe('Hello');
  });

  it('confirms a pending optimistic bubble then drops the replayed duplicate', () => {
    // The live user-message confirms the optimistic bubble (pending→false) and
    // records the uuid; a later replay of the same uuid must not re-append.
    let state = initState();
    state = chatReducer(state, {
      type: 'USER_PROMPT', sessionId: 'sess-1', content: 'run it', timestamp: 900,
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 'sess-1',
      uuid: 'confirm-uuid', text: 'run it', timestamp: 1000,
    });
    state = chatReducer(state, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: 'sess-1',
      uuid: 'confirm-uuid', text: 'run it', timestamp: 1000,
    });
    expect(userCount(state)).toBe(1);
    expect(state.get('sess-1')!.timeline.find((e) => e.kind === 'user')).toMatchObject({ pending: false });
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Tool cards must not duplicate on re-emit. Unlike user/assistant text, the
// watcher deliberately RE-EMITS tool-use for a repeated uuid (a rewritten CC
// JSONL line may carry new tool_use blocks), so the reducer must absorb the
// repeat structurally rather than by uuid — a uuid guard here would silently
// swallow tools that arrive in a rewrite. See transcript-watcher.ts
// readNewLines (~line 679).
// ─────────────────────────────────────────────────────────────────────────
describe('chatReducer tool card duplication', () => {
  function initState(sessionId = 'sess-1'): ChatState {
    return new Map([[sessionId, createSessionChatState()]]);
  }

  function cardCount(state: ChatState, toolUseId: string, sessionId = 'sess-1'): number {
    // Count every rendered slot, not Map entries — AssistantTurnBubble maps
    // group.toolIds → cards, so a doubled id is a doubled card on screen.
    const groups = [...state.get(sessionId)!.toolGroups.values()];
    return groups.flatMap((g) => g.toolIds).filter((id) => id === toolUseId).length;
  }

  const askAction = {
    type: 'TRANSCRIPT_TOOL_USE' as const,
    sessionId: 'sess-1',
    uuid: 'line-uuid-1',
    toolUseId: 'toolu_ask_1',
    toolName: 'AskUserQuestion',
    toolInput: { questions: [{ question: 'Which?', header: 'Pick', options: [] }] },
  };

  it('renders one card when the same tool_use is re-emitted (rewritten JSONL line)', () => {
    let state = initState();
    state = chatReducer(state, askAction);
    state = chatReducer(state, askAction);
    state = chatReducer(state, askAction);
    expect(cardCount(state, 'toolu_ask_1')).toBe(1);
  });

  it('renders one card when a tool_use is re-emitted after the turn ended', () => {
    // The stale-currentGroupId path: endTurn() clears currentGroupId, so a
    // later re-emit used to mint a SECOND group + segment for the same tool.
    let state = initState();
    state = chatReducer(state, askAction);
    state = chatReducer(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: 'sess-1', uuid: 'turn-1',
    } as any);
    state = chatReducer(state, askAction);
    expect(cardCount(state, 'toolu_ask_1')).toBe(1);
    expect(state.get('sess-1')!.toolGroups.size).toBe(1);
  });

  it('still renders a genuinely NEW tool that arrives in a rewritten line', () => {
    // Guards against "fixing" this with a uuid guard: two different tools can
    // share one line uuid when CC rewrites a growing assistant message.
    let state = initState();
    state = chatReducer(state, askAction);
    state = chatReducer(state, {
      ...askAction, toolUseId: 'toolu_bash_2', toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    expect(cardCount(state, 'toolu_ask_1')).toBe(1);
    expect(cardCount(state, 'toolu_bash_2')).toBe(1);
  });

  it('does not synthesize a second placeholder for a re-delivered requestId', () => {
    // PERMISSION_REQUEST matches only 'running' tools, so a re-delivery after
    // the tool flipped to awaiting-approval used to fall through and mint a
    // duplicate perm-* card.
    let state = initState();
    state = chatReducer(state, askAction);
    const perm = {
      type: 'PERMISSION_REQUEST' as const,
      sessionId: 'sess-1',
      requestId: 'req-1',
      toolName: 'AskUserQuestion',
      input: askAction.toolInput,
    };
    state = chatReducer(state, perm as any);
    state = chatReducer(state, perm as any);
    expect(cardCount(state, 'toolu_ask_1')).toBe(1);
    const synthetic = [...state.get('sess-1')!.toolCalls.keys()].filter((k) => k.startsWith('perm-'));
    expect(synthetic).toHaveLength(0);
  });
});

// Remote-access hydration guards. Both invariants here are the kind that fail
// silently in production — a wrong-looking timeline, or a chat that vanishes —
// so they are pinned rather than left to manual verification.
describe('chatReducer HYDRATE_CHAT_STATE', () => {
  /** A snapshot as a long-running host would send it: ids from its own counter. */
  function snapshotWithLegacyIds() {
    const session = createSessionChatState();
    session.timeline.push({
      kind: 'user',
      message: { id: 'msg-1', role: 'user', content: 'hydrated message', timestamp: 1000 },
    } as any);
    return serializeChatState(new Map([['sess-1', session]]));
  }

  /** Timeline message ids — they live on entry.message.id, not entry.id. */
  function messageIds(state: ChatState, sessionId = 'sess-1'): string[] {
    return state
      .get(sessionId)!
      .timeline.filter((e: any) => e.kind === 'user')
      .map((e: any) => e.message.id);
  }

  it('never mints a live message id that collides with a hydrated one', async () => {
    // The bug: the module-level id counter restarts at 0 on a fresh remote
    // client while the snapshot already holds msg-1..msg-N, so the next live
    // message reused an existing React key and the list mis-reconciled.
    //
    // resetModules() is load-bearing. This MUST run against a freshly-imported
    // reducer so the counter really is at 0 — reusing the file-level import
    // makes the test vacuous, because earlier tests here have already advanced
    // the counter past the ids in the snapshot and no collision can occur.
    vi.resetModules();
    const { chatReducer: freshReducer } = await import('../chat-reducer');

    let state: ChatState = new Map();
    state = freshReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: snapshotWithLegacyIds(),
    } as any);

    const hydratedIds = new Set(messageIds(state));
    expect(hydratedIds.has('msg-1')).toBe(true);

    state = freshReducer(state, {
      type: 'USER_PROMPT',
      sessionId: 'sess-1',
      content: 'live message',
      timestamp: 2000,
    } as any);

    const ids = messageIds(state);
    const liveId = ids[ids.length - 1];
    expect(liveId).toBeDefined();
    expect(hydratedIds.has(liveId)).toBe(false);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ignores an empty snapshot instead of blanking live state', () => {
    // An empty payload is what the host sends on export timeout or serialize
    // failure — not a claim that there are no sessions. Applying it wiped a
    // reconnecting client's chat with no error surfaced.
    let state: ChatState = new Map();
    state = chatReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: snapshotWithLegacyIds(),
    } as any);

    const before = state;
    state = chatReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: { sessions: [], degraded: true },
    } as any);

    expect(state).toBe(before);
    expect(state.get('sess-1')!.timeline).toHaveLength(1);
  });

  it('still replaces state for a non-empty snapshot', () => {
    // Guard against over-correcting the empty-snapshot fix into "never replaces".
    let state: ChatState = new Map();
    state = chatReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: snapshotWithLegacyIds(),
    } as any);

    const replacement = createSessionChatState();
    replacement.timeline.push({
      id: 'msg-99',
      role: 'user',
      content: 'replacement',
      timestamp: 3000,
    } as any);

    state = chatReducer(state, {
      type: 'HYDRATE_CHAT_STATE',
      sessions: serializeChatState(new Map([['sess-2', replacement]])),
    } as any);

    expect(state.has('sess-1')).toBe(false);
    expect(state.get('sess-2')!.timeline).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task 12: queued messages leave the timeline — docked strip + true-position
// confirm. Replaces the Task 3/11 timeline-based queued mechanics (the
// `queued`/`queueId` USER_PROMPT variant, QUEUED_PROMPT_CANCELED): a queued
// native send now only touches SessionChatState.queuedMessages
// (QUEUED_MESSAGE_ADDED/REMOVED) — NEVER the timeline or turn state — and
// joins the timeline for the first time when TRANSCRIPT_USER_MESSAGE's
// no-pending-match fallback appends it at the END, its true position,
// instead of freezing an enqueue-time position above content the
// still-streaming prior turn hadn't emitted yet ("assistant responding to
// itself").
// ─────────────────────────────────────────────────────────────────────────
const SID = 'sess-1';

function withStreamingTurn(sessionId = SID, turnId = 't1', groupId = 'g1'): ChatState {
  // Mirrors stateWithInFlightTurn above — a turn mid-stream via
  // TRANSCRIPT_ASSISTANT_TEXT leaves currentTurnId/currentGroupId set and
  // isThinking true. Constructed directly rather than by dispatching the
  // action, matching this file's existing helper convention.
  const session = createSessionChatState();
  session.currentTurnId = turnId;
  session.currentGroupId = groupId;
  session.isThinking = true;
  return new Map([[sessionId, session]]);
}

describe('chatReducer QUEUED_MESSAGE_ADDED / QUEUED_MESSAGE_REMOVED (Task 12)', () => {
  it('QUEUED_MESSAGE_ADDED appends to queuedMessages and touches NEITHER the timeline NOR turn state', () => {
    let s = withStreamingTurn(); // currentTurnId 't1', currentGroupId 'g1', isThinking true
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'next msg', timestamp: 5 });
    const sess = s.get(SID)!;
    expect(sess.currentTurnId).toBe('t1');   // NOT nulled — later deltas keep merging into the live turn
    expect(sess.currentGroupId).toBe('g1');  // NOT nulled — tool grouping unaffected
    expect(sess.timeline).toHaveLength(0);   // NO timeline entry — the whole point of Task 12
    expect(sess.queuedMessages).toEqual([{ queueId: 'q-1', content: 'next msg', timestamp: 5 }]);
  });

  it('QUEUED_MESSAGE_ADDED is a no-op for an unknown session id', () => {
    const s = new Map<string, ReturnType<typeof createSessionChatState>>();
    const before = s;
    const after = chatReducer(before, { type: 'QUEUED_MESSAGE_ADDED', sessionId: 'ghost', queueId: 'q-1', content: 'x', timestamp: 1 });
    expect(after).toBe(before);
  });

  it('QUEUED_MESSAGE_REMOVED removes only the matching entry by queueId', () => {
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'first', timestamp: 1 });
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-2', content: 'second', timestamp: 2 });
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: SID, queueId: 'q-1' });
    expect(s.get(SID)!.queuedMessages).toEqual([{ queueId: 'q-2', content: 'second', timestamp: 2 }]);
  });

  it('QUEUED_MESSAGE_REMOVED is a no-op when the queueId is not present', () => {
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'first', timestamp: 1 });
    const before = s;
    const after = chatReducer(before, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: SID, queueId: 'ghost-id' });
    expect(after).toBe(before);
  });

  it('QUEUED_MESSAGE_REMOVED is a no-op for an unknown session id', () => {
    const before: ChatState = new Map([[SID, createSessionChatState()]]);
    const after = chatReducer(before, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: 'ghost-session', queueId: 'q-1' });
    expect(after).toBe(before);
  });
});

describe('chatReducer TRANSCRIPT_USER_MESSAGE — true-position confirm for a drained queued message (Task 12)', () => {
  it('a queued message with NO pending bubble appends at the END (true position), even mid-stream', () => {
    // The prior turn is still streaming (currentTurnId/currentGroupId set,
    // isThinking true) when the queued send drains — the bug this task
    // fixes was freezing the queued bubble ABOVE this content because it
    // rendered at enqueue time. With no timeline write on enqueue, the ONLY
    // possible landing position is wherever TRANSCRIPT_USER_MESSAGE appends
    // it: the end.
    let s = withStreamingTurn();
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'queued text', timestamp: 1 });
    s = chatReducer(s, {
      type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u-1', text: 'queued text', timestamp: 2,
    });
    const timeline = s.get(SID)!.timeline;
    expect(timeline).toHaveLength(1);
    const entry = timeline[0];
    expect(entry).toMatchObject({ kind: 'user', pending: false });
    if (entry.kind === 'user') {
      expect(entry.message.content).toBe('queued text');
      expect('queued' in entry).toBe(false); // field is gone from the type entirely
    }
  });

  it('drain-confirm removes the oldest queuedMessages entry with matching content', () => {
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'hi', timestamp: 1 });
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-2', content: 'hi', timestamp: 2 });
    s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u-1', text: 'hi', timestamp: 3 });
    // Oldest-content-match discipline (mirrors the pending-bubble dedup):
    // q-1 (the OLDER entry) is removed, q-2 survives for the next drain.
    expect(s.get(SID)!.queuedMessages).toEqual([{ queueId: 'q-2', content: 'hi', timestamp: 2 }]);
  });

  it('a sent-path pending bubble confirm is untouched: no queuedMessages entry exists, so nothing is removed', () => {
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'USER_PROMPT', sessionId: SID, content: 'plain send', timestamp: 1 });
    expect(s.get(SID)!.timeline).toHaveLength(1);
    s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u-1', text: 'plain send', timestamp: 2 });
    const timeline = s.get(SID)!.timeline;
    expect(timeline).toHaveLength(1); // confirmed IN PLACE, not appended again
    expect(timeline[0]).toMatchObject({ kind: 'user', pending: false });
    expect(s.get(SID)!.queuedMessages).toEqual([]);
  });

  it('list removal runs independent of which branch confirms: a queuedMessages entry with content matching an unrelated sent bubble is still cleaned up', () => {
    // Minimal-correct-rule pin: the list scan is NOT gated on confirmedIdx
    // finding (or failing to find) a pending bubble — it is a separate,
    // unconditional content-match attempt against queuedMessages. Construct
    // the (edge-case) situation where a 'sent' pending bubble and a queued
    // list entry share content; the sent bubble confirms via the
    // pending-bubble branch, and the list entry is independently cleaned up
    // by the same TRANSCRIPT_USER_MESSAGE dispatch.
    let s: ChatState = new Map([[SID, createSessionChatState()]]);
    s = chatReducer(s, { type: 'USER_PROMPT', sessionId: SID, content: 'same text', timestamp: 1 });
    s = chatReducer(s, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SID, queueId: 'q-1', content: 'same text', timestamp: 2 });
    s = chatReducer(s, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SID, uuid: 'u-1', text: 'same text', timestamp: 3 });
    const timeline = s.get(SID)!.timeline;
    expect(timeline).toHaveLength(1); // pending bubble confirmed in place, not double-appended
    expect(s.get(SID)!.queuedMessages).toEqual([]); // list entry ALSO cleaned up by the same dispatch
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Task 8 / BUG B: tool-group collapse semantics. Collapse is per tool-group;
// group membership is decided by currentGroupId — TRANSCRIPT_TOOL_USE joins
// the current group if set, else opens a new one. TRANSCRIPT_ASSISTANT_TEXT
// and TRANSCRIPT_ASSISTANT_REASONING deliberately reset currentGroupId to
// null (a tool following its own text/reasoning renders under it in a new
// bubble) — that reset is intended and NOT under test here. What IS pinned:
// tools with nothing but heartbeats between them must stay in one group.
// ─────────────────────────────────────────────────────────────────────────
describe('chatReducer tool-group collapse semantics (Task 8 / BUG B)', () => {
  function initState(sessionId = SID): ChatState {
    return new Map([[sessionId, createSessionChatState()]]);
  }

  function toolUse(toolUseId: string, uuid: string, sessionId = SID) {
    return {
      type: 'TRANSCRIPT_TOOL_USE' as const,
      sessionId,
      uuid,
      toolUseId,
      toolName: 'Bash',
      toolInput: { command: `echo ${toolUseId}` },
    };
  }

  /** Group id each tool currently belongs to, in group-insertion order. */
  function groupIdsFor(state: ChatState, toolUseIds: string[], sessionId = SID): (string | undefined)[] {
    const groups = [...state.get(sessionId)!.toolGroups.values()];
    return toolUseIds.map((id) => groups.find((g) => g.toolIds.includes(id))?.id);
  }

  it('tools batched in one step share a group (collapse works)', () => {
    let state = initState();
    state = chatReducer(state, toolUse('tool-1', 'u-1'));
    state = chatReducer(state, toolUse('tool-2', 'u-2'));
    state = chatReducer(state, toolUse('tool-3', 'u-3'));
    const [g1, g2, g3] = groupIdsFor(state, ['tool-1', 'tool-2', 'tool-3']);
    expect(g1).toBeDefined();
    expect(g1).toBe(g2);
    expect(g2).toBe(g3);
    expect(state.get(SID)!.toolGroups.size).toBe(1);
  });

  it('a reasoning delta between tools starts a new group (intended bubble semantics)', () => {
    let state = initState();
    state = chatReducer(state, toolUse('tool-1', 'u-1'));
    state = chatReducer(state, {
      type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SID,
      uuid: 'r-1', text: 'thinking about the next step', timestamp: 1000,
    });
    state = chatReducer(state, toolUse('tool-2', 'u-2'));
    const [g1, g2] = groupIdsFor(state, ['tool-1', 'tool-2']);
    expect(g1).toBeDefined();
    expect(g2).toBeDefined();
    expect(g1).not.toBe(g2);
    expect(state.get(SID)!.toolGroups.size).toBe(2);
  });

  it('a thinking HEARTBEAT between tools does NOT split the group (spurious-split guard)', () => {
    let state = initState();
    state = chatReducer(state, toolUse('tool-1', 'u-1'));
    state = chatReducer(state, {
      type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SID,
    });
    state = chatReducer(state, toolUse('tool-2', 'u-2'));
    const [g1, g2] = groupIdsFor(state, ['tool-1', 'tool-2']);
    expect(g1).toBeDefined();
    expect(g1).toBe(g2);
    expect(state.get(SID)!.toolGroups.size).toBe(1);
  });

  it('a stall-warning HEARTBEAT between tools also does NOT split the group', () => {
    // Stall warnings are still content-free liveness signals — same guard.
    let state = initState();
    state = chatReducer(state, toolUse('tool-1', 'u-1'));
    state = chatReducer(state, {
      type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: SID,
      stallWarning: { retryInMs: 5000, willRetry: true },
    });
    state = chatReducer(state, toolUse('tool-2', 'u-2'));
    const [g1, g2] = groupIdsFor(state, ['tool-1', 'tool-2']);
    expect(g1).toBeDefined();
    expect(g1).toBe(g2);
    expect(state.get(SID)!.toolGroups.size).toBe(1);
  });
});

describe('chatReducer COMPACTION_COMPLETE — native auto-compaction (I2b)', () => {
  it('inserts a compact SystemMarker for a native auto-compaction WITHOUT a compactionPending flag', () => {
    // A spontaneous native compaction never sets compactionPending (only /compact
    // does), so action.auto must bypass the stale-event guard — else the user sees
    // NOTHING after ~all their history is replaced by a model-written summary.
    const session = createSessionChatState();
    expect(session.compactionPending).toBeNull();
    const state: ChatState = new Map([['sess-1', session]]);
    const next = chatReducer(state, {
      type: 'COMPACTION_COMPLETE',
      sessionId: 'sess-1',
      markerId: 'auto-marker-1',
      afterContextTokens: null,
      auto: true,
      summary: 'Earlier: user asked X; did Y.',
    });
    const timeline = next.get('sess-1')!.timeline;
    const marker = timeline.find((e) => e.kind === 'system-marker') as any;
    expect(marker).toBeTruthy();
    expect(marker.marker.variant).toBe('compact');
    expect(marker.marker.summary).toBe('Earlier: user asked X; did Y.');
  });

  it('still IGNORES a non-auto COMPACTION_COMPLETE with no compactionPending (CC resume-from-summary path unchanged)', () => {
    const session = createSessionChatState();
    const state: ChatState = new Map([['sess-1', session]]);
    const next = chatReducer(state, {
      type: 'COMPACTION_COMPLETE',
      sessionId: 'sess-1',
      markerId: 'stale-marker',
      afterContextTokens: null,
      // no `auto`, no compactionPending → stale, must be dropped
    });
    expect(next).toBe(state);   // untouched — no spurious marker
  });
});

describe('PERMISSION_EXPIRED reasons (2026-07-30 spec §2/§2a/§2c/§2d)', () => {
  // Fresh two-session-map state, mirroring initState() in the tool-card-
  // duplication block above. A named helper (rather than inlining) makes the
  // "fresh state, no pending ask" case in the last test read clearly.
  function emptySession(sessionId = 's1'): ChatState {
    return new Map([[sessionId, createSessionChatState()]]);
  }

  // Arrange: PERMISSION_REQUEST with no matching running tool takes the
  // synthetic-card path in chat-reducer.ts (no TRANSCRIPT_TOOL_USE has landed
  // yet), minting toolCalls.get('perm-r1') with status 'awaiting-approval'
  // and requestId 'r1' — the exact shape a live permission ask has in prod
  // right before it expires.
  function withPendingAsk(sessionId = 's1'): ChatState {
    return chatReducer(emptySession(sessionId), {
      type: 'PERMISSION_REQUEST',
      sessionId,
      toolName: 'Bash',
      input: {},
      requestId: 'r1',
    } as any);
  }

  function expire(
    state: ChatState,
    opts: { reason?: 'app-timeout' | 'unroutable' | 'delivery-failed' | 'hook-closed' },
    sessionId = 's1',
  ): ChatState {
    return chatReducer(state, {
      type: 'PERMISSION_EXPIRED',
      sessionId,
      requestId: 'r1',
      ...opts,
    } as any);
  }

  it("'hook-closed' retains: awaiting-approval + expired, requestId cleared, no error", () => {
    const state = expire(withPendingAsk(), { reason: 'hook-closed' });
    const tool = state.get('s1')!.toolCalls.get('perm-r1')!;
    expect(tool.status).toBe('awaiting-approval'); // red dot + input gates keep holding
    expect(tool.expired).toBe(true);
    expect(tool.requestId).toBeUndefined();
    expect(tool.error).toBeUndefined();
  });

  it("'hook-closed' still counts as pending for both pty gates", () => {
    const state = expire(withPendingAsk(), { reason: 'hook-closed' });
    const session = state.get('s1')!;
    expect(hasPendingInteraction(session)).toBe(true);
    expect(canRetrySubmit(session)).toBe(false);
  });

  it("'app-timeout' resolves as failed with accurate copy, never retains", () => {
    const state = expire(withPendingAsk(), { reason: 'app-timeout' });
    const tool = state.get('s1')!.toolCalls.get('perm-r1')!;
    expect(tool.status).toBe('failed');
    expect(tool.expired).toBeUndefined();
    expect(tool.error).toContain('auto-denied');
  });

  it('absent reason resolves — the native-broker / old-shim default', () => {
    const state = expire(withPendingAsk(), {});
    expect(state.get('s1')!.toolCalls.get('perm-r1')!.status).toBe('failed');
  });

  it("'delivery-failed' resolves", () => {
    const state = expire(withPendingAsk(), { reason: 'delivery-failed' });
    expect(state.get('s1')!.toolCalls.get('perm-r1')!.status).toBe('failed');
  });

  it('PERMISSION_CARD_RESOLVED quietly completes an expired card only', () => {
    let state = expire(withPendingAsk(), { reason: 'hook-closed' });
    state = chatReducer(state, { type: 'PERMISSION_CARD_RESOLVED', sessionId: 's1', toolUseId: 'perm-r1' });
    const tool = state.get('s1')!.toolCalls.get('perm-r1')!;
    expect(tool.status).toBe('complete');
    expect(tool.error).toBeUndefined();
    expect(tool.expired).toBeUndefined();
    // a NON-expired awaiting card must be untouched (only the §2 resolver and
    // Dismiss use this action, and both only ever see expired cards)
    const fresh = withPendingAsk();
    const untouched = chatReducer(fresh, { type: 'PERMISSION_CARD_RESOLVED', sessionId: 's1', toolUseId: 'perm-r1' });
    expect(untouched.get('s1')!.toolCalls.get('perm-r1')!.status).toBe('awaiting-approval');
  });

  it('endTurn force-failing a retained hook-closed card clears `expired`, and a later PERMISSION_CARD_RESOLVED cannot erase the failure', () => {
    // Retain via 'hook-closed': awaiting-approval + expired: true.
    let state = expire(withPendingAsk(), { reason: 'hook-closed' });

    // The session then actually dies (endTurn is spread by
    // SESSION_PROCESS_EXITED). This force-fails the still-awaiting tool.
    state = chatReducer(state, {
      type: 'SESSION_PROCESS_EXITED',
      sessionId: 's1',
      exitCode: 1,
    } as any);

    const failed = state.get('s1')!.toolCalls.get('perm-r1')!;
    expect(failed.status).toBe('failed');
    expect(failed.error).toBe('Turn ended');
    // Regression guard: endTurn() must clear the stale `expired` marker once
    // it force-fails the card, or a later quiet PERMISSION_CARD_RESOLVED can
    // still pass the (buggy) `!tool.expired`-only guard and erase this
    // failure with no error text.
    expect(failed.expired).toBeUndefined();

    // A stray PERMISSION_CARD_RESOLVED (Dismiss button, stale-detector
    // callback) must NOT resurrect the failed card as a quiet 'complete'.
    state = chatReducer(state, {
      type: 'PERMISSION_CARD_RESOLVED',
      sessionId: 's1',
      toolUseId: 'perm-r1',
    });
    const stillFailed = state.get('s1')!.toolCalls.get('perm-r1')!;
    expect(stillFailed.status).toBe('failed');
    expect(stillFailed.error).toBe('Turn ended');
  });
});
