import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';

// Plan 2b Task 10 — SESSION_MOVED ("this conversation moved to <device>") banner.
// When another device takes over a session lease, the holder side ends the local
// turn cleanly and drops a permanent "moved" system marker into the timeline so
// the user understands why chat activity stopped here.

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

  it('mid-turn: clears isThinking, fails running tools with "Turn ended", appends a moved marker', () => {
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

    // A moved system marker was appended, carrying the device name.
    const markers = session.timeline.filter((e) => e.kind === 'system-marker');
    expect(markers.length).toBe(1);
    const marker = (markers[0] as { kind: 'system-marker'; marker: any }).marker;
    expect(marker.variant).toBe('moved');
    expect(marker.label).toContain('MacBook Pro');
    // Not expandable — no summary.
    expect(marker.summary).toBeUndefined();
  });

  it('idle: appends only the marker, no spurious tool changes', () => {
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
    expect(markers.length).toBe(1);
    const marker = (markers[0] as { kind: 'system-marker'; marker: any }).marker;
    expect(marker.variant).toBe('moved');
    expect(marker.label).toContain('Linux Desktop');
  });

  it('missing device: falls back to a generic "another device" label', () => {
    state = dispatch(state, {
      type: 'SESSION_MOVED',
      sessionId: SESSION,
    });
    const session = state.get(SESSION)!;
    const markers = session.timeline.filter((e) => e.kind === 'system-marker');
    expect(markers.length).toBe(1);
    const marker = (markers[0] as { kind: 'system-marker'; marker: any }).marker;
    expect(marker.variant).toBe('moved');
    expect(marker.label).toContain('another device');
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
