// Pure PTY-buffer classifier for the chat-view attention banner.
//
// The classifier now only trusts the Claude Code spinner. Earlier versions
// also matched shell-prompt / error / y-n / numbered-menu patterns in the
// buffer tail, but those fired on ordinary tool output (code ending in $/>/#,
// log files starting with "Error:", Claude's own numbered lists) during
// normal active turns — producing false-positive "response may have arrived"
// banners between tool calls.
//
// Genuine attention cases are covered by stronger signals elsewhere:
//   - session death         → SESSION_PROCESS_EXITED (authoritative exit code)
//   - permission prompts    → hook relay (PERMISSION_REQUEST)
//   - stalled spinner ≥ 10s → 'thinking-stalled' below (spinner-anchored, reliable)
//
// Patterns verified against Claude Code CLI as of April 2026 — review if CLI
// visuals change. Spinner regex drift is the only remaining sensitivity.

export type BufferClass =
  | 'thinking-active'   // Spinner visible, seconds counter advancing
  | 'thinking-stalled'  // Spinner visible, seconds counter flat ≥ 10s
  | 'unknown';          // No spinner found — upstream maps this to 'ok'

export interface ClassifierContext {
  /** Last ~40 visible lines of the PTY buffer, ANSI-stripped. */
  bufferTail: string[];
  /** Seconds counter from the prior classifier tick (null if first tick). */
  previousSpinnerSeconds: number | null;
  /** Wall-clock seconds since previousSpinnerSeconds was observed. */
  secondsSincePreviousSpinner: number;
}

export interface ClassifierResult {
  class: BufferClass;
  /** Captured seconds counter from the spinner regex (null if no spinner). */
  spinnerSeconds: number | null;
}

// Claude Code thinking spinner — rotating glyph + word + "(Ns · esc to interrupt)".
// Group 1 captures the seconds counter we watch for staleness.
const SPINNER_RE =
  /[✻✽✢✳✶*⏺◉]\s+\w+[…\.]*\s*\((\d+)s\s*[·•]\s*esc\s*to\s*interrupt\)/i;

/**
 * Classify the tail of a terminal buffer. Pure: same input ⇒ same output.
 * No DOM, no timers, no side effects — easy to unit-test from fixtures.
 */
export function classifyBuffer(ctx: ClassifierContext): ClassifierResult {
  const tail = ctx.bufferTail;
  if (tail.length === 0) return { class: 'unknown', spinnerSeconds: null };

  // Scan the whole tail — Claude Code often renders the spinner a few lines
  // above the tail's literal end while streaming other output.
  let spinnerSeconds: number | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const m = tail[i].match(SPINNER_RE);
    if (m) {
      spinnerSeconds = parseInt(m[1], 10);
      break;
    }
  }

  if (spinnerSeconds === null) {
    // No spinner in the tail. Could mean: between tool calls, streaming text,
    // or session genuinely idle. We can't distinguish reliably from buffer
    // content alone, so default to 'unknown' and let upstream treat as 'ok'.
    return { class: 'unknown', spinnerSeconds: null };
  }

  // Spinner is visible. Decide active vs. stalled by comparing to previous tick.
  const prev = ctx.previousSpinnerSeconds;
  if (prev === null) {
    // First observation — give Claude the benefit of the doubt.
    return { class: 'thinking-active', spinnerSeconds };
  }
  if (spinnerSeconds > prev) {
    return { class: 'thinking-active', spinnerSeconds };
  }
  // Counter hasn't advanced. Only flag as stalled once we've waited ≥10s
  // between ticks — a short pause is normal between renders.
  if (ctx.secondsSincePreviousSpinner >= 10) {
    return { class: 'thinking-stalled', spinnerSeconds };
  }
  return { class: 'thinking-active', spinnerSeconds };
}
