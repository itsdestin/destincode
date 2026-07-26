import {
  AssistantTurn,
  AssistantTurnSegment,
  ChatAction,
  ChatState,
  SessionChatState,
  TimelineEntry,
  createSessionChatState,
  deserializeChatState,
  HISTORY_EXPAND_PROMPT_ID,
} from './chat-types';
import { SubagentSegment, ToolCallState } from '../../shared/types';

// Fix: message ids are used as React keys. A hydrated remote client restarts
// this counter at 0 while its snapshot already holds msg-1..msg-N, so new live
// messages reused existing keys and React mis-reconciled — messages rendering
// in the wrong place, not updating, or the list jumping after connect. The
// per-boot epoch makes ids unique across the hydrate boundary without pulling
// in a uuid/nanoid dependency, and keeps them greppable/ordered in logs.
const ID_EPOCH = Math.random().toString(36).slice(2, 8);
let messageCounter = 0;
function nextMessageId(): string {
  return `msg-${ID_EPOCH}-${++messageCounter}`;
}

let groupCounter = 0;
function nextGroupId(): string {
  return `group-${++groupCounter}`;
}

let turnCounter = 0;
function nextTurnId(): string {
  return `turn-${++turnCounter}`;
}

/**
 * Key-order-independent JSON serialization, used to compare a permission
 * hook's `tool_input` against a transcript tool's `input`. The two arrive
 * from different sources (named-pipe relay vs JSONL parse) and plain
 * JSON.stringify equality would fail whenever their key order differs.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/**
 * Returns the current assistant turn (or creates a new one).
 * All assistant text and tool groups within a single turn accumulate here.
 */
function getOrCreateTurn(session: SessionChatState): {
  assistantTurns: Map<string, AssistantTurn>;
  timeline: TimelineEntry[];
  currentTurnId: string;
} {
  const assistantTurns = new Map(session.assistantTurns);
  let timeline = session.timeline;
  let currentTurnId = session.currentTurnId;

  if (currentTurnId && assistantTurns.has(currentTurnId)) {
    return { assistantTurns, timeline, currentTurnId };
  }

  currentTurnId = nextTurnId();
  // Metadata fields default to null here; turn-complete populates them later (see TRANSCRIPT_TURN_COMPLETE).
  assistantTurns.set(currentTurnId, {
    id: currentTurnId,
    segments: [],
    timestamp: Date.now(),
    stopReason: null,
    model: null,
    usage: null,
    anthropicRequestId: null,
  });
  timeline = [...timeline, { kind: 'assistant-turn' as const, turnId: currentTurnId }];
  return { assistantTurns, timeline, currentTurnId };
}

/**
 * Inject a plan segment into the current turn for an ExitPlanMode tool_use.
 * Returns a new assistantTurns Map (or the original if no injection happened).
 *
 * - Dedups by toolUseId so re-emits of the same tool_use don't duplicate bubbles.
 * - If `beforeGroupId` is provided (merge-synthetic path, where the tool-group
 *   already exists), splices the plan segment in before it so the plan renders
 *   above the approval card. Otherwise appends.
 */
function injectPlanSegment(
  assistantTurns: Map<string, AssistantTurn>,
  currentTurnId: string,
  toolUseId: string,
  toolInput: Record<string, unknown>,
  beforeGroupId?: string,
): Map<string, AssistantTurn> {
  const plan = toolInput.plan;
  if (typeof plan !== 'string' || !plan) return assistantTurns;
  const turn = assistantTurns.get(currentTurnId);
  if (!turn) return assistantTurns;
  const planFilePath = typeof toolInput.planFilePath === 'string' ? toolInput.planFilePath : undefined;
  const existingIdx = turn.segments.findIndex(
    (s) => s.type === 'plan' && s.toolUseId === toolUseId,
  );
  let newSegments: AssistantTurnSegment[];
  if (existingIdx >= 0) {
    // Update in place: dedup must prevent duplicate bubbles, NOT freeze stale
    // content. If an earlier tool_use emit carried partial/empty input and a
    // later emit has the full plan, the bubble needs to reflect the latest.
    // Preserve the original messageId so React keeps the same bubble identity.
    const existing = turn.segments[existingIdx];
    if (existing.type !== 'plan') return assistantTurns;
    if (
      existing.content === plan &&
      existing.planFilePath === planFilePath &&
      existing.allowedPrompts === toolInput.allowedPrompts
    ) {
      return assistantTurns;
    }
    const updatedSeg: AssistantTurnSegment = {
      ...existing,
      content: plan,
      planFilePath,
      allowedPrompts: toolInput.allowedPrompts,
    };
    newSegments = [
      ...turn.segments.slice(0, existingIdx),
      updatedSeg,
      ...turn.segments.slice(existingIdx + 1),
    ];
  } else {
    const planSeg: AssistantTurnSegment = {
      type: 'plan',
      messageId: nextMessageId(),
      toolUseId,
      content: plan,
      planFilePath,
      allowedPrompts: toolInput.allowedPrompts,
    };
    if (beforeGroupId) {
      const idx = turn.segments.findIndex(
        (s) => s.type === 'tool-group' && s.groupId === beforeGroupId,
      );
      newSegments = idx >= 0
        ? [...turn.segments.slice(0, idx), planSeg, ...turn.segments.slice(idx)]
        : [...turn.segments, planSeg];
    } else {
      newSegments = [...turn.segments, planSeg];
    }
  }
  const updated = new Map(assistantTurns);
  updated.set(currentTurnId, { ...turn, segments: newSegments });
  return updated;
}

/**
 * Shared cleanup for turn endings (both normal completion and timeout).
 * Marks orphaned running/awaiting tools as failed and clears turn tracking.
 *
 * `errorMessage` lets turn-ending paths attribute the failure accurately.
 * Interrupt path (TRANSCRIPT_INTERRUPT) passes 'Turn interrupted' so the
 * tool card distinguishes user-cancelled from normal turn completion; the
 * default 'Turn ended' preserves behavior for TRANSCRIPT_TURN_COMPLETE
 * and SESSION_PROCESS_EXITED.
 */
function endTurn(
  session: SessionChatState,
  errorMessage: string = 'Turn ended',
): Partial<SessionChatState> {
  const toolCalls = new Map(session.toolCalls);
  for (const id of session.activeTurnToolIds) {
    const tool = toolCalls.get(id);
    if (tool && (tool.status === 'running' || tool.status === 'awaiting-approval')) {
      toolCalls.set(id, { ...tool, status: 'failed', error: errorMessage });
    }
  }
  return {
    toolCalls,
    isThinking: false,
    streamingText: '',
    currentGroupId: null,
    currentTurnId: null,
    activeTurnToolIds: new Set(),
    // Clean slate on turn end. SESSION_PROCESS_EXITED sets 'session-died'
    // and NATIVE_SESSION_ERROR sets 'error' + errorMessage AFTER spreading
    // endTurn() so they override these resets.
    attentionState: 'ok' as const,
    errorMessage: null,
    // Any turn end also dismisses a pending stall countdown (the give-up path
    // ends the turn via NATIVE_SESSION_ERROR, which spreads endTurn()).
    stallWarning: null,
  };
}

/**
 * Route a subagent-originated transcript event into the parent Agent
 * tool's `subagentSegments`. Returns the original state when the parent
 * tool is missing (the subagent event arrived before the parent tool_use
 * was dispatched — reducer bails; next event will succeed).
 */
function applySubagentEvent(state: ChatState, action: ChatAction): ChatState {
  if (action.type !== 'TRANSCRIPT_TOOL_USE'
      && action.type !== 'TRANSCRIPT_TOOL_RESULT'
      && action.type !== 'TRANSCRIPT_ASSISTANT_TEXT') {
    return state;
  }
  const parentId = (action as any).parentAgentToolUseId as string | undefined;
  if (!parentId) return state;

  const session = state.get(action.sessionId);
  if (!session) return state;
  const parent = session.toolCalls.get(parentId);
  if (!parent) return state;

  const segments: SubagentSegment[] = parent.subagentSegments ? [...parent.subagentSegments] : [];

  if (action.type === 'TRANSCRIPT_ASSISTANT_TEXT') {
    segments.push({
      type: 'text',
      id: `sa-text-${action.uuid}`,
      content: action.text,
    });
  } else if (action.type === 'TRANSCRIPT_TOOL_USE') {
    const existingIdx = segments.findIndex(
      s => s.type === 'tool' && s.toolUseId === action.toolUseId,
    );
    const next: SubagentSegment = {
      type: 'tool',
      id: `sa-tool-${action.toolUseId}`,
      toolUseId: action.toolUseId,
      toolName: action.toolName,
      input: action.toolInput,
      status: 'running',
    };
    if (existingIdx >= 0) {
      // Duplicate tool_use emit — JSONL FIFO order guarantees the
      // tool_result hasn't been emitted yet, so overwriting back to
      // 'running' is safe and keeps the segment's input fresh.
      segments[existingIdx] = next;
    } else {
      segments.push(next);
    }
  } else if (action.type === 'TRANSCRIPT_TOOL_RESULT') {
    const idx = segments.findIndex(
      s => s.type === 'tool' && s.toolUseId === action.toolUseId,
    );
    if (idx >= 0 && segments[idx].type === 'tool') {
      const existing = segments[idx] as Extract<SubagentSegment, { type: 'tool' }>;
      segments[idx] = action.isError
        ? { ...existing, status: 'failed', error: action.result }
        : {
            ...existing,
            status: 'complete',
            response: action.result,
            ...(action.structuredPatch ? { structuredPatch: action.structuredPatch } : {}),
          };
    }
  }

  const toolCalls = new Map(session.toolCalls);
  const updated: ToolCallState = { ...parent, subagentSegments: segments };
  toolCalls.set(parentId, updated);
  const next = new Map(state);
  next.set(action.sessionId, { ...session, toolCalls });
  return next;
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  const next = new Map(state);

  switch (action.type) {
    case 'RESET': {
      return new Map();
    }

    case 'HYDRATE_CHAT_STATE': {
      // Fix: an empty snapshot is what the host sends when its renderer times
      // out (chat-snapshot.ts TIMEOUT_MS) or serialization throws — NOT a
      // signal that there are no sessions. Applying it blanked a reconnecting
      // client's entire chat with no error surfaced. Never replace real state
      // with nothing.
      if (action.sessions.sessions.length === 0) {
        console.warn('[chat-reducer] ignoring empty chat:hydrate snapshot');
        return state;
      }
      try {
        // Replace the entire ChatState with a deserialized snapshot from the
        // desktop renderer. Fired once per remote-access connect so browser
        // clients see the full chat history immediately instead of rebuilding
        // it from replayed transcript events.
        return deserializeChatState(action.sessions);
      } catch (err) {
        console.error('[chat-reducer] HYDRATE_CHAT_STATE deserialize failed:', err);
        return state;
      }
    }

    case 'SESSION_INIT': {
      if (!next.has(action.sessionId)) {
        next.set(action.sessionId, createSessionChatState());
      }
      return next;
    }

    case 'SESSION_REMOVE': {
      next.delete(action.sessionId);
      return next;
    }

    case 'USER_PROMPT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // ALWAYS append a pending bubble — no content-based dedup. The prior
      // last-10-entries content match silently dropped legitimate rapid-fire
      // duplicates (e.g. "yes" twice within five turns). TRANSCRIPT_USER_MESSAGE
      // confirms this entry by finding the oldest matching pending and
      // clearing its flag.
      const message = {
        id: nextMessageId(),
        role: 'user' as const,
        content: action.content,
        timestamp: action.timestamp,
        // Exact attachment paths (when provided) so the bubble can pill them
        // even when a path contains spaces. Content stays the space-joined
        // string — the transcript dedup matches on content, don't change it.
        ...(action.attachments?.length ? { attachments: action.attachments } : {}),
      };

      // Task 12: the queued-send branch that used to live here (append a
      // pending+queued bubble without touching turn state) is gone — a
      // queued native send now dispatches QUEUED_MESSAGE_ADDED instead of
      // USER_PROMPT (see InputBar.tsx), which never touches the timeline at
      // all. USER_PROMPT is unconditionally the 'sent' path again.
      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'user', message, pending: true }],
        isThinking: true,
        currentGroupId: null,
        currentTurnId: null,
        // Typing again after a provider error is the retry — clear the banner
        // (attentionState + errorMessage) so a fresh turn starts clean.
        attentionState: 'ok',
        errorMessage: null,
        stallWarning: null,
      });
      return next;
    }

    // Task 12: native send acked 'queued' — add to the docked-strip list.
    // Deliberately does NOT touch the timeline or turn/group/isThinking state
    // (that was the Task 3/11 bug: an enqueue-time timeline bubble froze
    // above content the still-streaming prior turn hadn't emitted yet).
    case 'QUEUED_MESSAGE_ADDED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        queuedMessages: [
          ...session.queuedMessages,
          { queueId: action.queueId, content: action.content, timestamp: action.timestamp },
        ],
      });
      return next;
    }

    // Task 12 (replaces QUEUED_PROMPT_CANCELED): removes a queuedMessages
    // entry by queueId. Dispatched by the strip's Cancel/Edit handlers on
    // BOTH native:queue-remove outcomes (see App.tsx) — success (the row is
    // genuinely gone) and too-late (the row's counterpart is about to land,
    // or already has landed, in the timeline via TRANSCRIPT_USER_MESSAGE's
    // drain-side removal below, so removing it here too is a harmless
    // possible-no-op that guarantees the strip row doesn't linger). No-op
    // (not an error) when the id isn't found.
    case 'QUEUED_MESSAGE_REMOVED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      const idx = session.queuedMessages.findIndex((q) => q.queueId === action.queueId);
      if (idx === -1) return state;
      const queuedMessages = [
        ...session.queuedMessages.slice(0, idx),
        ...session.queuedMessages.slice(idx + 1),
      ];
      next.set(action.sessionId, { ...session, queuedMessages });
      return next;
    }

    case 'SHOW_PROMPT': {
      let session = next.get(action.sessionId);
      if (!session) {
        session = createSessionChatState();
        next.set(action.sessionId, session);
      }

      const timeline = session.timeline.filter(
        (e) => !(e.kind === 'prompt' && e.prompt.promptId === action.promptId),
      );
      timeline.push({
        kind: 'prompt',
        prompt: {
          promptId: action.promptId,
          title: action.title,
          description: action.description,
          buttons: action.buttons,
        },
      });

      next.set(action.sessionId, { ...session, timeline });
      return next;
    }

    case 'COMPLETE_PROMPT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const timeline = session.timeline.map((e) => {
        if (e.kind === 'prompt' && e.prompt.promptId === action.promptId) {
          return { ...e, prompt: { ...e.prompt, completed: action.selection } };
        }
        return e;
      });

      next.set(action.sessionId, { ...session, timeline });
      return next;
    }

    case 'DISMISS_PROMPT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const timeline = session.timeline.filter(
        (e) => !(e.kind === 'prompt' && e.prompt.promptId === action.promptId && !e.prompt.completed),
      );

      next.set(action.sessionId, { ...session, timeline });
      return next;
    }

    // Process exited — if the session was still working (in-flight tools OR
    // isThinking) OR exited nonzero, surface this as 'session-died'. Clean
    // exits during idle are no-ops (we don't want a banner when the user
    // intentionally closes a quiet session).
    case 'SESSION_PROCESS_EXITED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      const hadInFlight = session.isThinking || session.activeTurnToolIds.size > 0;
      if (action.exitCode === 0 && !hadInFlight) return state;
      next.set(action.sessionId, {
        ...session,
        ...endTurn(session),
        // Override endTurn's 'ok' reset — this is the state we want to surface.
        attentionState: 'session-died',
      });
      return next;
    }

    // Native runtime: a provider/stream failure ended the turn. endTurn()
    // resets attentionState to 'ok' and clears errorMessage; we override with
    // 'error' + the message AFTER the spread — same spread-then-override
    // pattern SESSION_PROCESS_EXITED uses for 'session-died'.
    case 'NATIVE_SESSION_ERROR': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        ...endTurn(session, action.message),
        attentionState: 'error',
        errorMessage: action.message,
      });
      return next;
    }

    // Native model residency changed (loaded/loading/sleeping/unloaded). Purely
    // informational — does NOT touch the turn/attention machinery. Drives the
    // ModelLoadingBar (unloaded → reload; loading → loading indicator).
    case 'NATIVE_MODEL_STATE_CHANGED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      const loadedBytes = action.loadedBytes ?? null;
      // Latches true the first time the model reaches 'loaded'. The Reload prompt
      // keys on this so a fresh session's initial 'unloaded'/'loading' (before its
      // eager load completes) shows the loading bar, not a spurious Reload button.
      const everResident = session.modelEverResident || action.state === 'loaded';
      // No-op unless state, model, load-progress bytes, OR the ever-resident latch
      // changed (bytes climb while state stays 'loading', and must re-render).
      if (session.modelState === action.state
          && session.modelInfo?.modelId === action.modelId
          && session.modelLoadedBytes === loadedBytes
          && session.modelEverResident === everResident) return state;
      next.set(action.sessionId, {
        ...session,
        modelState: action.state,
        modelInfo: { modelId: action.modelId, sizeBytes: action.sizeBytes },
        modelLoadedBytes: loadedBytes,
        modelEverResident: everResident,
      });
      return next;
    }

    // Plan 2b: another device took over this session's lease. See the inline
    // comment below — as of the "Moved Gate" follow-up this only ends the turn
    // cleanly; the user-facing surface moved to App.tsx's MovedGate.
    case 'SESSION_MOVED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      // Plan 2b "Moved Gate" (2026-07-14): SESSION_MOVED now ONLY ends the
      // in-flight turn cleanly (endTurn — attention resets to 'ok', NOT a
      // terminal error). It NO LONGER appends a timeline marker: the holder side
      // destroys the session immediately after (SESSION_REMOVE wipes the whole
      // chat state, so any appended marker was deleted back-to-back and never
      // rendered). The user-facing "this session was taken over on <device>"
      // surface is now App.tsx's MovedGate (a full-page gate over the session),
      // driven off the enriched session:moved push — not this reducer.
      next.set(action.sessionId, { ...session, ...endTurn(session) });
      return next;
    }

    // Pure state write from the classifier driver hook. Gated by the hook
    // itself (only dispatches when mapped state differs), so no guard needed.
    case 'ATTENTION_STATE_CHANGED': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      if (session.attentionState === action.state) return state;
      next.set(action.sessionId, { ...session, attentionState: action.state });
      return next;
    }

    // Thinking blocks are genuine activity — bump lastActivityAt and clear
    // any stale attention state back to 'ok'. No timeline change.
    // A heartbeat carrying a `stallWarning` is the native watchdog firing: it
    // SETS the countdown. A plain heartbeat means activity resumed → clears it.
    case 'TRANSCRIPT_THINKING_HEARTBEAT': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        lastActivityAt: Date.now(),
        attentionState: 'ok',
        stallWarning: action.stallWarning ?? null,
        // Same lifetime rule as stallWarning: present on the announcing heartbeat,
        // cleared by the next plain one (which the first real chunk triggers).
        promptProcessing: action.promptProcessing ?? null,
      });
      return next;
    }

    // --- Transcript watcher actions ---

    case 'TRANSCRIPT_USER_MESSAGE': {
      // Subagent briefing: Claude Code writes the parent's Task prompt as the
      // first user-role line of the subagent's JSONL. The SubagentWatcher
      // stamps those events with parentAgentToolUseId. Drop them here — the
      // briefing is already visible in the parent Agent card's Briefing
      // section, so appending it to the main timeline created a duplicate
      // "message sent by the user" bubble. Mirrors the guard that
      // TRANSCRIPT_ASSISTANT_TEXT / TOOL_USE / TOOL_RESULT already have.
      if (action.parentAgentToolUseId) return state;
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Replay/live dedup: a renderer-crash reload replays this session's
      // transcript from disk while live events still arrive. If this uuid was
      // already applied, drop it — otherwise it appends a duplicate bubble
      // (there is no pending match on the second delivery). See seenUuids.
      if (action.uuid && session.seenUuids.has(action.uuid)) return state;
      const seenUuids = action.uuid
        ? new Set(session.seenUuids).add(action.uuid)
        : session.seenUuids;

      // Task 12 (drain-side removal): independent of whether a pending
      // TIMELINE bubble matches below — clear the OLDEST queuedMessages entry
      // with matching content, if any. WHY independent rather than gated on
      // confirmedIdx: a `sent` message never wrote a queuedMessages entry (no
      // QUEUED_MESSAGE_ADDED fired for it), so this scan simply finds nothing
      // and is a no-op on that path — running it unconditionally is correct,
      // not "unconditionally-but-harmless-because-usually-empty." A `queued`
      // message, symmetrically, never has a pending bubble to match (Task 12
      // stopped writing one), so it can ONLY be found here, never in the
      // confirmedIdx scan — that's what makes the no-pending-match fallback
      // below the sole place a queued message's timeline entry gets created,
      // at its true (end-of-timeline) position. Oldest-content-match mirrors
      // the pending-bubble dedup's own discipline (rapid-fire duplicates).
      //
      // Caveat (review finding, traced all orderings): "the two scans never
      // collide" only holds when contents are DISTINCT across the pending
      // bubble and the queued list. If the SAME text was both sent immediately
      // (a pending bubble) AND separately queued (a list entry) — e.g. "hi"
      // typed twice in a row, once while idle and once while a turn was
      // in-flight — this dispatch's list scan runs unconditionally regardless
      // of WHICH of the two "hi"s this particular transcript event confirms.
      // If it confirms the sent one, the list scan still removes the oldest
      // queued "hi" row from the STRIP even though that queued message's own
      // drain event hasn't arrived on the host yet. The eventual TIMELINE
      // outcome is still correct — that queued message still gets its own
      // TRANSCRIPT_USER_MESSAGE later, finds no pending bubble (already
      // consumed), and appends at the true end-of-timeline position via the
      // fallback below, same as always. The only visible effect is a
      // duplicate-content STRIP ROW disappearing one drain early (an
      // under-count for the span between the two events, not a lost or
      // mis-positioned message) — an acceptable renderer-local display quirk
      // for a scenario the old bubble-badge design had no better answer for
      // either (two identical bubbles were already visually indistinguishable
      // there too).
      let queuedMessages = session.queuedMessages;
      const queuedIdx = queuedMessages.findIndex((q) => q.content === action.text);
      if (queuedIdx !== -1) {
        queuedMessages = [
          ...queuedMessages.slice(0, queuedIdx),
          ...queuedMessages.slice(queuedIdx + 1),
        ];
      }

      // Find the OLDEST pending entry with matching content and confirm it
      // (clear the `pending` flag). This replaces the old last-10-entries
      // content-match dedup, which suppressed legitimate rapid-fire repeats.
      // Oldest-first so two identical optimistic bubbles get confirmed by two
      // transcript events in order.
      let confirmedIdx = -1;
      for (let i = 0; i < session.timeline.length; i++) {
        const entry = session.timeline[i];
        if (
          entry.kind === 'user' &&
          entry.pending === true &&
          entry.message.content === action.text
        ) {
          confirmedIdx = i;
          break;
        }
      }

      if (confirmedIdx >= 0) {
        const entry = session.timeline[confirmedIdx];
        if (entry.kind !== 'user') return state; // type-narrowing safety
        // Confirming clears `pending`. Rebuilt object (rather than spreading
        // entry) so any stale extra field is dropped, not carried forward —
        // this arm only ever matches a `sent`-path bubble (Task 12: a queued
        // send no longer writes one at all), so in practice there's nothing
        // stale to drop today, but the rebuild-not-spread discipline stays.
        const confirmed: TimelineEntry = {
          kind: 'user',
          message: entry.message,
          pending: false,
        };
        const timeline = [
          ...session.timeline.slice(0, confirmedIdx),
          confirmed,
          ...session.timeline.slice(confirmedIdx + 1),
        ];
        next.set(action.sessionId, {
          ...session,
          timeline,
          seenUuids,
          queuedMessages,
          isThinking: true,
          currentGroupId: null,
          currentTurnId: null,
          attentionState: 'ok',
        });
        return next;
      }

      // No pending match — a queued message being drained (Task 12's true-
      // position confirm: this is the ONLY place its timeline entry gets
      // created, at the end), a remote/replay client, or the user typed
      // directly into the terminal. Append as a new confirmed entry.
      const message = {
        id: nextMessageId(),
        role: 'user' as const,
        content: action.text,
        timestamp: action.timestamp,
      };

      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'user', message, pending: false }],
        seenUuids,
        queuedMessages,
        isThinking: true,
        currentGroupId: null,
        currentTurnId: null,
        // Fresh activity from the transcript → chat view is back in sync,
        // so any stale attention banner should disappear.
        attentionState: 'ok',
      });
      return next;
    }

    case 'TRANSCRIPT_ASSISTANT_TEXT': {
      // Subagent event: route into the parent Agent tool's nested timeline.
      if (action.parentAgentToolUseId) return applySubagentEvent(state, action);
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Replay/live dedup (see seenUuids): drop a text line already applied.
      // CC uuids are stable per line; native deltas each get a unique uuid, so
      // this only fires on a genuine replay/live overlap — never on distinct
      // streaming deltas (which merge by partId below).
      if (action.uuid && session.seenUuids.has(action.uuid)) return state;
      const seenUuids = action.uuid
        ? new Set(session.seenUuids).add(action.uuid)
        : session.seenUuids;

      const { assistantTurns, timeline, currentTurnId } = getOrCreateTurn(session);
      const turn = assistantTurns.get(currentTurnId)!;
      // Native runtime: same-partId deltas merge into the last text segment
      // (identical semantics to the reasoning path). No partId → CC's
      // whole-block append, unchanged.
      let segments = turn.segments;
      const lastIdx = segments.length - 1;
      const last = lastIdx >= 0 ? segments[lastIdx] : null;
      if (action.partId && last && last.type === 'text' && last.partId === action.partId) {
        segments = [...segments.slice(0, lastIdx), { ...last, content: last.content + action.text }];
      } else {
        segments = [...segments, { type: 'text', content: action.text, messageId: nextMessageId(), partId: action.partId }];
      }
      // Task 2.4: Capture model on first text of the turn so the model pill is
      // visible while the turn is in-flight. `?? turn.model` preserves the
      // existing value when a later text chunk arrives without a model, so we
      // never clobber a previously-captured model with null.
      assistantTurns.set(currentTurnId, {
        ...turn,
        segments,
        model: action.model ?? turn.model,
      });

      next.set(action.sessionId, {
        ...session, assistantTurns, timeline, currentTurnId, seenUuids,
        currentGroupId: null, // next tool_use creates a new group
        lastActivityAt: Date.now(),
        // Visible OUTPUT arrived (not merely activity). The thinking indicator
        // suppresses itself while this is fresh — a filling bubble is already proof
        // the model is alive, so a spinner beside it is noise.
        lastOutputAt: Date.now(),
        attentionState: 'ok',
        // Real answer text resumed → dismiss any pending stall countdown.
        stallWarning: null,
      });
      return next;
    }

    // Streaming reasoning chunk with text payload. Reasoning arrives as
    // per-token deltas merged into one segment by partId — UNLIKE the
    // TRANSCRIPT_ASSISTANT_TEXT path, which appends each event as a whole
    // block in its own new segment.
    case 'TRANSCRIPT_ASSISTANT_REASONING': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const { assistantTurns, timeline, currentTurnId } = getOrCreateTurn(session);
      const turn = assistantTurns.get(currentTurnId)!;
      let segments = turn.segments;
      const lastIdx = segments.length - 1;
      const last = lastIdx >= 0 ? segments[lastIdx] : null;
      if (
        action.partId
        && last
        && last.type === 'reasoning'
        && last.partId === action.partId
      ) {
        const merged = { ...last, content: last.content + action.text };
        segments = [...segments.slice(0, lastIdx), merged];
      } else {
        segments = [
          ...segments,
          { type: 'reasoning', content: action.text, messageId: nextMessageId(), partId: action.partId },
        ];
      }
      assistantTurns.set(currentTurnId, { ...turn, segments });

      next.set(action.sessionId, {
        ...session, assistantTurns, timeline, currentTurnId,
        currentGroupId: null,
        lastActivityAt: Date.now(),
        // Visible OUTPUT arrived (not merely activity). The thinking indicator
        // suppresses itself while this is fresh — a filling bubble is already proof
        // the model is alive, so a spinner beside it is noise.
        lastOutputAt: Date.now(),
        attentionState: 'ok',
        // Real reasoning resumed → dismiss any pending stall countdown.
        stallWarning: null,
      });
      return next;
    }

    case 'TRANSCRIPT_TOOL_USE': {
      // Subagent event: route into the parent Agent tool's nested timeline.
      if (action.parentAgentToolUseId) return applySubagentEvent(state, action);
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);

      // Check for a synthetic permission entry (perm-*) that matches this tool.
      // When the hook arrives before the transcript, a synthetic entry is created
      // with awaiting-approval status. Replace it with the real tool, preserving
      // the permission state and group placement.
      let mergedSynthetic = false;
      for (const [synId, synTool] of toolCalls) {
        if (synId.startsWith('perm-') && synTool.toolName === action.toolName
            && synTool.status === 'awaiting-approval') {
          // Replace synthetic with real tool, preserving permission state
          toolCalls.delete(synId);
          toolCalls.set(action.toolUseId, {
            toolUseId: action.toolUseId,
            toolName: action.toolName,
            input: action.toolInput,
            status: synTool.status,
            requestId: synTool.requestId,
            permissionSuggestions: synTool.permissionSuggestions,
            denyListed: synTool.denyListed,
          });
          // Update the tool group to reference the real ID
          const toolGroups = new Map(session.toolGroups);
          for (const [gid, group] of toolGroups) {
            if (group.toolIds.includes(synId)) {
              toolGroups.set(gid, {
                ...group,
                toolIds: group.toolIds.map((id) => id === synId ? action.toolUseId : id),
              });
              break;
            }
          }
          const activeTurnToolIds = new Set(session.activeTurnToolIds);
          activeTurnToolIds.delete(synId);
          activeTurnToolIds.add(action.toolUseId);

          // For ExitPlanMode, surface the plan markdown as its own bubble.
          // The tool-group already exists (hook arrived first), so splice the
          // plan segment in before it rather than appending.
          let mergedTurns = session.assistantTurns;
          if (action.toolName === 'ExitPlanMode' && session.currentTurnId) {
            let targetGroupId: string | undefined;
            for (const [gid, group] of toolGroups) {
              if (group.toolIds.includes(action.toolUseId)) { targetGroupId = gid; break; }
            }
            mergedTurns = injectPlanSegment(
              session.assistantTurns,
              session.currentTurnId,
              action.toolUseId,
              action.toolInput,
              targetGroupId,
            );
          }

          next.set(action.sessionId, {
            ...session, toolCalls, toolGroups,
            assistantTurns: mergedTurns,
            activeTurnToolIds,
            lastActivityAt: Date.now(),
            attentionState: 'ok',
          });
          mergedSynthetic = true;
          break;
        }
      }
      if (mergedSynthetic) return next;

      toolCalls.set(action.toolUseId, {
        toolUseId: action.toolUseId,
        toolName: action.toolName,
        input: action.toolInput,
        status: 'running',
      });

      let { assistantTurns, timeline, currentTurnId } = getOrCreateTurn(session);
      const toolGroups = new Map(session.toolGroups);
      let currentGroupId = session.currentGroupId;

      // ExitPlanMode: inject plan markdown as its own bubble BEFORE the
      // tool-group, so the full plan is visible in chat view (not just the
      // approval buttons).
      if (action.toolName === 'ExitPlanMode') {
        assistantTurns = injectPlanSegment(
          assistantTurns,
          currentTurnId,
          action.toolUseId,
          action.toolInput,
        );
      }

      // Fix: group placement must be IDEMPOTENT. The watcher deliberately
      // re-emits tool-use on repeated uuids (CC rewrites the same JSONL line as
      // the assistant message grows, and a rewrite may carry NEW tool_use
      // blocks), relying on "the reducer dedupes by toolUseId" — true of the
      // toolCalls Map above, but the group append below used to add the id a
      // second time, rendering a duplicate ToolCard. Symptom was most visible
      // on AskUserQuestion: AssistantTurnBubble hides awaiting-approval tools
      // from groups, so both copies only became visible once answered.
      // See transcript-watcher.ts readNewLines (~line 679) for the emit contract.
      let existingGroupId: string | null = null;
      for (const [gid, group] of toolGroups) {
        if (group.toolIds.includes(action.toolUseId)) { existingGroupId = gid; break; }
      }

      if (existingGroupId) {
        // Already placed by an earlier emit of this same tool — leave both the
        // group and currentGroupId untouched, so a re-emit can't retarget where
        // subsequent NEW tools land. (injectPlanSegment above is already
        // idempotent by toolUseId, so ExitPlanMode needs no equivalent guard.)
      } else if (currentGroupId && toolGroups.has(currentGroupId)) {
        // Add to existing group (no new segment needed)
        const group = toolGroups.get(currentGroupId)!;
        toolGroups.set(currentGroupId, {
          ...group,
          toolIds: [...group.toolIds, action.toolUseId],
        });
      } else {
        // Create new group and add as segment to current turn
        currentGroupId = nextGroupId();
        toolGroups.set(currentGroupId, { id: currentGroupId, toolIds: [action.toolUseId] });

        const turn = assistantTurns.get(currentTurnId)!;
        assistantTurns.set(currentTurnId, {
          ...turn,
          segments: [...turn.segments, { type: 'tool-group', groupId: currentGroupId }],
        });
      }

      const activeTurnToolIds = new Set(session.activeTurnToolIds);
      activeTurnToolIds.add(action.toolUseId);
      next.set(action.sessionId, {
        ...session, toolCalls, toolGroups, assistantTurns, timeline,
        currentGroupId, currentTurnId,
        activeTurnToolIds,
        lastActivityAt: Date.now(),
        attentionState: 'ok',
      });
      return next;
    }

    case 'TRANSCRIPT_TOOL_RESULT': {
      // Subagent event: route into the parent Agent tool's nested timeline.
      if (action.parentAgentToolUseId) return applySubagentEvent(state, action);
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);
      const existing = toolCalls.get(action.toolUseId);
      if (existing) {
        // Carry structuredPatch onto the tool state so DiffView can render
        // with absolute file line numbers (Claude Code ships it pre-computed).
        const patch = action.structuredPatch;
        if (action.isError) {
          toolCalls.set(action.toolUseId, {
            ...existing, status: 'failed', error: action.result,
            ...(patch ? { structuredPatch: patch } : {}),
          });
        } else {
          toolCalls.set(action.toolUseId, {
            ...existing, status: 'complete', response: action.result,
            ...(patch ? { structuredPatch: patch } : {}),
          });
        }
      }

      next.set(action.sessionId, {
        ...session, toolCalls, lastActivityAt: Date.now(),
        attentionState: 'ok',
      });
      return next;
    }

    case 'TRANSCRIPT_TURN_COMPLETE': {
      // A sub-agent's end_turn must NOT reach into parent state. Without
      // this guard the parent turn's `model` gets overwritten with the
      // sub-agent's model (the status-bar pill silently flips, and the
      // drift-reconciliation effect in App.tsx persists it via
      // setPreference), and endTurn() prematurely tears down the parent's
      // in-flight turn — flagging the still-running Task tool as failed
      // and tripping the attention banner. Mirrors the same guard on
      // TRANSCRIPT_ASSISTANT_TEXT / TOOL_USE / TOOL_RESULT above. We don't
      // delegate to applySubagentEvent here because a sub-agent's end_turn
      // produces no visible nested segment — the parent's own tool-result
      // for the Task tool is what completes the agent in the UI.
      if (action.parentAgentToolUseId) return state;
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Attach completion metadata to the completing turn before clearing
      // turn-scoped state via endTurn(). currentTurnId is the in-flight turn;
      // if it's already null (edge case: turn-complete arrived before any
      // assistant text), skip metadata attachment but still call endTurn.
      const completingTurnId = session.currentTurnId;
      const assistantTurns = new Map(session.assistantTurns);
      if (completingTurnId) {
        const turn = assistantTurns.get(completingTurnId);
        if (turn) {
          assistantTurns.set(completingTurnId, {
            ...turn,
            stopReason: action.stopReason,
            // Preserve any model already captured on the turn (e.g. from
            // assistant-text in Task 2.4) — only override when the action
            // carries one. The two should agree when both are present.
            model: action.model ?? turn.model,
            anthropicRequestId: action.anthropicRequestId,
            usage: action.usage,
          });
        }
      }

      next.set(action.sessionId, { ...session, assistantTurns, ...endTurn(session) });
      return next;
    }

    case 'TRANSCRIPT_INTERRUPT': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // User interrupted (ESC or equivalent): mirror TRANSCRIPT_TURN_COMPLETE
      // but hardcode stopReason='interrupted' so the AssistantTurnBubble
      // footer renders "Interrupted" under the affected turn. Then endTurn()
      // clears turn-scoped state and flips in-flight tools in this turn to
      // failed with error 'Turn interrupted' (vs. 'Turn ended' for normal
      // completion) so the tool card distinguishes user-cancelled.
      const interruptingTurnId = session.currentTurnId;
      const assistantTurns = new Map(session.assistantTurns);
      if (interruptingTurnId) {
        const turn = assistantTurns.get(interruptingTurnId);
        if (turn) {
          assistantTurns.set(interruptingTurnId, {
            ...turn,
            stopReason: 'interrupted',
          });
        }
      }

      next.set(action.sessionId, {
        ...session,
        assistantTurns,
        ...endTurn(session, 'Turn interrupted'),
      });
      return next;
    }

    case 'PERMISSION_REQUEST': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Find the matching running tool. Match order, most → least specific:
      //   1. same name AND identical input — disambiguates parallel same-name
      //      tools (e.g. two Bash calls in one batch). Without it the approval
      //      card rendered tool A's input while its buttons approved tool B's
      //      command.
      //   2. first running tool with the same name (hook payload and
      //      transcript input shapes can differ — degrade safely)
      //   3. first running tool of any name
      // (An older requestId pass between 2 and 3 was unreachable — a running
      // tool never carries a requestId; PERMISSION_RESPONDED clears it.)
      const toolCalls = new Map(session.toolCalls);
      let inputMatchId: string | null = null;
      let nameMatchId: string | null = null;
      let anyRunningId: string | null = null;
      const wantedInput = action.input ? stableStringify(action.input) : null;
      for (const [id, tool] of toolCalls) {
        if (tool.status !== 'running') continue;
        if (anyRunningId === null) anyRunningId = id;
        if (tool.toolName === action.toolName) {
          if (nameMatchId === null) nameMatchId = id;
          if (wantedInput !== null && tool.input
              && stableStringify(tool.input) === wantedInput) {
            inputMatchId = id;
            break;
          }
        }
      }
      const targetId = inputMatchId ?? nameMatchId ?? anyRunningId;
      let found = false;
      if (targetId !== null) {
        const tool = toolCalls.get(targetId)!;
        toolCalls.set(targetId, {
          ...tool,
          status: 'awaiting-approval',
          requestId: action.requestId,
          permissionSuggestions: action.permissionSuggestions,
          denyListed: action.denyListed,
        });
        found = true;
      }

      if (!found) {
        // Fix: never synthesize a SECOND placeholder for a requestId we already
        // hold. The match loop above only considers 'running' tools, so a
        // re-delivered PERMISSION_REQUEST for a tool already flipped to
        // 'awaiting-approval' fell through to here and minted a duplicate card
        // (the synthetic merge in TRANSCRIPT_TOOL_USE reclaims only one of
        // them, orphaning the rest).
        for (const tool of toolCalls.values()) {
          if (tool.requestId === action.requestId) return state;
        }

        // Permission hook arrived before transcript watcher — create synthetic tool entry
        const syntheticId = `perm-${action.requestId}`;
        toolCalls.set(syntheticId, {
          toolUseId: syntheticId,
          toolName: action.toolName,
          input: action.input,
          status: 'awaiting-approval',
          requestId: action.requestId,
          permissionSuggestions: action.permissionSuggestions,
          denyListed: action.denyListed,
        });

        const groupId = nextGroupId();
        const toolGroups = new Map(session.toolGroups);
        toolGroups.set(groupId, { id: groupId, toolIds: [syntheticId] });

        // Place the synthetic tool group inside an assistant turn
        const filteredTimeline = session.timeline.filter(
          (e) => !(e.kind === 'prompt' && !e.prompt.completed),
        );
        const { assistantTurns, timeline, currentTurnId } = getOrCreateTurn({
          ...session, timeline: filteredTimeline,
        });
        const turn = assistantTurns.get(currentTurnId)!;
        assistantTurns.set(currentTurnId, {
          ...turn,
          segments: [...turn.segments, { type: 'tool-group', groupId }],
        });

        const activeTurnToolIds = new Set(session.activeTurnToolIds);
        activeTurnToolIds.add(syntheticId);
        next.set(action.sessionId, {
          ...session, toolCalls, toolGroups, assistantTurns,
          timeline, currentTurnId, activeTurnToolIds,
          // Chat already renders the approval card — classifier doesn't also need to warn.
          attentionState: 'ok',
        });
        return next;
      }

      // Dismiss any parser-detected PromptCards
      const timeline = session.timeline.filter(
        (e) => !(e.kind === 'prompt' && !e.prompt.completed),
      );

      next.set(action.sessionId, { ...session, toolCalls, timeline, attentionState: 'ok' });
      return next;
    }

    case 'PERMISSION_RESPONDED': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);
      for (const [id, tool] of toolCalls) {
        if (tool.status === 'awaiting-approval' && tool.requestId === action.requestId) {
          // Fix: native budget gates (max_steps / doom_loop) are synthetic asks
          // with NO real tool execution behind them — no TRANSCRIPT_TOOL_RESULT
          // ever arrives to close the card. Leaving it 'running' orphans it: a
          // same-turn re-trip of the gate matches it via PERMISSION_REQUEST's
          // tier-3 "first running tool of any name" fallback and reuses the stale
          // card, and endTurn() force-fails it 'Turn ended' on a normal finish.
          // Close it 'complete' on any response instead (PERMISSION_RESPONDED
          // can't tell Yes from No — it carries only the requestId). Keyed on
          // toolName, not the perm- id prefix, which would wrongly close real
          // tools whose hook merely beat the transcript.
          const isBudgetGate = tool.toolName === 'max_steps' || tool.toolName === 'doom_loop';
          toolCalls.set(id, { ...tool, status: isBudgetGate ? 'complete' : 'running', requestId: undefined });
          break;
        }
      }

      next.set(action.sessionId, { ...session, toolCalls });
      return next;
    }

    case 'PERMISSION_EXPIRED': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      const toolCalls = new Map(session.toolCalls);
      for (const [id, tool] of toolCalls) {
        if (tool.status === 'awaiting-approval' && tool.requestId === action.requestId) {
          toolCalls.set(id, {
            ...tool,
            status: 'failed',
            requestId: undefined,
            error: 'Permission request expired — socket closed before a response was sent',
          });
          break;
        }
      }

      next.set(action.sessionId, { ...session, toolCalls });
      return next;
    }

    case 'HISTORY_LOADED': {
      const session = next.get(action.sessionId);
      if (!session) return state;

      // Build timeline entries from historical messages
      const historyTimeline: TimelineEntry[] = [];
      const historyTurns = new Map(session.assistantTurns);
      let historyMsgCounter = 0;

      // Add "see previous messages" marker if there's more history
      if (action.hasMore) {
        historyTimeline.push({
          kind: 'prompt',
          prompt: {
            promptId: HISTORY_EXPAND_PROMPT_ID,
            title: 'See previous messages',
            buttons: [],
          },
        });
      }

      // When replacing history (hasMore=false), remove old history entries and expand button
      const existingTimeline = action.hasMore
        ? session.timeline
        : session.timeline.filter((e) => {
            if (e.kind === 'prompt' && e.prompt.promptId === HISTORY_EXPAND_PROMPT_ID) return false;
            if (e.kind === 'user' && e.message.id.startsWith('hist-')) return false;
            if (e.kind === 'assistant-turn' && e.turnId.startsWith('hist-')) return false;
            return true;
          });

      for (const msg of action.messages) {
        const id = `hist-${++historyMsgCounter}`;
        if (msg.role === 'user') {
          historyTimeline.push({
            kind: 'user',
            message: { id, role: 'user', content: msg.content, timestamp: msg.timestamp },
          });
        } else {
          const turnId = `hist-turn-${historyMsgCounter}`;
          const msgId = `hist-msg-${historyMsgCounter}`;
          // History-loaded turns never saw a turn-complete, so metadata fields stay null.
          historyTurns.set(turnId, {
            id: turnId,
            segments: [{ type: 'text', content: msg.content, messageId: msgId }],
            timestamp: msg.timestamp,
            stopReason: null,
            model: null,
            usage: null,
            anthropicRequestId: null,
          });
          historyTimeline.push({ kind: 'assistant-turn', turnId });
        }
      }

      // Prepend history before existing timeline
      next.set(action.sessionId, {
        ...session,
        timeline: [...historyTimeline, ...existingTimeline],
        assistantTurns: historyTurns,
      });
      return next;
    }

    // /cost and /usage — appends a point-in-time stats snapshot card to the timeline.
    // Permanent (not dismissible); reducer is write-only, UsageCard reads from snapshot.
    case 'SHOW_USAGE_CARD': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'usage-card', snapshot: action.snapshot }],
      });
      return next;
    }

    // /compact — inserts spinner card + sets pending flag. Claude Code does the
    // actual summarization via API; we detect completion via transcript shrink
    // OR next turn-complete (see COMPACTION_COMPLETE). Keep existing timeline —
    // the user should still see their messages during the 10-30s compaction.
    case 'COMPACTION_PENDING': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      // Idempotent: if already pending, just update the card (don't stack spinners)
      const filtered = session.timeline.filter((e) => e.kind !== 'compacting');
      const startedAt = Date.now();
      next.set(action.sessionId, {
        ...session,
        timeline: [...filtered, { kind: 'compacting', id: action.cardId, startedAt }],
        compactionPending: { startedAt, beforeContextTokens: action.beforeContextTokens },
      });
      return next;
    }

    // Compaction finished — remove the spinner, insert a marker, but KEEP
    // the pre-compaction timeline so the user can scroll back and read what
    // they discussed. Claude's actual context is now just the summary (which
    // arrives as a new assistant-turn via transcript events), but visually
    // showing the history matches how long chat threads feel elsewhere.
    // ChatView fades entries above the marker to hint they're "archived".
    // Invoked from two paths: transcript-shrink (typed /compact) and first
    // turn-complete after pending (resume-from-summary).
    case 'COMPACTION_COMPLETE': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      // Native auto-compaction (action.auto) has no compactionPending to satisfy —
      // it fired spontaneously, not from /compact — so it bypasses this guard. For
      // the manual/CC path the guard still drops stale/spurious events (notably CC
      // resume-from-summary, which must NOT insert a marker).
      if (!session.compactionPending && !action.auto) return state; // Stale event — ignore
      const before = session.compactionPending?.beforeContextTokens ?? null;
      const after = action.afterContextTokens;
      let label: string;
      if (action.aborted) {
        label = 'Compaction may have failed';
      } else if (before != null && after != null && before > after) {
        const freed = before - after;
        label = `Compacted · freed ${freed.toLocaleString()} tokens`;
      } else {
        label = 'Conversation compacted';
      }
      // Strip the compacting spinner card but preserve everything else.
      const preserved = session.timeline.filter((e) => e.kind !== 'compacting');
      next.set(action.sessionId, {
        ...session,
        ...endTurn(session),
        timeline: [
          ...preserved,
          {
            kind: 'system-marker',
            marker: {
              id: action.markerId,
              timestamp: Date.now(),
              label,
              variant: 'compact',
              // Attaches the CC-produced summary text so the otherwise-thin
              // marker can click-to-expand inline. Absent on aborted/watchdog
              // completions (no summary available).
              ...(action.summary ? { summary: action.summary } : {}),
            },
          },
        ],
        compactionPending: null,
      });
      return next;
    }

    // /copy picker — inserts a copy-picker card inline. Removed on click or cancel.
    case 'SHOW_COPY_PICKER': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        timeline: [...session.timeline, { kind: 'copy-picker', id: action.id, options: action.options }],
      });
      return next;
    }

    case 'DISMISS_COPY_PICKER': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        timeline: session.timeline.filter((e) => !(e.kind === 'copy-picker' && e.id === action.id)),
      });
      return next;
    }

    // /clear — wipes visible timeline, inserts a thin divider, resets turn state.
    // Claude Code's own context is reset separately by forwarding /clear to the PTY.
    // We preserve toolCalls/toolGroups Maps so any mid-flight results that arrive
    // after the clear (before the PTY-level reset takes effect) don't crash lookups.
    case 'CLEAR_TIMELINE': {
      const session = next.get(action.sessionId);
      if (!session) return state;
      next.set(action.sessionId, {
        ...session,
        ...endTurn(session),
        timeline: [
          {
            kind: 'system-marker',
            marker: {
              id: action.markerId,
              timestamp: action.timestamp,
              label: 'Conversation cleared',
              variant: 'clear',
            },
          },
        ],
      });
      return next;
    }

    default:
      return state;
  }
}
