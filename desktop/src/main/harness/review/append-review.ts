// Insert one review section, leaving every existing one untouched.
//
// WHY a pure string function: the doc says "Do not edit or delete other models'
// reviews", and a pure transform makes that assertable in a unit test rather than
// a habit the runner is trusted to keep. The runner reads, transforms, writes.
//
// WHY a line-anchored regex, not `docText.indexOf('## Prompt for other agents')`:
// indexOf matches that string ANYWHERE, including inside a fenced code block or
// inside a review body that quotes the heading in prose — and the battery is
// self-referential by design (every model reviews this harness, so the doc's
// own conventions get discussed inside reviews). A future review whose text
// mentions the heading would silently redirect the NEXT append into the middle
// of that review's body instead of the real heading.
//
// WHY the LAST match, not the first: a quoted heading inside a review can sit
// on its own line too (e.g. a fenced code block reproducing the doc's own
// convention verbatim), which the line-anchored regex matches just as happily
// as the real one — so anchoring alone doesn't disambiguate. The doc's own
// convention (see the comment below) is that this heading is always the tail
// of the file, so the LAST line-anchored match is the real one; anything
// earlier is a quote.
const PROMPT_HEADING_RE = /^## Prompt for other agents$/gm;

export function appendReview(
  docText: string,
  run: { label: string; modelId: string; review: string },
  dateISO: string,
): string {
  if (!run.review.trim()) {
    throw new Error(`Refusing to append an empty review for ${run.label} — the run produced no final text.`);
  }
  const section = [
    `## Review: ${run.label} — ${dateISO}`,
    '',
    `**Model:** \`${run.modelId}\` · **Battery:** \`src/main/harness/review/battery.ts\` · run in a disposable fixture workspace.`,
    '',
    run.review.trim(),
    '',
    `— **${run.label}**`,
    '',
    '---',
    '',
    // Fix: the doc's own `---` separators (see the target investigation doc) are
    // always followed by a BLANK line before the next heading, not just a lone
    // newline. A single trailing '' here rendered as "---\n" — glued directly to
    // whatever heading came next. Because insertion always happens right above
    // the same "## Prompt for other agents" heading, every future append would
    // glue its own `---` against the PREVIOUS append's heading too, so the seam
    // degraded a little more on every run. The second '' adds the missing blank
    // line so `join('\n')` produces "---\n\n" — matching the doc's convention.
    '',
  ].join('\n');

  const matches = [...docText.matchAll(PROMPT_HEADING_RE)];
  const last = matches.at(-1);
  // Insert ABOVE the prompt block, which the doc's own instructions designate as
  // the tail. Appending to the end would bury it below the prompt.
  if (!last || last.index === undefined) return `${docText.trimEnd()}\n\n---\n\n${section}`;
  const at = last.index;
  return docText.slice(0, at) + section + docText.slice(at);
}
