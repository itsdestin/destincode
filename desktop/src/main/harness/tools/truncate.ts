// ONE truncation policy for every tool (spec §2.3): head+tail preservation and
// an explicit notice telling the model HOW to get more — never silent cuts.
//
// WHY the advice string left this file (2026-08-06): it was hardcoded to
// "Use offset/limit or a narrower query", which is correct for Read and WRONG for
// Bash and WebSearch — neither accepts offset or limit. Two reviewing models
// followed that advice into a dead end. Tools now declare a `moreHint` in their
// own vocabulary and composeNotice renders it; this module only reports facts.
//
// WHY a SECOND, static `moreHint` (Task 19, 2026-08-06): `bounds.moreHint` above
// only exists when the TOOL bounded its own output on THIS call. The pipeline
// cap (defineTool's `caps`) is a separate event with its own schedule — three
// independent reviews found cases where it fires alone: content-mode Grep
// capped by `maxLines` with `bounds` undefined, Glob capped by `maxChars` under
// its own result limit, Bash's trailer pushing a small body over the cap. Each
// tool's widening vocabulary doesn't change between calls, so `NativeTool.moreHint`
// (types.ts) is declared once, statically, and composeNotice falls back to it
// instead of leaving the model with a bare byte count.
import type { ResultBounds } from './types';

export interface TruncateOpts { maxChars: number; maxLines?: number }
export interface TruncateResult {
  text: string;
  truncated: boolean;
  /** Length of the ORIGINAL input, always — the number a caller needs to decide
   *  whether re-running with a narrower query is worth it. */
  totalChars: number;
}

export function truncateOutput(text: string, opts: TruncateOpts): TruncateResult {
  let out = text;
  let truncated = false;
  if (opts.maxLines) {
    const lines = out.split('\n');
    if (lines.length > opts.maxLines) {
      const head = lines.slice(0, Math.ceil(opts.maxLines * 0.8));
      // Guard slice(-0): Math.floor(maxLines*0.2)===0 (maxLines<=4) would make
      // slice(-0) return the WHOLE array, blowing output past the input size.
      const tailN = Math.floor(opts.maxLines * 0.2);
      const tail = tailN > 0 ? lines.slice(-tailN) : [];
      out = [...head, `[... ${lines.length - opts.maxLines} lines omitted ...]`, ...tail].join('\n');
      truncated = true;
    }
  }
  if (out.length > opts.maxChars) {
    const head = out.slice(0, Math.ceil(opts.maxChars * 0.8));
    // Same slice(-0) guard as the line path: an empty tail when maxChars<=4.
    const tailN = Math.floor(opts.maxChars * 0.2);
    const tail = tailN > 0 ? out.slice(-tailN) : '';
    out = `${head}\n[...]\n${tail}`;
    truncated = true;
  }
  return { text: out, truncated, totalChars: text.length };
}

/** Render at most ONE notice line from the two independent bounds that can apply:
 *  what the TOOL cut (`bounds`) and what the PIPELINE cap cut (`cap`).
 *
 *  WHY one line and not two: a result carrying two competing notices reads as if
 *  something went wrong twice, and the model has to reconcile them. One line
 *  states both facts and carries exactly one piece of advice — the tool's.
 *
 *  `fallbackHint` is the tool's STATIC widening vocabulary (`NativeTool.moreHint`,
 *  passed in by defineTool) — used only when `bounds` is absent, since a real
 *  `bounds.moreHint` is always the more specific, per-call advice. */
// Line-aware head/tail slicing (2026-08-10 harness review, Claim 5): added
// PURELY ADDITIVELY, alongside truncateOutput/composeNotice above rather than
// changing them, because those two functions are the SHARED pipeline backstop
// every tool routes through (registry.ts's defineTool) — WebFetch's ~30,000-char
// cap was explicitly praised by reviewers and must not move. Only bash.ts calls
// these; nothing else is affected.
//
// WHY line-aware, not char-aware: the review measured a real defect — a
// character-based cut on `seq 1 20000` sliced the line '4621' into '46' plus a
// silently discarded '21', with no signal to the model that the number was
// corrupted by truncation rather than being the command's real output. These
// two functions never return a partial line except in the one case where a
// SINGLE line alone exceeds the whole budget (e.g. a minified JSON blob with no
// newlines) — there "show nothing" and "show a labeled partial" both have a
// downside, and showing a fallback partial slice beats showing nothing at all.
export interface LineSliceResult {
  text: string;
  /** Full lines actually kept (0 for the single-long-line fallback slice). */
  lines: number;
  /** Chars actually kept (the true length of `text`). */
  chars: number;
}

/** Keep up to `maxLines` lines / `maxChars` chars from the START of `text`,
 *  stopping at whichever budget is hit first — never cutting a kept line
 *  short. */
export function takeHeadLines(text: string, maxChars: number, maxLines: number): LineSliceResult {
  if (text === '') return { text: '', lines: 0, chars: 0 };
  const lines = text.split('\n');
  let count = 0;
  let chars = 0;
  for (; count < lines.length && count < maxLines; count++) {
    const sep = count > 0 ? 1 : 0; // the '\n' that joins this line to the previous one
    const len = lines[count].length + sep;
    if (chars + len > maxChars) break;
    chars += len;
  }
  if (count === 0 && maxChars > 0) {
    // The very first line alone is bigger than the entire budget — the one
    // case where "never cut mid-line" and "show something" conflict. Fall
    // back to a plain char slice of just that line rather than an empty head.
    const slice = lines[0].slice(0, maxChars);
    return { text: slice, lines: 0, chars: slice.length };
  }
  return { text: lines.slice(0, count).join('\n'), lines: count, chars };
}

/** Keep up to `maxLines` lines / `maxChars` chars from the END of `text`,
 *  same line-boundary guarantee as `takeHeadLines`. */
export function takeTailLines(text: string, maxChars: number, maxLines: number): LineSliceResult {
  if (text === '') return { text: '', lines: 0, chars: 0 };
  const lines = text.split('\n');
  let count = 0;
  let chars = 0;
  for (; count < lines.length && count < maxLines; count++) {
    const idx = lines.length - 1 - count;
    const sep = count > 0 ? 1 : 0; // the '\n' that joins this line to the next one
    const len = lines[idx].length + sep;
    if (chars + len > maxChars) break;
    chars += len;
  }
  if (count === 0 && maxChars > 0) {
    const last = lines[lines.length - 1];
    const slice = last.slice(Math.max(0, last.length - maxChars));
    return { text: slice, lines: 0, chars: slice.length };
  }
  return { text: lines.slice(lines.length - count).join('\n'), lines: count, chars };
}

export function composeNotice(
  bounds: ResultBounds | undefined,
  cap: { shown: number; total: number } | null,
  fallbackHint?: string,
): string {
  if (!bounds && !cap) return '';
  if (!bounds) {
    // A cap fired on a tool that declared no bounds of its own THIS call. This
    // used to mean "we have no idea what this tool's widening vocabulary is" and
    // render nothing — but the 2026-08-06 multi-review pass found that for
    // content-mode Grep (capped by maxLines, which never sets `bounds`) this is
    // the COMMON path, not a bug. `fallbackHint` carries the tool's static advice
    // for exactly this branch; when the tool genuinely has none (fallbackHint
    // undefined), still say nothing — inventing advice is the bug this exists to
    // prevent, not a fallback for it.
    const advice = fallbackHint ? ` — ${fallbackHint}` : '';
    return `\n[output truncated: showing ${cap!.shown} of ${cap!.total} chars${advice}]`;
  }
  // WHY total === null gets its OWN phrasing, not "at least N" (2026-08-06,
  // elevated-minor review): "showing N of at least N" collapses to "that is
  // ALL of them" — the opposite of what `total: null` means (the tool stopped
  // counting; more may exist beyond what's shown). Glob rendered "showing 2000
  // of at least 2000 files" for a walk that may have seen 50,000+ — a
  // tautology, not a warning. State plainly that more may exist and the count
  // is unknown, without inventing a floor that reads as a ceiling. A KNOWN
  // total keeps its exact "N of M" rendering below, unchanged.
  const toolPart = bounds.total === null
    ? `${bounds.shown} ${bounds.unit} (more may exist — exact total unknown)`
    : `${bounds.shown} of ${bounds.total} ${bounds.unit}`;
  if (!cap) return `\n[showing ${toolPart} — ${bounds.moreHint}]`;
  return `\n[showing ${cap.shown} of ${cap.total} chars, and ${toolPart} — ${bounds.moreHint}]`;
}
