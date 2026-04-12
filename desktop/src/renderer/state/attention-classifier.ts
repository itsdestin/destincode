// Pure PTY-buffer classifier for the chat-view attention banner.
//
// The classifier now only trusts the Claude Code / Gemini CLI spinner. Earlier
// versions also matched shell-prompt / error / y-n / numbered-menu patterns in
// the buffer tail, but those fired on ordinary tool output (code ending in $/>/#,
// log files starting with "Error:", Claude's own numbered lists) during
// normal active turns — producing false-positive "response may have arrived"
// banners between tool calls.
//
// Genuine attention cases are covered by stronger signals elsewhere:
//   - session death         → SESSION_PROCESS_EXITED (authoritative exit code)
//   - permission prompts    → hook relay (PERMISSION_REQUEST)
//   - stalled spinner ≥ 10s → 'thinking-stalled' below (spinner-anchored, reliable)
//
// Patterns verified against Claude Code / Gemini CLI as of April 2026.

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
  /** True if an "esc to cancel" marker is present in the tail (not the spinner's "esc to interrupt"). */
  escToCancel: boolean;
}

// Claude Code thinking spinner — rotating glyph + word + "(Ns · esc to interrupt)".
// Group 1 captures the seconds counter we watch for staleness.
const CLAUDE_SPINNER_RE =
  /[✻✽✢✳✶*⏺◉]\s+\w+[…\.]*\s*\((\d+)s\s*[·•]\s*esc\s*to\s*interrupt\)/i;

// Gemini CLI thinking spinner — rotating braille + "Thinking..." + "(Ns)".
const GEMINI_SPINNER_RE =
  /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s+Thinking\.\.\.\s*\((\d+)s\)/i;

// "Esc to cancel" — distinct from the spinner's "esc to interrupt". Claude Code
// uses this on certain waiting prompts (bash command in-flight, shell output
// pending). If it persists without a tool being active in chat view, that's a
// real attention signal.
const ESC_TO_CANCEL_RE = /esc\s*to\s*cancel/i;

/**
 * Classify the tail of a terminal buffer. Pure: same input ⇒ same output.
 * No DOM, no timers, no side effects — easy to unit-test from fixtures.
 */
export function classifyBuffer(ctx: ClassifierContext): ClassifierResult {
  const tail = ctx.bufferTail;
  if (tail.length === 0) {
    return { class: 'unknown', spinnerSeconds: null, escToCancel: false };
  }

  // Scan the whole tail — Claude/Gemini often render the spinner a few lines
  // above the tail's literal end while streaming other output.
  let spinnerSeconds: number | null = null;
  for (let i = tail.length - 1; i >= 0; i--) {
    const claudeMatch = tail[i].match(CLAUDE_SPINNER_RE);
    const geminiMatch = tail[i].match(GEMINI_SPINNER_RE);
    const m = claudeMatch || geminiMatch;
    if (m) {
      spinnerSeconds = parseInt(m[1], 10);
      break;
    }
  }

  // Look for "esc to cancel" — only count hits that aren't on a spinner line,
  // since the spinner regex already covers "esc to interrupt" on its own line.
  let escToCancel = false;
  for (const line of tail) {
    if (ESC_TO_CANCEL_RE.test(line)) {
      escToCancel = true;
      break;
    }
  }

  if (spinnerSeconds === null) {
    // No spinner in the tail. Could mean: between tool calls, streaming text,
    // or session genuinely idle. We can't distinguish reliably from buffer
    // content alone, so default to 'unknown' and let upstream treat as 'ok'
    // (with the escToCancel flag surfaced for persistence tracking).
    return { class: 'unknown', spinnerSeconds: null, escToCancel };
  }

  // Spinner is visible. Decide active vs. stalled by comparing to previous tick.
  const prev = ctx.previousSpinnerSeconds;
  if (prev === null) {
    // First observation — give the model the benefit of the doubt.
    return { class: 'thinking-active', spinnerSeconds, escToCancel };
  }
  if (spinnerSeconds > prev) {
    return { class: 'thinking-active', spinnerSeconds, escToCancel };
  }
  // Counter hasn't advanced. Only flag as stalled once we've waited ≥10s
  // between ticks — a short pause is normal between renders.
  if (ctx.secondsSincePreviousSpinner >= 10) {
    return { class: 'thinking-stalled', spinnerSeconds, escToCancel };
  }
  return { class: 'thinking-active', spinnerSeconds, escToCancel };
}
