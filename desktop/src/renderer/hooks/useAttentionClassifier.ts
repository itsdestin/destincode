import { useEffect, useRef } from 'react';
import { useChatDispatch } from '../state/chat-context';
import { getScreenText } from './terminal-registry';
import {
  classifyBuffer,
  BufferClass,
  ClassifierContext,
} from '../state/attention-classifier';
import type { AttentionState } from '../state/chat-types';

// How often the classifier re-reads the buffer while active.
const TICK_MS = 1000;

// A non-ok classification must hold for this many consecutive ticks before we
// dispatch. Suppresses transient false positives during spinner-render gaps.
const STABILITY_TICKS = 5;

interface HookArgs {
  /** isThinking from reducer — gates the whole classifier. */
  isThinking: boolean;
  /** Don't classify while a tool is running (Claude is busy, not stuck). */
  hasRunningTools: boolean;
  /** Don't classify while awaiting approval (user is the blocker). */
  hasAwaitingApproval: boolean;
  /** Chat view must be visible (no point classifying a hidden view). */
  visible: boolean;
  /** Current reducer attentionState — used for dispatch-suppression. */
  currentAttentionState: AttentionState;
}

function bufferClassToAttention(cls: BufferClass): AttentionState {
  // Classifier now only distinguishes spinner states. Anything else ('unknown')
  // maps to 'ok' — we don't trust content-based heuristics to flag attention.
  // See attention-classifier.ts header for why.
  switch (cls) {
    case 'thinking-stalled':
      return 'stuck';
    case 'thinking-active':
    case 'unknown':
      return 'ok';
  }
}

/**
 * Periodically classify the PTY buffer and dispatch ATTENTION_STATE_CHANGED
 * when the mapped state differs from the current reducer state.
 *
 * Replaces the legacy 30s thinkingTimedOut watchdog. See docs/chat-reducer.md
 * "Attention classifier" and src/renderer/state/attention-classifier.ts for
 * the signal-to-state mapping.
 */
export function useAttentionClassifier(sessionId: string, args: HookArgs): void {
  const dispatch = useChatDispatch();
  const {
    isThinking,
    hasRunningTools,
    hasAwaitingApproval,
    visible,
    currentAttentionState,
  } = args;

  // Mutable refs avoid restarting the interval when these change mid-run.
  const currentAttentionStateRef = useRef(currentAttentionState);
  currentAttentionStateRef.current = currentAttentionState;

  const active = isThinking && !hasRunningTools && !hasAwaitingApproval && visible;

  useEffect(() => {
    if (!active) {
      // Clean up: if we left any non-ok state hanging, reset to 'ok' so the
      // banner disappears when Claude resumes or the user switches views.
      if (currentAttentionStateRef.current !== 'ok') {
        dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId, state: 'ok' });
      }
      return;
    }

    // Per-run spinner tracking for active vs. stalled detection.
    let previousSpinnerSeconds: number | null = null;
    let previousSpinnerAt: number = Date.now();
    // Debounce: count how many consecutive ticks have mapped to the same
    // non-ok state. Only dispatch once it sticks — transitions back to 'ok'
    // fire immediately so the banner clears fast when Claude resumes.
    let pendingState: AttentionState = 'ok';
    let pendingStreak = 0;

    const tick = () => {
      const raw = getScreenText(sessionId);
      if (raw === null) return;
      const lines = raw.split('\n');
      const tail = lines.slice(-40);

      const ctx: ClassifierContext = {
        bufferTail: tail,
        previousSpinnerSeconds,
        secondsSincePreviousSpinner: (Date.now() - previousSpinnerAt) / 1000,
      };
      const result = classifyBuffer(ctx);

      // Track spinner progression for the next tick.
      if (result.spinnerSeconds !== null) {
        if (result.spinnerSeconds !== previousSpinnerSeconds) {
          previousSpinnerSeconds = result.spinnerSeconds;
          previousSpinnerAt = Date.now();
        }
      }

      const mapped = bufferClassToAttention(result.class);

      // Track how long the mapped state has held across ticks.
      if (mapped === pendingState) {
        pendingStreak += 1;
      } else {
        pendingState = mapped;
        pendingStreak = 1;
      }

      // 'ok' clears the banner immediately — only escalations are debounced.
      const shouldDispatch =
        mapped === 'ok' || pendingStreak >= STABILITY_TICKS;

      if (shouldDispatch && mapped !== currentAttentionStateRef.current) {
        dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId, state: mapped });
      }
    };

    const interval = setInterval(tick, TICK_MS);
    // Run once immediately so short-lived stuck states surface inside 1s.
    tick();

    return () => {
      clearInterval(interval);
      // Reset to 'ok' on teardown so a stale banner doesn't persist.
      if (currentAttentionStateRef.current !== 'ok') {
        dispatch({ type: 'ATTENTION_STATE_CHANGED', sessionId, state: 'ok' });
      }
    };
    // Intentionally excludes currentAttentionState — accessed via ref to avoid
    // re-starting the classifier on every reducer dispatch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, dispatch]);
}
