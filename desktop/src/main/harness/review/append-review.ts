// Insert one review section, leaving every existing one untouched.
//
// WHY a pure string function: the doc says "Do not edit or delete other models'
// reviews", and a pure transform makes that assertable in a unit test rather than
// a habit the runner is trusted to keep. The runner reads, transforms, writes.
const PROMPT_HEADING = '## Prompt for other agents';

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
  ].join('\n');

  const at = docText.indexOf(PROMPT_HEADING);
  // Insert ABOVE the prompt block, which the doc's own instructions designate as
  // the tail. Appending to the end would bury it below the prompt.
  if (at === -1) return `${docText.trimEnd()}\n\n---\n\n${section}`;
  return docText.slice(0, at) + section + docText.slice(at);
}
