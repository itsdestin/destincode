// ONE truncation policy for every tool (spec §2.3): head+tail preservation and
// an explicit trailer telling the model HOW to get more — never silent cuts.
export interface TruncateOpts { maxChars: number; maxLines?: number }
export interface TruncateResult { text: string; truncated: boolean }

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
  if (truncated) {
    // Trailer reports the ORIGINAL length and points at the escape hatch — the
    // model should never be left guessing whether output was silently cut.
    out += `\n[truncated — ${text.length} chars total. Use offset/limit or a narrower query to see more.]`;
  }
  return { text: out, truncated };
}
