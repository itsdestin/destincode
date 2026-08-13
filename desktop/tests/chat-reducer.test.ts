import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import { hookEventToAction } from '../src/renderer/state/hook-dispatcher';
import type { HookEvent } from '../src/shared/types';

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

  it('carries permissionMode onto the tool entry, on the matched AND synthetic paths', () => {
    // Matched-running-tool path.
    state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'git push origin master' }));
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'git push origin master' },
      requestId: 'req-fa',
      denyListed: true,
      permissionMode: 'full-auto',
    });
    expect(state.get(SESSION)!.toolCalls.get('tool-a')!.permissionMode).toBe('full-auto');

    // Permission-before-transcript synthetic path (no running tool to match).
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'sudo ls' },
      requestId: 'req-syn',
      denyListed: true,
      permissionMode: 'full-auto',
    });
    const syn = [...state.get(SESSION)!.toolCalls.values()].find((t) => t.requestId === 'req-syn')!;
    expect(syn.permissionMode).toBe('full-auto');
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

  // Task 13: denyListed must survive onto the tool so ToolCard can gate the
  // consequence-warning "Always allow". Covers both the matched-tool branch and
  // the synthetic-entry branch.
  it('carries denyListed onto the matched running tool', () => {
    state = dispatch(state, toolUse('tool-a', 'Bash', { command: 'rm -rf /' }));
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      requestId: 'native-req-5',
      denyListed: true,
    });
    expect(state.get(SESSION)!.toolCalls.get('tool-a')!.denyListed).toBe(true);
  });

  it('carries denyListed onto a synthetic entry', () => {
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
      requestId: 'native-req-6',
      denyListed: true,
    });
    expect(state.get(SESSION)!.toolCalls.get('perm-native-req-6')!.denyListed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PERMISSION_RESPONDED → synthetic budget gates (max_steps / doom_loop)
// Regression: a budget gate is a synthetic ask with no real tool execution, so
// no TRANSCRIPT_TOOL_RESULT ever closes its card. If the card stays 'running'
// after the response, endTurn() force-fails it 'Turn ended' on a normal finish.
// The card must close 'complete' on response. (The tier-3 "first running tool of
// any name" fallback this also used to cite was deleted 2026-08-09.)
// ---------------------------------------------------------------------------
describe('PERMISSION_RESPONDED budget gates', () => {
  let state: ChatState;

  const budgetAsk = (requestId: string, toolName: 'max_steps' | 'doom_loop', input: Record<string, unknown>): ChatAction => ({
    type: 'PERMISSION_REQUEST',
    sessionId: SESSION,
    toolName,
    input,
    requestId,
  });
  const responded = (requestId: string): ChatAction => ({
    type: 'PERMISSION_RESPONDED',
    sessionId: SESSION,
    requestId,
  });

  beforeEach(() => {
    state = initState();
  });

  it('closes a max_steps card complete (not running) on response', () => {
    state = dispatch(state, budgetAsk('req-1', 'max_steps', { steps: 50 }));
    state = dispatch(state, responded('req-1'));

    const card = state.get(SESSION)!.toolCalls.get('perm-req-1')!;
    expect(card.status).toBe('complete');
    expect(card.requestId).toBeUndefined();
  });

  it('a same-turn re-trip synthesizes a FRESH card instead of reusing the orphan', () => {
    state = dispatch(state, budgetAsk('req-1', 'max_steps', { steps: 50 }));
    state = dispatch(state, responded('req-1'));
    // Second trip in the same turn — different requestId, larger step count.
    state = dispatch(state, budgetAsk('req-2', 'max_steps', { steps: 100 }));

    const session = state.get(SESSION)!;
    // The first card stays closed; a brand-new synthetic card is awaiting approval.
    expect(session.toolCalls.get('perm-req-1')!.status).toBe('complete');
    const fresh = session.toolCalls.get('perm-req-2')!;
    expect(fresh.status).toBe('awaiting-approval');
    expect(fresh.requestId).toBe('req-2');
    expect(fresh.input).toEqual({ steps: 100 });
  });

  it('turn completion does NOT force-fail an answered budget-gate card', () => {
    state = dispatch(state, budgetAsk('req-1', 'max_steps', { steps: 50 }));
    state = dispatch(state, responded('req-1'));
    state = dispatch(state, { type: 'TRANSCRIPT_TURN_COMPLETE', sessionId: SESSION } as ChatAction);

    const card = state.get(SESSION)!.toolCalls.get('perm-req-1')!;
    expect(card.status).toBe('complete');
    expect(card.error).toBeUndefined();
  });

  it('a real tool still returns to running on response (budget-gate carve-out is scoped)', () => {
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'uuid-tool-a',
      toolUseId: 'tool-a',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      timestamp: 1000,
    } as ChatAction);
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'ls' },
      requestId: 'req-9',
    });
    state = dispatch(state, responded('req-9'));

    expect(state.get(SESSION)!.toolCalls.get('tool-a')!.status).toBe('running');
  });
});

// ---------------------------------------------------------------------------
// hookEventToAction — native denyListed passthrough (Task 13)
// ---------------------------------------------------------------------------
describe('hookEventToAction PermissionRequest', () => {
  it('passes denyListed from the broker payload into the action', () => {
    const action = hookEventToAction({
      type: 'PermissionRequest',
      sessionId: SESSION,
      payload: {
        _requestId: 'native-abc',
        tool_name: 'Bash',
        tool_input: { command: 'git push --force' },
        denyListed: true,
      },
      timestamp: Date.now(),
    } as HookEvent);
    expect(action).not.toBeNull();
    expect(action!.type).toBe('PERMISSION_REQUEST');
    expect((action as any).denyListed).toBe(true);
  });

  it('leaves denyListed undefined for a CC event without it', () => {
    const action = hookEventToAction({
      type: 'PermissionRequest',
      sessionId: SESSION,
      payload: {
        _requestId: 'cc-xyz',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
        permission_suggestions: ['Bash(ls:*)'],
      },
      timestamp: Date.now(),
    } as HookEvent);
    expect((action as any).denyListed).toBeUndefined();
    expect((action as any).permissionSuggestions).toEqual(['Bash(ls:*)']);
  });
});

// ---------------------------------------------------------------------------
// Native runtime reducer paths (Task 11): text partId merge + NATIVE_SESSION_ERROR
// ---------------------------------------------------------------------------
describe('native runtime reducer paths', () => {
  let state: ChatState;

  beforeEach(() => {
    state = initState();
  });

  it('TRANSCRIPT_ASSISTANT_TEXT with partId merges same-part deltas into one segment', () => {
    // Native harness streams text as per-token deltas carrying a shared partId;
    // same partId → append to the last text segment (mirrors reasoning).
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'Hello ', timestamp: 1, partId: 'p1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't2', text: 'world', timestamp: 2, partId: 'p1' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(1);
    expect(turn.segments[0]).toMatchObject({ type: 'text', content: 'Hello world', partId: 'p1' });
  });

  it('does NOT over-merge: a new partId or an interleaved reasoning segment starts a new text segment', () => {
    // text p1 → reasoning r1 → text p2 → segments types [text, reasoning, text].
    // The reasoning segment breaks adjacency, and p2 differs from p1 anyway, so
    // the second text can never merge into the first.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'A', timestamp: 1, partId: 'p1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_REASONING', sessionId: SESSION, uuid: 'r1', text: 'thinking', timestamp: 2, partId: 'rprt_1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't2', text: 'B', timestamp: 3, partId: 'p2' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.map((s) => s.type)).toEqual(['text', 'reasoning', 'text']);
    expect(turn.segments[0]).toMatchObject({ type: 'text', content: 'A', partId: 'p1' });
    expect(turn.segments[2]).toMatchObject({ type: 'text', content: 'B', partId: 'p2' });
  });

  it('two adjacent text deltas with DIFFERENT partIds do not merge (partId mismatch alone forces a new segment)', () => {
    // Isolates the last.partId === action.partId clause: both segments are
    // type 'text' and adjacent (no reasoning between), so the ONLY thing
    // preventing a merge is the mismatched partId.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'A', timestamp: 1, partId: 'p1' });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't2', text: 'B', timestamp: 2, partId: 'p2' });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
    expect(turn.segments[0]).toMatchObject({ type: 'text', content: 'A', partId: 'p1' });
    expect(turn.segments[1]).toMatchObject({ type: 'text', content: 'B', partId: 'p2' });
  });

  it('events WITHOUT partId keep the whole-block append (CC path untouched)', () => {
    // CC's transcript path sends whole text blocks with no partId — undefined
    // never satisfies the merge predicate, so each stays its own segment.
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't1', text: 'first block', timestamp: 1 });
    state = dispatch(state, { type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SESSION, uuid: 't2', text: 'second block', timestamp: 2 });

    const turn = [...state.get(SESSION)!.assistantTurns.values()][0];
    expect(turn.segments.length).toBe(2);
    expect(turn.segments[0]).toMatchObject({ type: 'text', content: 'first block' });
    expect(turn.segments[1]).toMatchObject({ type: 'text', content: 'second block' });
  });

  it('NATIVE_SESSION_ERROR ends the turn and surfaces attentionState error + message', () => {
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'do a thing', timestamp: 1 });
    expect(state.get(SESSION)!.isThinking).toBe(true);

    state = dispatch(state, { type: 'NATIVE_SESSION_ERROR', sessionId: SESSION, message: 'Rate limit exceeded' });

    const session = state.get(SESSION)!;
    expect(session.isThinking).toBe(false);
    expect(session.attentionState).toBe('error');
    expect(session.errorMessage).toBe('Rate limit exceeded');
    expect(session.currentTurnId).toBeNull();
  });

  it('the next user prompt clears the error state', () => {
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'first', timestamp: 1 });
    state = dispatch(state, { type: 'NATIVE_SESSION_ERROR', sessionId: SESSION, message: 'boom' });
    expect(state.get(SESSION)!.attentionState).toBe('error');

    // Typing again is the retry — clears both attentionState and errorMessage.
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'retry', timestamp: 2 });
    const session = state.get(SESSION)!;
    expect(session.attentionState).toBe('ok');
    expect(session.errorMessage).toBeNull();
  });

  it('NATIVE_MODEL_STATE_CHANGED sets modelState + modelInfo without touching turn state', () => {
    state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'hi', timestamp: 1 });
    expect(state.get(SESSION)!.isThinking).toBe(true);

    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    let s = state.get(SESSION)!;
    expect(s.modelState).toBe('loading');
    expect(s.modelInfo).toEqual({ modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(s.isThinking).toBe(true); // model residency is orthogonal to the turn

    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'sleeping', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelState).toBe('sleeping');

    // No-op when unchanged → same object reference (cheap, no needless render).
    const before = state.get(SESSION)!;
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'sleeping', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!).toBe(before);
  });

  it('NATIVE_MODEL_STATE_CHANGED re-renders on load-progress bytes even when state is unchanged', () => {
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-9B', sizeBytes: 9_000_000_000, loadedBytes: 1_000_000_000 });
    expect(state.get(SESSION)!.modelLoadedBytes).toBe(1_000_000_000);

    // Same state, MORE bytes resident → must produce a new object (progress bar advances).
    const before = state.get(SESSION)!;
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-9B', sizeBytes: 9_000_000_000, loadedBytes: 6_000_000_000 });
    expect(state.get(SESSION)!).not.toBe(before);
    expect(state.get(SESSION)!.modelLoadedBytes).toBe(6_000_000_000);

    // Identical bytes → no-op (same reference).
    const same = state.get(SESSION)!;
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-9B', sizeBytes: 9_000_000_000, loadedBytes: 6_000_000_000 });
    expect(state.get(SESSION)!).toBe(same);
  });

  it('modelEverResident latches on first loaded and stays true through sleep/unload', () => {
    // Fresh session's cold state: not yet resident → the Reload prompt must NOT
    // key on this (ModelLoadingBar shows the loading bar instead).
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'unloaded', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelEverResident).toBe(false);

    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loading', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelEverResident).toBe(false);

    // First time fully loaded → latch true.
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'loaded', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelEverResident).toBe(true);

    // Idle sleep after use → still true, so the Reload prompt is now valid.
    state = dispatch(state, { type: 'NATIVE_MODEL_STATE_CHANGED', sessionId: SESSION, state: 'sleeping', modelId: 'Qwen-2B', sizeBytes: 2_000_000_000 });
    expect(state.get(SESSION)!.modelEverResident).toBe(true);
  });

  // ---- Task 12: queued messages leave the timeline — docked strip list ----
  describe('QUEUED_MESSAGE_ADDED / QUEUED_MESSAGE_REMOVED', () => {
    it('QUEUED_MESSAGE_ADDED appends to queuedMessages, not the timeline', () => {
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'queued msg', timestamp: 1 });
      expect(state.get(SESSION)!.timeline).toHaveLength(0);
      expect(state.get(SESSION)!.queuedMessages).toEqual([{ queueId: 'q-1', content: 'queued msg', timestamp: 1 }]);
    });

    it('QUEUED_MESSAGE_REMOVED removes only the matching entry, leaving others untouched', () => {
      state = dispatch(state, { type: 'USER_PROMPT', sessionId: SESSION, content: 'keep me (sent)', timestamp: 1 });
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'cancel me', timestamp: 2 });
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-2', content: 'keep me (queued)', timestamp: 3 });
      expect(state.get(SESSION)!.timeline).toHaveLength(1); // only the sent-path bubble
      expect(state.get(SESSION)!.queuedMessages).toHaveLength(2);

      state = dispatch(state, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: SESSION, queueId: 'q-1' });

      expect(state.get(SESSION)!.timeline).toHaveLength(1); // untouched
      expect(state.get(SESSION)!.queuedMessages).toEqual([{ queueId: 'q-2', content: 'keep me (queued)', timestamp: 3 }]);
    });

    it('is a no-op when the drain already won the race (TRANSCRIPT_USER_MESSAGE confirmed first)', () => {
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'racer', timestamp: 1 });
      // Confirm arrives first — the drain-side removal (TRANSCRIPT_USER_MESSAGE) already cleared the list entry.
      state = dispatch(state, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-1', text: 'racer', timestamp: 2 });
      const before = state.get(SESSION)!;
      expect(before.queuedMessages).toEqual([]);
      expect(before.timeline).toHaveLength(1);

      state = dispatch(state, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: SESSION, queueId: 'q-1' });

      // No-op: same object reference, timeline entry still present and confirmed.
      expect(state.get(SESSION)!).toBe(before);
      expect(state.get(SESSION)!.timeline).toHaveLength(1);
    });

    it('is a no-op for an unknown session id', () => {
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'irrelevant', timestamp: 1 });
      const before = state;
      state = dispatch(state, { type: 'QUEUED_MESSAGE_REMOVED', sessionId: 'ghost-session', queueId: 'q-1' });
      expect(state).toBe(before);
    });

    it('TRANSCRIPT_USER_MESSAGE appends the drained queued message at the END (true position), not in place of a bubble that was never written', () => {
      state = dispatch(state, { type: 'QUEUED_MESSAGE_ADDED', sessionId: SESSION, queueId: 'q-1', content: 'confirm me', timestamp: 1 });
      expect(state.get(SESSION)!.timeline).toHaveLength(0);
      state = dispatch(state, { type: 'TRANSCRIPT_USER_MESSAGE', sessionId: SESSION, uuid: 'u-1', text: 'confirm me', timestamp: 2 });
      const timeline = state.get(SESSION)!.timeline;
      expect(timeline).toHaveLength(1);
      const entry = timeline[0];
      expect(entry).toMatchObject({ kind: 'user', pending: false });
      if (entry.kind === 'user') expect(entry.message.content).toBe('confirm me');
      expect(state.get(SESSION)!.queuedMessages).toEqual([]);
    });
  });
});
