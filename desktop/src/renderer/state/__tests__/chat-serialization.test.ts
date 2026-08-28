import { describe, it, expect } from 'vitest';
import {
  createSessionChatState,
  serializeChatState,
  deserializeChatState,
} from '../chat-types';
import type { ChatState, ToolCallState } from '../chat-types';

describe('chat state serialization', () => {
  it('round-trips an empty ChatState', () => {
    const state: ChatState = new Map();
    const round = deserializeChatState(serializeChatState(state));
    expect(round).toEqual(state);
  });

  it('round-trips a turn carrying every segment kind, with the plan segment intact', () => {
    // The earlier round-trip used `segments: []`, so nothing pinned that a
    // POPULATED segment list survives the JSON hop — and `plan` is the one that
    // carries fields beyond content/messageId, which is exactly what a lossy
    // serializer would quietly drop.
    const session = createSessionChatState();
    session.assistantTurns.set('turn-1', {
      id: 'turn-1',
      segments: [
        { type: 'text', content: 'hello', messageId: 'm1' },
        { type: 'reasoning', content: 'thinking', messageId: 'm2' },
        { type: 'tool-group', groupId: 'g1' },
        { type: 'plan', content: '# Plan', messageId: 'm3', planFilePath: '/p/plan.md', allowedPrompts: ['go'] },
      ],
      timestamp: 1,
      stopReason: null,
      model: null,
      usage: null,
      anthropicRequestId: null,
    } as never);
    const state: ChatState = new Map([['session-a', session]]);

    const serialized = serializeChatState(state);
    const json = JSON.stringify(serialized);
    expect(json).toContain('"type":"plan"');
    const round = deserializeChatState(JSON.parse(json));

    expect(round.get('session-a')!.assistantTurns.get('turn-1')!.segments)
      .toEqual(session.assistantTurns.get('turn-1')!.segments);
  });

  it('round-trips a session with tool calls, turns, and an active turn set', () => {
    const session = createSessionChatState();
    const toolCall: ToolCallState = {
      id: 'tool-1',
      name: 'Bash',
      status: 'success',
      input: { command: 'ls' },
      result: 'file.txt',
    } as any;
    session.toolCalls.set('tool-1', toolCall);
    session.activeTurnToolIds.add('tool-1');
    session.assistantTurns.set('turn-1', {
      id: 'turn-1',
      segments: [],
      timestamp: 123,
      stopReason: null,
      model: null,
      usage: null,
      anthropicRequestId: null,
    });
    session.timeline.push({ kind: 'assistant-turn', turnId: 'turn-1' });
    session.isThinking = true;
    session.attentionState = 'stuck';
    session.compactionPending = { startedAt: 456, beforeContextTokens: 1000 };
    const state: ChatState = new Map([['session-a', session]]);

    const serialized = serializeChatState(state);
    const viaJson = JSON.parse(JSON.stringify(serialized));
    const round = deserializeChatState(viaJson);

    const restored = round.get('session-a')!;
    expect(restored.toolCalls.get('tool-1')).toEqual(toolCall);
    expect(restored.activeTurnToolIds.has('tool-1')).toBe(true);
    expect(restored.assistantTurns.get('turn-1')?.timestamp).toBe(123);
    expect(restored.timeline).toEqual([{ kind: 'assistant-turn', turnId: 'turn-1' }]);
    expect(restored.isThinking).toBe(true);
    expect(restored.attentionState).toBe('stuck');
    expect(restored.compactionPending).toEqual({ startedAt: 456, beforeContextTokens: 1000 });
  });

  it('round-trips the transcript-dedup seenUuids set', () => {
    // Remote clients hydrate from this snapshot, then keep receiving the live
    // transcript:event broadcast — an event already baked into the snapshot
    // could be re-delivered live, so the dedup set must cross the wire.
    const session = createSessionChatState();
    session.seenUuids.add('uuid-a');
    session.seenUuids.add('uuid-b');
    const state: ChatState = new Map([['session-a', session]]);

    const viaJson = JSON.parse(JSON.stringify(serializeChatState(state)));
    const restored = deserializeChatState(viaJson).get('session-a')!;

    expect(restored.seenUuids).toBeInstanceOf(Set);
    expect(restored.seenUuids.has('uuid-a')).toBe(true);
    expect(restored.seenUuids.has('uuid-b')).toBe(true);
  });

  it('defaults seenUuids to an empty Set when hydrating a pre-field snapshot', () => {
    // Older desktop hosts predate seenUuids — a snapshot without the field must
    // deserialize to an empty Set, not undefined (which would crash .has()).
    const legacy = { sessions: [['session-a', {
      timeline: [], toolCalls: [], toolGroups: [], assistantTurns: [],
      isThinking: false, streamingText: '', currentGroupId: null, currentTurnId: null,
      lastActivityAt: 0, activeTurnToolIds: [], attentionState: 'ok',
      errorMessage: null, lastBufferActivityAt: 0, compactionPending: null,
    }]] } as any;
    const restored = deserializeChatState(legacy).get('session-a')!;
    expect(restored.seenUuids).toBeInstanceOf(Set);
    expect(restored.seenUuids.size).toBe(0);
  });
});
