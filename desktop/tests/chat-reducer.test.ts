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
});

// ---------------------------------------------------------------------------
// PERMISSION_REQUEST → running-tool matching (2026-07-10 review fix)
// ---------------------------------------------------------------------------
describe('PERMISSION_REQUEST tool matching', () => {
  let state: ChatState;

  const toolUse = (toolUseId: string, toolName: string, toolInput: Record<string, unknown>): ChatAction => ({
    type: 'TRANSCRIPT_TOOL_USE',
    sessionId: SESSION,
    uuid: `uuid-${toolUseId}`,
    toolUseId,
    toolName,
    toolInput,
    timestamp: 1000,
  } as ChatAction);

  beforeEach(() => {
    state = initState();
  });

  it('attaches approval to the running tool whose input matches, not the first same-name tool', () => {
    // Two Bash tools running in parallel — the permission is for the SECOND.
    state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'ls' }));
    state = dispatch(state, toolUse('tool-b', 'Bash', { command: 'rm -rf build' }));

    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'rm -rf build' },
      requestId: 'req-1',
    });

    const session = state.get(SESSION)!;
    expect(session.toolCalls.get('tool-b')!.status).toBe('awaiting-approval');
    expect(session.toolCalls.get('tool-b')!.requestId).toBe('req-1');
    expect(session.toolCalls.get('tool-a')!.status).toBe('running');
  });

  it('matches input regardless of key order', () => {
    state = dispatch(state, toolUse('tool-a', 'Write', { file_path: '/x', content: 'one' }));
    state = dispatch(state, toolUse('tool-b', 'Write', { content: 'two', file_path: '/y' }));

    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Write',
      input: { file_path: '/y', content: 'two' },
      requestId: 'req-2',
    });

    const session = state.get(SESSION)!;
    expect(session.toolCalls.get('tool-b')!.status).toBe('awaiting-approval');
    expect(session.toolCalls.get('tool-a')!.status).toBe('running');
  });

  it('falls back to the first same-name running tool when no input matches', () => {
    // Pins the pre-existing fallback: hook input shape may not always mirror
    // the transcript's toolInput — degrading to name-match must keep working.
    state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'ls' }));
    state = dispatch(state, toolUse('tool-b', 'Bash', { command: 'pwd' }));

    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'echo mismatched' },
      requestId: 'req-3',
    });

    const session = state.get(SESSION)!;
    const awaiting = ['tool-a', 'tool-b'].filter(
      (id) => session.toolCalls.get(id)!.status === 'awaiting-approval',
    );
    expect(awaiting).toEqual(['tool-a']);
  });

  it('still creates a synthetic entry when no running tool exists', () => {
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'echo hi' },
      requestId: 'req-4',
    });

    const session = state.get(SESSION)!;
    const syn = session.toolCalls.get('perm-req-4');
    expect(syn).toBeDefined();
    expect(syn!.status).toBe('awaiting-approval');
  });
});
