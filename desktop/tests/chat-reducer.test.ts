import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';

const SESSION = 'test-session';

function initState(): ChatState {
  const state: ChatState = new Map();
  return chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION });
}

function dispatch(state: ChatState, action: ChatAction): ChatState {
  return chatReducer(state, action);
}

describe('TRANSCRIPT_TURN_COMPLETE metadata', () => {
  let state: ChatState;

  beforeEach(() => {
    state = initState();
  });

  // Verifies Task 2.3: the reducer stamps stopReason/model/usage/anthropicRequestId
  // onto the in-flight turn before endTurn() clears currentTurnId.
  it('stores stopReason/model/usage/anthropicRequestId on the completing turn', () => {
    // Create an in-flight turn by dispatching assistant text. That populates
    // currentTurnId and adds an entry to assistantTurns with null metadata.
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-1',
      text: 'Hello from Claude',
      timestamp: 1000,
    });

    const turnId = state.get(SESSION)!.currentTurnId;
    expect(turnId).not.toBeNull();

    // Dispatch turn-complete with all four metadata fields populated.
    state = dispatch(state, {
      type: 'TRANSCRIPT_TURN_COMPLETE',
      sessionId: SESSION,
      uuid: 'uuid-done',
      timestamp: 2000,
      stopReason: 'max_tokens',
      model: 'claude-opus-4-7',
      anthropicRequestId: 'req_abc',
      usage: {
        inputTokens: 10,
        outputTokens: 4096,
        cacheReadTokens: 5,
        cacheCreationTokens: 2,
      },
    });

    const session = state.get(SESSION)!;
    const turn = session.assistantTurns.get(turnId!);
    expect(turn).toBeDefined();
    expect(turn!.stopReason).toBe('max_tokens');
    expect(turn!.model).toBe('claude-opus-4-7');
    expect(turn!.anthropicRequestId).toBe('req_abc');
    expect(turn!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 4096,
      cacheReadTokens: 5,
      cacheCreationTokens: 2,
    });

    // endTurn() still fires: isThinking cleared, currentTurnId reset to null.
    expect(session.isThinking).toBe(false);
    expect(session.currentTurnId).toBeNull();
  });

  // Verifies Task 2.4: the reducer captures the model from the FIRST
  // assistant-text event so the model is visible on in-flight turns
  // (before turn-complete arrives).
  it('sets turn.model on first assistant-text when action carries model', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-text-1',
      text: 'Hello',
      timestamp: 1000,
      model: 'claude-sonnet-4-6',
    });

    const session = state.get(SESSION)!;
    const turnId = session.currentTurnId;
    expect(turnId).not.toBeNull();
    const turn = session.assistantTurns.get(turnId!);
    expect(turn).toBeDefined();
    expect(turn!.model).toBe('claude-sonnet-4-6');
  });

  // Once the turn has a model, a later text chunk without a model must not
  // overwrite it. Guard against clobbering the existing value.
  it('preserves existing turn.model when later assistant-text has no model', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-text-1',
      text: 'Hello',
      timestamp: 1000,
      model: 'claude-sonnet-4-6',
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT',
      sessionId: SESSION,
      uuid: 'uuid-text-2',
      text: 'More text',
      timestamp: 1100,
    });

    const session = state.get(SESSION)!;
    const turnId = session.currentTurnId!;
    const turn = session.assistantTurns.get(turnId);
    expect(turn!.model).toBe('claude-sonnet-4-6');
  });

  // Defensive path: turn-complete can arrive with no in-flight turn (edge case
  // where the reducer hasn't seen any assistant text yet). Must not throw.
  it('streams: consecutive assistant-text events with same partId merge into one segment', () => {
    // OpenCode 1.14+ streams a single text part as many small `message.part.delta`
    // events. Each one becomes a TRANSCRIPT_ASSISTANT_TEXT with the same partId.
    // The reducer must append text to the existing segment, not create a new
    // bubble per chunk. Without this, "Hello world" arrives as ["H","e","l","l","o", ...]
    // each in its own bubble.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'd1', text: 'Hello', timestamp: 1, partId: 'prt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'd2', text: ' world', timestamp: 2, partId: 'prt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'd3', text: '!', timestamp: 3, partId: 'prt_1' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(1);
    expect(turn.segments[0]).toMatchObject({ type: 'text', content: 'Hello world!', partId: 'prt_1' });
  });

  it('streams: a new partId starts a fresh segment (transition between text parts)', () => {
    // OpenCode can emit multiple text parts in one turn (e.g. text → tool → text).
    // The second text part has a different partId, so it must NOT merge with the first.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'd1', text: 'first', timestamp: 1, partId: 'prt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'd2', text: 'second', timestamp: 2, partId: 'prt_2' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
    expect(turn.segments[0]).toMatchObject({ content: 'first', partId: 'prt_1' });
    expect(turn.segments[1]).toMatchObject({ content: 'second', partId: 'prt_2' });
  });

  it('Claude path: events without partId always create new segments (preserves existing behavior)', () => {
    // Claude's transcript watcher emits one event per complete text block, each
    // intended to render as its own segment. None carry partId. Must NOT merge.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'd1', text: 'block1', timestamp: 1 });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 'd2', text: 'block2', timestamp: 2 });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
  });

  it('gracefully handles turn-complete with no in-flight turn (no crash)', () => {
    expect(state.get(SESSION)!.currentTurnId).toBeNull();

    expect(() => {
      state = dispatch(state, {
        type: 'TRANSCRIPT_TURN_COMPLETE',
        sessionId: SESSION,
        uuid: 'uuid-done',
        timestamp: 2000,
        stopReason: null,
        model: null,
        anthropicRequestId: null,
        usage: null,
      });
    }).not.toThrow();

    const session = state.get(SESSION)!;
    expect(session.isThinking).toBe(false);
    expect(session.currentTurnId).toBeNull();
    expect(session.assistantTurns.size).toBe(0);
  });
});
