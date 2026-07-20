import { describe, it, expect } from 'vitest';
import { chatReducer } from '../chat-reducer';
import { createSessionChatState } from '../chat-types';
import type { ChatState } from '../chat-types';
import type { ToolCallState } from '../../../shared/types';

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
