import React, { useState, useEffect } from 'react';
import BrailleSpinner from './BrailleSpinner';

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
  promptProcessing?: { promptTokens: number; budgetMs: number } | null;
}

export default function ThinkingIndicator({ stallWarning, promptProcessing }: ThinkingIndicatorProps = {}) {
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
      ? `Reading your prompt — ${promptProcessing.promptTokens.toLocaleString()} tokens. Local models take a while on long prompts…`
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
