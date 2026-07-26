import React, { useState, useEffect } from 'react';
import BrailleSpinner from './BrailleSpinner';

// How long after the last token the model still counts as "actively streaming".
// Long enough to bridge normal inter-token gaps, short enough that a real pause
// brings the indicator back promptly.
const STREAMING_GRACE_MS = 2_000;

const THINKING_LINES = [
  'Thinking',
  'Cogitating',
  'Pondering',
  'Ruminating',
  'Noodling',
  'Percolating',
  'Brainstorming',
  'Deliberating',
  'Marinating',
  'Musing',
  'Contemplating',
  'Stewing',
  'Mulling it over',
  'Chewing on it',
  'Untangling',
  'Connecting dots',
  'Rearranging neurons',
  'Consulting the vibes',
  'Findangling',
  'Embellishing',
  'Simmering',
  'Calibrating',
  'Perplexing',
];

interface ThinkingIndicatorProps {
  /**
   * Native runtime only. When set, the streaming watchdog has flagged the
   * provider as silent — swap the playful rotating word for a "taking a while"
   * warning. `willRetry` controls whether we promise an auto-retry countdown
   * (true) or stay non-committal because the stall will end in an error (false).
   */
  stallWarning?: { retryInMs: number; willRetry: boolean } | null;
  /** Native prefill: the model is reading a long prompt, not hanging. */
  promptProcessing?: { promptTokens: number; budgetMs: number; source?: 'prompt' | 'tool-output' } | null;
  /** When visible output last arrived. While this is fresh the indicator renders
   *  NOTHING — the filling bubble is already the proof of life. */
  lastOutputAt?: number | null;
}

export default function ThinkingIndicator({ stallWarning, promptProcessing, lastOutputAt }: ThinkingIndicatorProps = {}) {
  const [lineIndex, setLineIndex] = useState(() =>
    Math.floor(Math.random() * THINKING_LINES.length),
  );
  const [secondsLeft, setSecondsLeft] = useState(0);

  // Rotate the playful words only while NOT stalled — a stall shows fixed copy.
  useEffect(() => {
    if (stallWarning) return;
    const id = setInterval(() => {
      setLineIndex(Math.floor(Math.random() * THINKING_LINES.length));
    }, 2500);
    return () => clearInterval(id);
  }, [stallWarning]);

  // Countdown while stalled. Seeded from the watchdog's retryInMs and ticked to
  // zero. A fresh stallWarning object (each distinct stall) restarts the timer;
  // clearing it (→ null, activity resumed) tears the timer down.
  useEffect(() => {
    if (!stallWarning) { setSecondsLeft(0); return; }
    let n = Math.ceil(stallWarning.retryInMs / 1000);
    setSecondsLeft(n);
    const id = setInterval(() => {
      n = Math.max(0, n - 1);
      setSecondsLeft(n);
      if (n === 0) clearInterval(id);
    }, 1000);
    return () => clearInterval(id);
  }, [stallWarning]);

  // Stalled: fixed warning copy. Only promise a retry when the harness actually
  // will retry — otherwise the stall ends in an error (no misleading "retrying").
  // ── Suppress while output is actively arriving ───────────────────────────
  // The indicator exists to answer "is it alive?" when the user has NO other
  // evidence of progress. Tokens landing in a bubble ARE that evidence, so a
  // spinner beside them is pure noise (Destin, 2026-07-26). Tool cards and
  // approval prompts are handled upstream by ChatView's thinkingArea predicate;
  // streaming text is the case that had no signal until now.
  //
  // Grace rather than a hard flag because there is no "output ended" event —
  // only deltas arriving. The useful side effect: if generation genuinely pauses
  // for longer than the grace, the indicator returns, which is exactly when
  // reassurance is wanted again.
  const [, forceTick] = useState(0);
  const streamingNow = lastOutputAt != null && Date.now() - lastOutputAt < STREAMING_GRACE_MS;
  useEffect(() => {
    if (!streamingNow) return;
    // Re-evaluate once the grace expires so the indicator reappears on a pause.
    const remaining = STREAMING_GRACE_MS - (Date.now() - (lastOutputAt ?? 0));
    const id = setTimeout(() => forceTick((n) => n + 1), Math.max(50, remaining));
    return () => clearTimeout(id);
  }, [streamingNow, lastOutputAt]);
  // A stall warning outranks everything: if we think something is wrong, say so
  // even if a delta landed a moment ago.
  if (streamingNow && !stallWarning) return null;

  // Prefill copy is deliberately NOT alarming: nothing is wrong, the model is
  // simply reading. Naming the size makes the wait legible ("it's a big prompt")
  // instead of mysterious, and it's the honest reason a local model is slow here.
  // A real stall warning still outranks it — if we've crossed into "something may
  // be wrong" territory, say so rather than keep reassuring.
  const label = stallWarning
    ? `This is taking a while, something may be wrong…${
        stallWarning.willRetry
          ? secondsLeft > 0 ? ` Retrying in ${secondsLeft}s…` : ' Retrying…'
          : ''
      }`
    : promptProcessing
      ? `${promptProcessing.source === 'tool-output' ? 'Reading tool output' : 'Reading your prompt'} — ${promptProcessing.promptTokens.toLocaleString()} tokens…`
      : THINKING_LINES[lineIndex];

  return (
    // in-view: opts the inner bg-inset bubble into wallpaper-driven bubble
    // glassmorphism (theme-engine targets `.in-view .bg-inset` descendants).
    <div className="flex items-center gap-2 px-4 py-1.5 in-view">
      <div className="flex items-center gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5">
        <BrailleSpinner size="base" />
        <span className="text-sm text-fg-dim">
          {label}
        </span>
      </div>
    </div>
  );
}
