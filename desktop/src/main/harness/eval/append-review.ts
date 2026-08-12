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
  // WHY runFacts is a plain string, not a BatteryRun: this function must stay
  // pure (see the file's top WHY comment) — the caller renders the facts block
  // with run-facts.ts's renderRunFacts() and passes the finished text in.
  run: { label: string; modelId: string; review: string; buildSha: string; runFacts: string },
  runAtISO: string,
): string {
  if (!run.review.trim()) {
    throw new Error(`Refusing to append an empty review for ${run.label} — the run produced no final text.`);
  }
  // Fix (2026-08-10 incident): the heading used to carry only a day-granularity
  // date, and the battery ran three times in one day — Grok 4.5, GPT 5.6 Luna,
  // and Deepseek v4 flash 0731 each produced two "## Review: <label> — <date>"
  // headings that were indistinguishable from each other, with no way to tell
  // which review came from which harness build. `runAtISO` is now a full
  // timestamp (the CLI already had this — it only ever truncated it to a date
  // before calling in), so the heading gets minute-precision time too:
  // sortable, and readable to a non-developer without opening the body.
  // Splitting the string on 'T' rather than constructing a `Date` keeps this a
  // plain string transform — no timezone/locale dependence, no new impurity.
  const [datePart, timePart = ''] = runAtISO.split('T');
  const hhmm = timePart.slice(0, 5);
  const stamp = hhmm ? `${datePart} ${hhmm}` : datePart;

  const section = [
    `## Review: ${run.label} — ${stamp}`,
    '',
    // Fix: build identity (which commit — and whether the worktree was dirty —
    // produced this review) is what actually distinguishes two runs of the
    // same model beyond "when": a git SHA would be ideal, but appendReview is
    // pure and cannot shell out to git itself. It's too verbose for the
    // heading anyway (which needs to stay skimmable via `grep '^## Review:'`),
    // so it lives on the metadata line instead. The CLI (review-harness.mjs)
    // resolves it via `git rev-parse`/`git status` and passes it in as data.
    `**Model:** \`${run.modelId}\` · **Battery:** \`src/main/harness/review/battery.ts\` · **Build:** \`${run.buildSha}\` · run in a disposable fixture workspace.`,
    '',
    // What the transcript shows this run actually did, plus any warning that
    // the review's claims outrun it (run-facts.ts). Every review carries this,
    // not only suspect ones — a reader should not have to open a 400KB
    // transcript JSON to learn how many tools a review is based on.
    run.runFacts,
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
