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

  it('reasoning: consecutive REASONING events with same partId merge into one segment', () => {
    // Thinking models (native harness) stream reasoning as per-token deltas
    // carrying a text payload + partId. Same partId → append to one segment
    // (unlike the text path, which appends whole blocks as new segments).
    // Without this, the collapsible reasoning block would render dozens of
    // tiny disclosures per turn.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'Let me ', timestamp: 1, partId: 'rprt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r2', text: 'think...', timestamp: 2, partId: 'rprt_1' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(1);
    expect(turn.segments[0]).toMatchObject({ type: 'reasoning', content: 'Let me think...', partId: 'rprt_1' });
  });

  it('reasoning: different or missing partIds do NOT merge — each starts a new segment', () => {
    // The don't-over-merge half of the contract: merging is keyed strictly
    // on a matching partId. A new partId means a new reasoning part; an
    // undefined partId can never match, so those events always append.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'first part', timestamp: 1, partId: 'rprt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r2', text: 'second part', timestamp: 2, partId: 'rprt_2' });

    let turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
    expect(turn.segments[0]).toMatchObject({ type: 'reasoning', content: 'first part', partId: 'rprt_1' });
    expect(turn.segments[1]).toMatchObject({ type: 'reasoning', content: 'second part', partId: 'rprt_2' });

    // Events with undefined partId each start a new segment — even
    // back-to-back (undefined never satisfies the merge predicate).
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r3', text: 'no id A', timestamp: 3 });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r4', text: 'no id B', timestamp: 4 });

    turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(4);
    expect(turn.segments[2]).toMatchObject({ type: 'reasoning', content: 'no id A' });
    expect(turn.segments[3]).toMatchObject({ type: 'reasoning', content: 'no id B' });
  });

  it('reasoning: REASONING followed by TEXT produces two segments (reasoning then text)', () => {
    // The bubble splitter then attaches the reasoning to the following text
    // bubble as a collapsible disclosure. Reducer just keeps them as
    // distinct segments in order. (TEXT carries no partId on master.)
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'thinking', timestamp: 1, partId: 'rprt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'answer', timestamp: 2 });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
    expect(turn.segments[0].type).toBe('reasoning');
    expect(turn.segments[1].type).toBe('text');
  });

  it('reasoning: REASONING action clears stale attentionState back to ok', () => {
    // Reasoning is genuine activity — bumps lastActivityAt and clears the
    // 'stuck' banner. Mirrors the existing TRANSCRIPT_THINKING_HEARTBEAT
    // behavior so thinking models don't surface false-positive stuck banners
    // while reasoning is streaming.
    state = dispatch(state, { type: 'ATTENTION_STATE_CHANGED', sessionId: SESSION, state: 'stuck' });
    expect(state.get(SESSION)!.attentionState).toBe('stuck');
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'x', timestamp: 1, partId: 'rprt_1' });
    expect(state.get(SESSION)!.attentionState).toBe('ok');
  });
});
