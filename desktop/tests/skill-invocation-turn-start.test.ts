// A skill invocation is a TURN START, and the UI has to know that.
//
// Destin, 2026-07-28: "invoking a skill needs to act as a user message and begin
// the thinking indicator and prompt processing/other loading indicators that
// would show up if i just typed the message normally."
//
// The first version only appended a timeline card. Nothing set isThinking, so the
// session sat visually idle while the model worked — no spinner, no prefill
// progress, and the stall watchdog had no turn to watch.
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { SessionChatState, ChatState } from '../src/renderer/state/chat-types';

function sessionWith(over: Partial<SessionChatState> = {}): ChatState {
  const base = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: 's' });
  return new Map([['s', { ...base.get('s')!, ...over }]]);
}

const invoke = (uuid = 'u1') => ({
  type: 'TRANSCRIPT_SKILL_INVOKED' as const,
  sessionId: 's', uuid, timestamp: 1,
  skillId: 'p:theme-builder', displayName: 'Theme Builder', skillPath: '/x/SKILL.md',
});

describe('TRANSCRIPT_SKILL_INVOKED starts a turn', () => {
  it('sets isThinking so the indicator appears', () => {
    const out = chatReducer(sessionWith(), invoke());
    expect(out.get('s')!.isThinking).toBe(true);
  });

  it('resets the turn/group cursors like a typed message does', () => {
    const out = chatReducer(sessionWith({ currentTurnId: 'old', currentGroupId: 'g' } as any), invoke());
    expect(out.get('s')!.currentTurnId).toBeNull();
    expect(out.get('s')!.currentGroupId).toBeNull();
  });

  it('clears a stale error banner — a new turn starts clean', () => {
    const out = chatReducer(
      sessionWith({ attentionState: 'error', errorMessage: 'boom' } as any),
      invoke(),
    );
    expect(out.get('s')!.attentionState).toBe('ok');
    expect(out.get('s')!.errorMessage).toBeNull();
  });

  it('clears a stale stall warning and prefill progress from the PREVIOUS turn', () => {
    const out = chatReducer(
      sessionWith({ stallWarning: { retryInMs: 1, willRetry: true }, promptProcessing: { promptTokens: 9, budgetMs: 1 } } as any),
      invoke(),
    );
    expect(out.get('s')!.stallWarning).toBeNull();
    expect(out.get('s')!.promptProcessing).toBeNull();
  });

  it('appends exactly one invocation card', () => {
    const out = chatReducer(sessionWith(), invoke());
    const tl = out.get('s')!.timeline;
    expect(tl.filter((e) => e.kind === 'skill-invocation')).toHaveLength(1);
  });

  it('never shows the instructions — only the card', () => {
    const out = chatReducer(sessionWith(), invoke());
    expect(JSON.stringify(out.get('s')!.timeline)).not.toContain('skill-instructions');
  });

  it('replaying the same uuid does not add a second card or restart the turn', () => {
    // The event replays on resume; a second card would imply it ran twice.
    const once = chatReducer(sessionWith(), invoke('same'));
    const twice = chatReducer(once, invoke('same'));
    expect(twice.get('s')!.timeline.filter((e) => e.kind === 'skill-invocation')).toHaveLength(1);
  });
});
