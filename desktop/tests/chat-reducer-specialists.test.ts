import { describe, it, expect, beforeEach } from 'vitest';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import { ChatState, ChatAction } from '../src/renderer/state/chat-types';
import type { SpecialistRunView, SubagentSegment } from '../src/shared/types';

// Task 11: the reducer half of "specialists". A Task card's status IS its
// ledger record — SPECIALIST_RUN_CHANGED folds a run view onto the launching
// card and rebuilds its Activity-trail note rows from run.notes. This file is
// the branch's FIRST renderer specialist reducer test — several cases below
// pin behavior that already shipped (the ask nesting/reclaim plumbing); the
// note-rebuild and short-circuit cases are what actually drive new code.

const SESSION = 'test-session';
const TASK_ID = 'task-1';
const CHILD_ID = 'child-1';

function initState(): ChatState {
  const state: ChatState = new Map();
  return chatReducer(state, { type: 'SESSION_INIT', sessionId: SESSION });
}

function dispatch(state: ChatState, action: ChatAction): ChatState {
  return chatReducer(state, action);
}

/** Seeds a session with one Task card (the way a real Task tool-use event
 *  creates it) so SPECIALIST_RUN_CHANGED / PERMISSION_REQUEST / PERMISSION_HELD
 *  have a card to fold onto — mirrors the real event that always precedes a
 *  ledger write (chat-reducer.ts's SPECIALIST_RUN_CHANGED comment). */
function seedTaskCard(state: ChatState, toolUseId = TASK_ID): ChatState {
  return dispatch(state, {
    type: 'TRANSCRIPT_TOOL_USE',
    sessionId: SESSION,
    uuid: `uuid-${toolUseId}`,
    toolUseId,
    toolName: 'Task',
    toolInput: { description: 'hire a specialist' },
  });
}

function note(text: string, at: number, from: 'user' | 'assistant' = 'user') {
  return { text, from, at };
}

function baseRun(overrides: Partial<SpecialistRunView> = {}): SpecialistRunView {
  return {
    childId: CHILD_ID,
    parentToolCallId: TASK_ID,
    agentType: 'explorer',
    title: 'Nadia the Rambling Researcher',
    background: false,
    status: 'running',
    startedAt: 1000,
    steps: 1,
    ...overrides,
  };
}

function noteSegments(state: ChatState, toolUseId = TASK_ID): SubagentSegment[] {
  const card = state.get(SESSION)!.toolCalls.get(toolUseId)!;
  return (card.subagentSegments ?? []).filter((s) => s.type === 'note');
}

describe('SPECIALIST_RUN_CHANGED — note rows from run.notes', () => {
  let state: ChatState;

  beforeEach(() => {
    state = seedTaskCard(initState());
  });

  it('with two notes yields two rows; the same event again yields two rows (idempotent by construction)', () => {
    const run = baseRun({ notes: [note('first', 100), note('second', 200)] });

    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });
    let notes = noteSegments(state);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => (n as any).content)).toEqual(['first', 'second']);

    // Re-processing the identical run (a deep-equal but distinct object —
    // exercises the short-circuit below, not object identity) must not grow
    // the row count.
    const stateAfterFirst = state;
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED',
      sessionId: SESSION,
      run: JSON.parse(JSON.stringify(run)),
    });
    expect(state).toBe(stateAfterFirst); // short-circuit: same object, not just same content
    notes = noteSegments(state);
    expect(notes).toHaveLength(2);
  });

  it('a run with a third note yields three rows in timestamp order', () => {
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED',
      sessionId: SESSION,
      run: baseRun({ steps: 1, notes: [note('first', 100), note('second', 200)] }),
    });
    state = dispatch(state, {
      type: 'SPECIALIST_RUN_CHANGED',
      sessionId: SESSION,
      run: baseRun({ steps: 2, notes: [note('first', 100), note('second', 200), note('third', 300)] }),
    });

    const notes = noteSegments(state);
    expect(notes).toHaveLength(3);
    expect(notes.map((n) => (n as any).content)).toEqual(['first', 'second', 'third']);
    expect(notes.map((n) => (n as any).timestamp)).toEqual([100, 200, 300]);
  });

  it('two notes with the same timestamp and text are TWO rows', () => {
    // Ambiguity resolved for the implementer: note segment ids are
    // index-based (sa-note-<childId>-<i>), not timestamp-based, precisely so
    // two notes landing in the same millisecond don't collide on id and get
    // deduped down to one row.
    const run = baseRun({ notes: [note('same', 500), note('same', 500)] });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });

    const notes = noteSegments(state);
    expect(notes).toHaveLength(2);
    expect(notes[0].id).not.toBe(notes[1].id);
  });

  it('a run event for an unknown parentToolCallId is dropped, never a stray card', () => {
    const before = state;
    const run = baseRun({ parentToolCallId: 'no-such-card', childId: 'no-such-child', notes: [note('x', 1)] });
    const after = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });

    // Dropped, not parked: the reducer returns state itself, unchanged.
    expect(after).toBe(before);
    expect(after.get(SESSION)!.toolCalls.has('no-such-card')).toBe(false);
    expect(after.get(SESSION)!.toolCalls.size).toBe(1); // only the seeded Task card
  });

  it('a run view identical to the card’s current one returns the SAME state object (no churn)', () => {
    // Models the delivery-bookkeeping cycle (claim / mark-attempted / confirm
    // / release): the projection reaching the renderer is byte-identical
    // across up to four ledger writes, and the reducer — not the emit path —
    // must absorb them.
    const run = baseRun({ notes: [note('only', 1)] });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run });
    const settled = state;

    for (let i = 0; i < 4; i++) {
      state = dispatch(state, {
        type: 'SPECIALIST_RUN_CHANGED',
        sessionId: SESSION,
        run: JSON.parse(JSON.stringify(run)),
      });
      expect(state).toBe(settled);
    }
  });

  it('replay then live: a newer live run view lands after a replayed one and wins; the replayed one re-sent afterwards does not regress or duplicate note rows', () => {
    // The main-process replay loop is synchronous — a live event cannot land
    // INSIDE it. This models the window right after replay completes: the
    // replayed (older, fewer notes) run lands first, a live (newer, more
    // notes) run lands right after and wins, and then — the case this test
    // actually exists to pin — the stale replayed run is re-sent.
    const replayedRun = baseRun({ steps: 1, notes: [note('first', 100)] });
    const liveRun = baseRun({ steps: 3, notes: [note('first', 100), note('second', 200)] });

    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: replayedRun });
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: liveRun });

    let card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    expect(card.specialistRun).toEqual(liveRun);
    expect(noteSegments(state)).toHaveLength(2);

    // The stale replayed run is re-sent. It is NOT deep-equal to the card's
    // current (live) run, so the short-circuit does not apply — per the
    // reducer's stated contract that only fires on an exact match, this run
    // event still applies normally (SPECIALIST_RUN_CHANGED has no notion of
    // "older"; there is no sequence/version field on SpecialistRunView to
    // detect staleness). What must NOT happen is losing the note row the live
    // run already added: notes are merged by id (never replaced wholesale),
    // so a resend that carries fewer notes cannot delete one already shown.
    state = dispatch(state, { type: 'SPECIALIST_RUN_CHANGED', sessionId: SESSION, run: replayedRun });

    card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    const notes = noteSegments(state);
    expect(notes).toHaveLength(2); // 'second' must not have been dropped
    expect(notes.map((n) => (n as any).content)).toEqual(['first', 'second']);
    // No duplicate row for 'first' either — the resend's note is already known.
    expect(new Set(notes.map((n) => n.id)).size).toBe(2);
  });
});

describe('SPECIALIST_RUN_CHANGED — ask plumbing (pinning existing behavior)', () => {
  let state: ChatState;

  beforeEach(() => {
    state = seedTaskCard(initState());
  });

  it('PERMISSION_HELD sets askHeld on the nested row and nowhere else', () => {
    // First, a specialist child's ask nests under the Task card as a
    // synthetic sa-perm-<requestId> segment (PERMISSION_REQUEST, no matching
    // running tool segment yet).
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'ls' },
      requestId: 'req-1',
      specialist: { childId: CHILD_ID, agentType: 'explorer', title: 'Nadia', parentToolCallId: TASK_ID },
    });

    let card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    let segs = card.subagentSegments ?? [];
    expect(segs).toHaveLength(1);
    expect((segs[0] as any).status).toBe('awaiting-approval');

    state = dispatch(state, { type: 'PERMISSION_HELD', sessionId: SESSION, requestId: 'req-1' });

    card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    segs = card.subagentSegments ?? [];
    expect((segs[0] as any).askHeld).toBe(true);
    // ToolCallState has no askHeld field at all — the top-level card itself
    // must be untouched by this action.
    expect((card as any).askHeld).toBeUndefined();
  });

  it('the sa-perm- placeholder is reclaimed when the tool-use event lands after the ask', () => {
    state = dispatch(state, {
      type: 'PERMISSION_REQUEST',
      sessionId: SESSION,
      toolName: 'Bash',
      input: { command: 'ls' },
      requestId: 'req-2',
      specialist: { childId: CHILD_ID, agentType: 'explorer', title: 'Nadia', parentToolCallId: TASK_ID },
    });

    let card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    let segs = card.subagentSegments ?? [];
    expect(segs).toHaveLength(1);
    expect(segs[0].id).toBe('sa-perm-req-2');

    // The child's real tool-use event lands after the ask, naming the same
    // tool and input. It must reclaim the placeholder in place, not push a
    // second segment.
    state = dispatch(state, {
      type: 'TRANSCRIPT_TOOL_USE',
      sessionId: SESSION,
      uuid: 'uuid-child-tool-1',
      toolUseId: 'child-tool-1',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
      parentAgentToolUseId: TASK_ID,
    });

    card = state.get(SESSION)!.toolCalls.get(TASK_ID)!;
    segs = card.subagentSegments ?? [];
    expect(segs).toHaveLength(1); // reclaimed, not duplicated
    const seg = segs[0] as any;
    expect(seg.id).toBe('sa-tool-child-tool-1');
    expect(seg.toolUseId).toBe('child-tool-1');
    // The ask state survives the handover — this is the whole point of the
    // reclaim: a real tool-use event must not blow away a pending approval.
    expect(seg.status).toBe('awaiting-approval');
    expect(seg.requestId).toBe('req-2');
  });
});
