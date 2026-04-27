import { useCallback, useEffect, useRef } from 'react';
import { useChatStateMap } from '../state/chat-context';

// First-attempt retry threshold. After this long with the optimistic bubble
// still in pending state, if the session is observably idle, we send a
// follow-up '\r' to nudge submission. Sized against two observed CC delays:
//
// 1) Spinner-render latency: in test-conpty harness traces (CC v2.1.119, cold
//    session), 7-8s elapsed between an input write and "Forming…" appearing.
//    Production warm-cache sessions are presumably faster but not zero.
// 2) JSONL flush latency: CC writes the user-message entry to the transcript
//    JSONL only after the assistant turn has begun streaming, not on submit.
//    On a slow first token (cold prompt cache, network hiccup, long context),
//    `pending` can legitimately stay set for 5+ s on a successful send.
//
// 8s is a compromise: long enough to outlast typical first-token delay while
// staying short enough to feel responsive when recovery IS needed. The idle
// gate (attentionState === 'ok') ensures we don't fire while a spinner is
// visible, which catches most slow-first-token false positives even within
// the 8s window. Race window remains: a successful submit whose spinner
// hasn't rendered yet AND whose attentionState is still 'ok' at 8s would
// trigger a spurious bare-\r that submits an empty message. Acceptable
// given CC ignores empty input bar submits.
const RETRY_DELAY_MS = 8000;

// When the retry timer fires but Claude is still busy, recheck after this
// shorter delay. The idle gate is what avoids double-submitting while
// Claude's own pending-message queue is still draining.
const RECHECK_DELAY_MS = 1000;

interface TrackedSubmit {
  sessionId: string;
  retried: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Recovers chat→PTY submits that didn't reach Claude.
 *
 * On Windows ConPTY, when Claude is busy rendering, the worker's 600ms gap
 * between body and `\r` writes can collapse — both bytes arrive at Claude in
 * the same kernel read, Ink treats `\r` as paste content (literal newline)
 * instead of a submit keystroke, and the message sits in Claude's input bar
 * without submitting. See
 * docs/superpowers/investigations/2026-04-24-chat-to-pty-submit-reliability.md
 * for the full mechanism + why every worker-side protocol fix was ruled out.
 *
 * Strategy: don't try to prevent the failure (we can't, from the worker side).
 * Detect it. The optimistic bubble's `pending` flag is the authoritative
 * "did Claude actually receive this" signal — TRANSCRIPT_USER_MESSAGE clears
 * it on success. If the flag stays set and Claude is observably idle, the
 * submit was lost; send a single `\r` (body bytes are already in Claude's
 * input bar from the failed first attempt) to trigger submission.
 *
 * Idle gate (attentionState === 'ok' && !isThinking) is what prevents
 * double-submits while Claude's own queue is still draining — only retry
 * when Claude is observably available to read input.
 */
export function useSubmitConfirmation() {
  const chatState = useChatStateMap();
  // stateRef so the timer callback always reads the latest state, not the
  // snapshot from when the timer was scheduled.
  const stateRef = useRef(chatState);
  stateRef.current = chatState;

  const trackedRef = useRef<Map<string, TrackedSubmit>>(new Map());

  const attemptRetry = useCallback((messageId: string) => {
    const tracked = trackedRef.current;
    const info = tracked.get(messageId);
    if (!info) return;

    const session = stateRef.current.get(info.sessionId);
    if (!session) {
      tracked.delete(messageId);
      return;
    }

    const stillPending = session.timeline.some(
      (e) => e.kind === 'user' && e.message.id === messageId && e.pending,
    );
    if (!stillPending) {
      tracked.delete(messageId);
      return;
    }

    // Idle gate: only `attentionState === 'ok'` (no spinner visible). We do
    // NOT also require `!isThinking`, even though that looks like the obvious
    // belt-and-suspenders check: `isThinking` is set true on USER_PROMPT and
    // is only cleared by endTurn() (TRANSCRIPT_TURN_COMPLETE / interrupt /
    // session exit). In the bug state we're trying to recover from, CC never
    // received the message, so endTurn() never fires — `isThinking` stays
    // true forever, and gating on `!isThinking` would make the retry never
    // trigger in the very case it exists for.
    //
    // attentionState is the right signal: classifier-driven from the PTY
    // buffer, flips to a thinking-* state within ~1-2s of CC's spinner
    // appearing, and back to 'ok' when there's no spinner. After 5s without
    // a spinner, CC has either already finished (pending was cleared) or
    // never received the message — both safe to act on.
    const idle = session.attentionState === 'ok';
    if (!idle) {
      // CC is observably busy (spinner visible, possibly draining its own
      // queue). Don't retry yet; recheck shortly. By the time the spinner
      // clears, TRANSCRIPT_USER_MESSAGE will likely have cleared `pending`
      // already and the early-return above will fire.
      info.timer = setTimeout(() => attemptRetry(messageId), RECHECK_DELAY_MS);
      return;
    }

    if (info.retried) {
      // Already retried once and still no transcript confirmation. Stop.
      // Bubble stays pending (matches pre-fix behavior). A future iteration
      // could mark this 'failed' in the UI with a manual retry button.
      tracked.delete(messageId);
      return;
    }

    // Bare 1-byte write — pty-worker's case 'input' branches `length > 1 &&
    // endsWith('\r')` skip; this lands in the passthrough `else` and reaches
    // ConPTY as a single byte. With nothing else queued ahead of it, it
    // arrives at Claude as a clean keystroke instead of paste content.
    window.claude.session.sendInput(info.sessionId, '\r');
    info.retried = true;
    info.timer = setTimeout(() => attemptRetry(messageId), RETRY_DELAY_MS);
  }, []);

  // Track new pending bubbles; clean up confirmed/removed ones.
  useEffect(() => {
    const tracked = trackedRef.current;
    const seen = new Set<string>();

    for (const [sessionId, session] of chatState) {
      for (const entry of session.timeline) {
        if (entry.kind !== 'user' || !entry.pending) continue;
        const messageId = entry.message.id;
        seen.add(messageId);
        if (tracked.has(messageId)) continue;
        tracked.set(messageId, {
          sessionId,
          retried: false,
          timer: setTimeout(() => attemptRetry(messageId), RETRY_DELAY_MS),
        });
      }
    }

    for (const [id, info] of tracked) {
      if (!seen.has(id)) {
        clearTimeout(info.timer);
        tracked.delete(id);
      }
    }
  }, [chatState, attemptRetry]);

  // Clear all timers on unmount only — empty deps so this cleanup doesn't
  // fire on every chatState change (which would defeat the purpose).
  useEffect(
    () => () => {
      for (const info of trackedRef.current.values()) clearTimeout(info.timer);
      trackedRef.current.clear();
    },
    [],
  );
}
