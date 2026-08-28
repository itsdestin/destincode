import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { createSessionChatState, serializeChatState, deserializeChatState } from '../src/renderer/state/chat-types';
import type { ChatState } from '../src/renderer/state/chat-types';
import type { TranscriptEvent } from '../src/shared/types';

function withSession(id: string): ChatState {
  const m: ChatState = new Map();
  m.set(id, createSessionChatState());
  return m;
}

// Pages arrive as parsed TranscriptEvents, exactly as the main handler returns them.
const userEvent = (sid: string, uuid: string, text: string): TranscriptEvent =>
  ({ type: 'user-message', sessionId: sid, uuid, timestamp: 1, data: { text } });
const asstEvent = (sid: string, uuid: string, text: string): TranscriptEvent =>
  ({ type: 'assistant-text', sessionId: sid, uuid, timestamp: 2, data: { text } });

describe('history paging reducer', () => {
  it('createSessionChatState seeds an empty history block', () => {
    expect(createSessionChatState().history).toEqual({ cursor: null, hasMore: false, loading: false });
  });

  it('HISTORY_PAGE_REQUESTED sets loading', () => {
    const next = chatReducer(withSession('s'), { type: 'HISTORY_PAGE_REQUESTED', sessionId: 's' });
    expect(next.get('s')!.history.loading).toBe(true);
  });

  it('a first page builds the timeline and records the cursor', () => {
    let st = withSession('s');
    st = chatReducer(st, { type: 'HISTORY_PAGE_REQUESTED', sessionId: 's' });
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u1', 'hello'), asstEvent('s', 'a1', 'hi')],
      cursor: { path: 'p', offset: 100, sizeAtRead: 500 }, hasMore: true,
    });
    const sess = st.get('s')!;
    expect(sess.timeline.filter((e) => e.kind === 'user')).toHaveLength(1);
    expect(sess.timeline.filter((e) => e.kind === 'assistant-turn')).toHaveLength(1);
    expect(sess.history).toEqual({ cursor: { path: 'p', offset: 100, sizeAtRead: 500 }, hasMore: true, loading: false });
  });

  it('a second (older) page PREPENDS before the first', () => {
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u2', 'newer')],
      cursor: { path: 'p', offset: 50, sizeAtRead: 500 }, hasMore: true,
    });
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u1', 'older')],
      cursor: null, hasMore: false,
    });
    const users = st.get('s')!.timeline.filter((e) => e.kind === 'user') as any[];
    expect(users.map((u) => u.message.content)).toEqual(['older', 'newer']);
    expect(st.get('s')!.history.hasMore).toBe(false);
    expect(st.get('s')!.history.cursor).toBeNull();
  });

  it('a prepended page does not collide with the ids already on screen', () => {
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u2', 'newer'), asstEvent('s', 'a2', 'reply newer')],
      cursor: { path: 'p', offset: 50, sizeAtRead: 500 }, hasMore: true,
    });
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's',
      events: [userEvent('s', 'u1', 'older'), asstEvent('s', 'a1', 'reply older')],
      cursor: null, hasMore: false,
    });
    const sess = st.get('s')!;
    const turnIds = sess.timeline.filter((e) => e.kind === 'assistant-turn').map((e: any) => e.turnId);
    expect(new Set(turnIds).size).toBe(turnIds.length);
    // Every rendered turn resolves to a real entry in the turns map.
    for (const id of turnIds) expect(sess.assistantTurns.has(id)).toBe(true);
  });

  it('HISTORY_PAGE_FAILED clears loading and keeps the cursor', () => {
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's', events: [userEvent('s', 'u1', 'x')],
      cursor: { path: 'p', offset: 7, sizeAtRead: 9 }, hasMore: true,
    });
    st = chatReducer(st, { type: 'HISTORY_PAGE_REQUESTED', sessionId: 's' });
    st = chatReducer(st, { type: 'HISTORY_PAGE_FAILED', sessionId: 's' });
    expect(st.get('s')!.history.loading).toBe(false);
    expect(st.get('s')!.history.cursor).toEqual({ path: 'p', offset: 7, sizeAtRead: 9 });
  });

  it('history survives a serialize/deserialize round trip, and a pre-field snapshot defaults', () => {
    let st = withSession('s');
    st = chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 's', events: [userEvent('s', 'u1', 'x')],
      cursor: { path: 'p', offset: 7, sizeAtRead: 9 }, hasMore: true,
    });
    const round = deserializeChatState(serializeChatState(st));
    expect(round.get('s')!.history).toEqual({ cursor: { path: 'p', offset: 7, sizeAtRead: 9 }, hasMore: true, loading: false });

    // An older host's snapshot has no `history` field at all.
    const legacy = serializeChatState(st);
    delete (legacy.sessions[0][1] as any).history;
    expect(deserializeChatState(legacy).get('s')!.history).toEqual({ cursor: null, hasMore: false, loading: false });
  });

  it('an unknown session is a no-op, not a crash', () => {
    const st = withSession('s');
    expect(chatReducer(st, { type: 'HISTORY_PAGE_REQUESTED', sessionId: 'nope' })).toBe(st);
    expect(chatReducer(st, {
      type: 'HISTORY_PAGE_LOADED', sessionId: 'nope', events: [], cursor: null, hasMore: false,
    })).toBe(st);
  });
});
