// How long the prefill readout is allowed to live.
//
// The contract (Destin): "Prompt-processing copy should only show during REAL
// prompt processing, not while generating." chat-types.ts documented exactly
// that — "cleared by any other event, so it lives exactly as long as the
// pre-first-token wait" — but the reducer only ever wrote `promptProcessing` in
// TWO cases, and neither the assistant-output path nor endTurn() cleared it.
//
// So after prefill finished the object sat in state indefinitely, and
// ThinkingIndicator only suppresses itself for 2s after the last output token.
// Any generation pause longer than that re-rendered the OLD "Reading your
// prompt — N%" line while the model was mid-generation. Found by the 2026-07-28
// audit; the doc comment was wrong, not the intent.
import { describe, it, expect } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState } from '../src/renderer/state/chat-types';

const S = 's';
const withPrefill = (): ChatState => {
  let st = chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: S });
  st = chatReducer(st, {
    type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: S, uuid: 'h1', timestamp: 1,
    promptProcessing: { promptTokens: 5519, budgetMs: 0, processed: 5519 },
  } as any);
  return st;
};
const pp = (st: ChatState) => st.get(S)!.promptProcessing;

describe('promptProcessing lifecycle', () => {
  it('is set by a heartbeat that carries it', () => {
    expect(pp(withPrefill())).not.toBeNull();
  });

  it('is CLEARED by the first assistant text — prefill is over once output starts', () => {
    const st = chatReducer(withPrefill(), {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: S, uuid: 'a1', timestamp: 2,
      text: 'hello', partId: 'p1',
    } as any);
    expect(pp(st)).toBeNull();
  });

  it('is CLEARED by reasoning output too', () => {
    const st = chatReducer(withPrefill(), {
      type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: S, uuid: 'r1', timestamp: 2,
      text: 'thinking', partId: 'p1',
    } as any);
    expect(pp(st)).toBeNull();
  });

  it('is CLEARED when the turn ends', () => {
    // Otherwise the next turn opens carrying the previous turn's percentage.
    const st = chatReducer(withPrefill(), {
      type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: S, uuid: 't1', timestamp: 3,
      stopReason: null, model: null, anthropicRequestId: null, usage: null,
    } as any);
    expect(pp(st)).toBeNull();
  });

  it('is CLEARED when a turn is interrupted', () => {
    const st = chatReducer(withPrefill(), { type: 'TRANSCRIPT_INTERRUPT', sessionId: S, uuid: 'i1', timestamp: 3 } as any);
    expect(pp(st)).toBeNull();
  });

  it('is CLEARED when a new user message starts a turn', () => {
    // Parity with TRANSCRIPT_SKILL_INVOKED, which already did this.
    const st = chatReducer(withPrefill(), {
      type: 'USER_PROMPT', sessionId: S, content: 'next', timestamp: 4,
    } as any);
    expect(pp(st)).toBeNull();
  });

  it('SURVIVES a stall-warning heartbeat — that warning is ABOUT this prefill', () => {
    // The one case where keeping it is right: nulling here wiped the progress
    // readout at the exact moment the user most needs to see it is advancing.
    const st = chatReducer(withPrefill(), {
      type: 'TRANSCRIPT_THINKING_HEARTBEAT', sessionId: S, uuid: 'h2', timestamp: 5,
      stallWarning: { retryInMs: 15_000, willRetry: true },
    } as any);
    expect(pp(st)).not.toBeNull();
  });
});
