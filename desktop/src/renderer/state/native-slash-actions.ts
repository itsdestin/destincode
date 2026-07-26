// Runs the slash commands that have a REAL native-runtime implementation.
//
// The dispatcher (slash-command-dispatcher.ts) stays provider-agnostic: it names
// an intent (`nativeAction`) and hands back a PTY string for the Claude Code
// path. This module is the other half — the harness transport — so the three
// call sites that consume a dispatcher result (InputBar, the command drawer, and
// the skill-prompt path in App) share ONE implementation instead of each growing
// their own provider branch.
//
// Why every branch reports something: before M3, choosing /compact in a native
// session went to `guardedPtySend`, which returns false and drops it on the
// floor — no toast, no error, nothing. Replacing those silent dead ends is the
// point of this milestone, so every outcome here either succeeds or explains
// itself.
import type React from 'react';
import type { ChatAction } from './chat-types';
import type { NativeSlashAction } from './slash-command-dispatcher';

/** User-facing copy per refusal reason. Specific and accurate — never a guessed
 *  cause (docs/error-message-standards.md). Keys mirror NativeSessionHost.compact
 *  and HarnessSession.compactNow. */
const COMPACT_REFUSAL: Record<string, string> = {
  'turn-in-flight':
    "Can't compact while Claude is still working. Stop the current turn (or wait for it to finish) and try again.",
  'nothing-to-compact':
    'Nothing to compact yet — there needs to be at least a couple of exchanges before there’s anything to summarize.',
  // Deliberately NOT phrased as a total failure: compactNow prunes BEFORE it
  // summarizes and keeps the pruned history on a summary failure, so the user
  // really did get some space back.
  'summary-failed':
    'The model couldn’t write a usable summary, so the conversation was left intact. Older tool output was still trimmed, which frees some space.',
  'not-live': "This session isn't running, so there's nothing to compact.",
};

export interface NativeActionDeps {
  sessionId: string;
  dispatch: React.Dispatch<ChatAction>;
  onToast?: (message: string) => void;
}

/**
 * Execute a native-runtime slash action. Never throws — a rejected IPC call is
 * reported like any other refusal.
 *
 * Returns true when the action actually did something, so callers can decide
 * whether to treat it as handled.
 */
export async function runNativeSlashAction(
  action: NativeSlashAction,
  { sessionId, dispatch, onToast }: NativeActionDeps,
): Promise<boolean> {
  if (action === 'clear') return runNativeClear({ sessionId, onToast });
  if (action !== 'compact') return false;

  let result: { ok: true } | { ok: false; reason: string; detail?: string };
  try {
    result = await window.claude.native.compact(sessionId);
  } catch (err: any) {
    // Surface the REAL error text rather than inventing a cause.
    result = { ok: false, reason: 'error', detail: err?.message ?? String(err) };
  }

  if (result.ok) {
    // The harness emits `compact-summary` on success, and the transcript-event
    // path turns that into COMPACTION_COMPLETE — which is what clears the
    // spinner and writes the marker. Nothing to dispatch here; dispatching our
    // own COMPACTION_COMPLETE would race that one and double-insert the marker.
    return true;
  }

  // Clear the spinner the dispatcher optimistically raised (COMPACTION_PENDING),
  // otherwise a refused compaction leaves a card spinning forever.
  dispatch({
    type: 'COMPACTION_COMPLETE',
    sessionId,
    markerId: `compact-failed-${Date.now()}`,
    afterContextTokens: null,
    aborted: true,
  });

  const known = COMPACT_REFUSAL[result.reason];
  onToast?.(
    known ??
      // Unknown reason: pass the real detail through when we have one, and stay
      // non-committal when we don't, rather than asserting a cause.
      (result.detail ? `Couldn't compact: ${result.detail}` : "Couldn't compact this conversation."),
  );
  return false;
}

/** Copy for a refused /clear. Same discipline as COMPACT_REFUSAL above. */
const CLEAR_REFUSAL: Record<string, string> = {
  'turn-in-flight':
    "Can't clear while Claude is still working. Stop the current turn (or wait for it to finish) and try again.",
  'not-live': "This session isn't running, so there's nothing to clear.",
};

/**
 * /clear for a native session — a context BARRIER, not a deletion.
 *
 * The dispatcher has ALREADY dispatched CLEAR_TIMELINE optimistically, which is
 * what the user sees. This drives the durable half: the harness drops the
 * model's in-memory history and appends a `context-clear` marker so a resume
 * rebuilds from the barrier forward. The append-only log keeps every line, so
 * the conversation stays fully readable — only the model's memory resets.
 *
 * Nothing to undo on refusal: for a native session the dispatcher SKIPS its
 * optimistic CLEAR_TIMELINE (see `deferUiEffectsToRuntime`), because the visible
 * timeline can't be restored once cleared — `seenUuids` survives the clear, so a
 * transcript replay would be deduped away to nothing. Instead the UI clears only
 * when the durable `context-clear` event comes back, which means a refused clear
 * leaves the conversation exactly as it was.
 */
async function runNativeClear({ sessionId, onToast }: Omit<NativeActionDeps, 'dispatch'>): Promise<boolean> {
  let result: { ok: true } | { ok: false; reason: string; detail?: string };
  try {
    result = await window.claude.native.clear(sessionId);
  } catch (err: any) {
    result = { ok: false, reason: 'error', detail: err?.message ?? String(err) };
  }

  if (result.ok) return true;

  const known = CLEAR_REFUSAL[result.reason];
  onToast?.(
    known ??
      (result.detail ? `Couldn't clear: ${result.detail}` : "Couldn't clear this conversation."),
  );
  return false;
}
