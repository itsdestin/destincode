// ONE truncation policy for every tool (spec §2.3): head+tail preservation and
// an explicit notice telling the model HOW to get more — never silent cuts.
//
// WHY the advice string left this file (2026-08-06): it was hardcoded to
// "Use offset/limit or a narrower query", which is correct for Read and WRONG for
// Bash and WebSearch — neither accepts offset or limit. Two reviewing models
// followed that advice into a dead end. Tools now declare a `moreHint` in their
// own vocabulary and composeNotice renders it; this module only reports facts.
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
 *  states both facts and carries exactly one piece of advice — the tool's. */
export function composeNotice(
  bounds: ResultBounds | undefined,
  cap: { shown: number; total: number } | null,
): string {
  if (!bounds && !cap) return '';
  if (!bounds) {
    // A cap fired on a tool that declared nothing. Report the fact WITHOUT advice —
    // we have no idea what this tool's widening vocabulary is, and guessing is the
    // exact bug this refactor removes. A tool reaching this code path is a bounds
    // declaration bug — it should be caught by the manifest guard before shipping.
    return `\n[output truncated: showing ${cap!.shown} of ${cap!.total} chars]`;
  }
  const total = bounds.total === null ? `at least ${bounds.shown}` : String(bounds.total);
  const toolPart = `${bounds.shown} of ${total} ${bounds.unit}`;
  if (!cap) return `\n[showing ${toolPart} — ${bounds.moreHint}]`;
  return `\n[showing ${cap.shown} of ${cap.total} chars, and ${toolPart} — ${bounds.moreHint}]`;
}
