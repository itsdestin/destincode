import { describe, it, expect } from 'vitest';
import { nextAbsentCount, MENU_ABSENT_FLUSHES_TO_RESOLVE, expiredToolIds } from '../expired-card-resolver';
import { createSessionChatState } from '../chat-types';
import type { ToolCallState } from '../../../shared/types';

describe('expired-card menu-absence rule (spec §2)', () => {
  it('menu present resets the counter — false retain self-heals later', () => {
    expect(nextAbsentCount(true, 1)).toEqual({ count: 0, resolve: false });
  });
  it('one absent flush is NOT enough — socket close races the buffer flush', () => {
    expect(nextAbsentCount(false, 0)).toEqual({ count: 1, resolve: false });
  });
  it('two consecutive absent flushes resolve', () => {
    expect(nextAbsentCount(false, 1)).toEqual({ count: 2, resolve: true });
    expect(MENU_ABSENT_FLUSHES_TO_RESOLVE).toBe(2);
  });
});

describe('expiredToolIds', () => {
  function makeTool(toolUseId: string, overrides: Partial<ToolCallState>): ToolCallState {
    return {
      toolUseId,
      toolName: 'Bash',
      status: 'awaiting-approval',
      input: {},
      ...overrides,
    } as ToolCallState;
  }

  it('returns ids of tools that are both awaiting-approval AND expired', () => {
    const session = createSessionChatState();
    session.toolCalls.set('t1', makeTool('t1', { expired: true }));
    session.toolCalls.set('t2', makeTool('t2', {})); // live ask, not expired
    session.toolCalls.set('t3', makeTool('t3', { status: 'complete', expired: true })); // resolved already
    expect(expiredToolIds(session)).toEqual(['t1']);
  });

  it('returns an empty array when no cards are expired', () => {
    const session = createSessionChatState();
    session.toolCalls.set('t1', makeTool('t1', {}));
    expect(expiredToolIds(session)).toEqual([]);
  });
});
