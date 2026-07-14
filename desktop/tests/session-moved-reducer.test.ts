import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';

// Plan 2b SESSION_MOVED — another device took over this session's lease.
//
// As of the "Moved Gate" follow-up (2026-07-14) SESSION_MOVED ONLY ends the
// in-flight turn cleanly (endTurn); it NO LONGER appends a timeline marker. The
// holder destroys the session immediately after, so any appended marker would be
// wiped by SESSION_REMOVE back-to-back and never render. The user-facing
// "this session was taken over on <device>" surface is App.tsx's MovedGate, not
// the timeline. These tests pin that endTurn still runs and NO marker is added.

const SESSION = 'test-session';

function initState(): ChatState {
  const state: ChatState = new Map();
  return chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION });
}

function dispatch(state: ChatState, action: ChatAction): ChatState {
  return chatReducer(state, action);
}

describe('SESSION_MOVED reducer action', () => {
  let state: ChatState;

  beforeEach(() => {
    state = initState();
  });

  it('mid-turn: clears isThinking, fails running tools with "Turn ended", appends NO marker', () => {
    // Start a turn + emit a tool so there is in-flight state to tear down.
    state = dispatch(state, {
      type: 'TRANSCRIPT_USER_MESSAGE',
      sessionId: SESSION,
      uuid: 'u1',
      text: 'hi',
      timestamp: 1000,
    });
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'u2',
      toolUseId: 'tool-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    expect(state.get(SESSION)!.isThinking).toBe(true);
    expect(state.get(SESSION)!.toolCalls.get('tool-1')!.status).toBe('running');

    const timelineLenBefore = state.get(SESSION)!.timeline.length;

    state = dispatch(state, {
      type: 'SESSION_MOVED',
      sessionId: SESSION,
      device: 'MacBook Pro',
    });

    const session = state.get(SESSION)!;
    // endTurn() effects
    expect(session.isThinking).toBe(false);
    expect(session.activeTurnToolIds.size).toBe(0);
    expect(session.toolCalls.get('tool-1')!.status).toBe('failed');
    expect(session.toolCalls.get('tool-1')!.error).toBe('Turn ended');
    // Attention resets to 'ok' — this is a clean turn end, NOT a terminal error state.
    expect(session.attentionState).toBe('ok');

    // NO system marker is appended (the Moved Gate is the surface now) and the
    // timeline length is otherwise unchanged.
    const markers = session.timeline.filter((e) => e.kind === 'system-marker');
    expect(markers.length).toBe(0);
    expect(session.timeline.length).toBe(timelineLenBefore);
  });

  it('idle: no marker, no spurious tool changes', () => {
    const before = state.get(SESSION)!;
    expect(before.isThinking).toBe(false);
    expect(before.timeline.length).toBe(0);

    state = dispatch(state, {
      type: 'SESSION_MOVED',
      sessionId: SESSION,
      device: 'Linux Desktop',
    });

    const session = state.get(SESSION)!;
    expect(session.toolCalls.size).toBe(0);
    expect(session.isThinking).toBe(false);
    const markers = session.timeline.filter((e) => e.kind === 'system-marker');
    expect(markers.length).toBe(0);
  });

  it('unknown sessionId: returns state unchanged (no throw)', () => {
    const before = state;
    const after = dispatch(state, {
      type: 'SESSION_MOVED',
      sessionId: 'no-such-session',
      device: 'Phantom',
    });
    expect(after).toBe(before);
  });
});
