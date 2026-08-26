import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState } from '../src/renderer/state/chat-types';

const SID = 's1';
const start = (): ChatState => chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });

const turnComplete = (usage: any, uuid: string) => ({
  type: 'TRANSCRIPT_TURN_COMPLETE' as const,
  sessionId: SID, uuid, timestamp: 1,
  stopReason: 'end_turn', model: 'm', anthropicRequestId: null, usage,
});

describe('reducer session totals', () => {
  it('sums usage across turns', () => {
    let s = start();
    s = chatReducer(s, turnComplete({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'u1'));
    s = chatReducer(s, turnComplete({ inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'u2'));
    expect(s.get(SID)!.totals.inputTokens).toBe(300);
    expect(s.get(SID)!.totals.outputTokens).toBe(30);
  });

  it('does not count a SUBAGENT turn-complete twice — the subagent-usage event owns that', () => {
    let s = start();
    s = chatReducer(s, {
      ...turnComplete({ inputTokens: 500, outputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 0 }, 'u3'),
      parentAgentToolUseId: 'parent-tool-1',
      agentId: 'child-1',
    } as any);
    expect(s.get(SID)!.totals.inputTokens).toBe(0);
  });

  it('counts edited lines from a tool result exactly once, even on a duplicate emit', () => {
    let s = start();
    const patch = [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' ctx', '-a', '+b', '+c'] }];
    const use = { type: 'TRANSCRIPT_TOOL_USE' as const, sessionId: SID, uuid: 'tu', timestamp: 1, toolUseId: 't1', toolName: 'Edit', toolInput: {} };
    const result = { type: 'TRANSCRIPT_TOOL_RESULT' as const, sessionId: SID, uuid: 'tr', timestamp: 2, toolUseId: 't1', toolName: 'Edit', result: 'ok', isError: false, structuredPatch: patch };
    s = chatReducer(s, use as any);
    s = chatReducer(s, result as any);
    s = chatReducer(s, result as any);   // duplicate delivery (replay overlapping live)
    expect(s.get(SID)!.totals.linesAdded).toBe(2);
    expect(s.get(SID)!.totals.linesRemoved).toBe(1);
  });

  it('counts a SPECIALIST edit — the segment path, not the main tool-call path', () => {
    let s = start();
    const patch = [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 3, lines: ['+x', '+y', '+z'] }];
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: SID, uuid: 'p1', timestamp: 1, toolUseId: 'task-1', toolName: 'Task', toolInput: {} } as any);
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_USE', sessionId: SID, uuid: 'c1', timestamp: 2, toolUseId: 'ct-1', toolName: 'Write', toolInput: {}, parentAgentToolUseId: 'task-1', agentId: 'child-1' } as any);
    s = chatReducer(s, { type: 'TRANSCRIPT_TOOL_RESULT', sessionId: SID, uuid: 'c2', timestamp: 3, toolUseId: 'ct-1', toolName: 'Write', result: 'ok', isError: false, structuredPatch: patch, parentAgentToolUseId: 'task-1', agentId: 'child-1' } as any);
    expect(s.get(SID)!.totals.linesAdded).toBe(3);
  });

  it('survives serialization', async () => {
    const { serializeChatState, deserializeChatState } = await import('../src/renderer/state/chat-types');
    let s = start();
    s = chatReducer(s, turnComplete({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 1, cacheCreationTokens: 0 }, 'u9'));
    const back = deserializeChatState(serializeChatState(s));
    expect(back.get(SID)!.totals.inputTokens).toBe(7);
  });

  it('gives a pre-field snapshot empty totals rather than undefined', async () => {
    const { deserializeChatState, createSessionChatState } = await import('../src/renderer/state/chat-types');
    const legacy: any = { sessions: [[SID, { ...createSessionChatState(), toolCalls: [], toolGroups: [], assistantTurns: [], activeTurnToolIds: [], seenUuids: [], totals: undefined }]] };
    const back = deserializeChatState(legacy);
    expect(back.get(SID)!.totals.inputTokens).toBe(0);
  });
});
