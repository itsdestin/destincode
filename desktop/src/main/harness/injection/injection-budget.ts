// Bounding model-facing content by token budget (program §4 item 5, §7 item 3).
//
// A 600-word rule, a long SKILL.md, or a nested CLAUDE.md can consume a
// meaningful slice of a small model's window. Everything injected as a message
// passes through fitInjection; the ROOT project-instruction file, which lives in
// the byte-stable system prompt rather than in a message, passes through
// fitProjectInstructions. Both live here so they share one chars-per-token
// constant — two of those would drift, and drift here is silent.
//
// WHY they always announce the cut: a silently truncated procedure is worse than
// no procedure at all. The model follows the half it received believing it has
// the whole thing, and nothing anywhere signals that it is working from a
// fragment. Saying so costs a line and turns a silent failure into a recoverable one.
const APPROX_CHARS_PER_TOKEN = 4;
const NOTICE = "\n\n[...truncated to fit this model's context window. Ask for the rest if you need it.]";

export function fitInjection(text: string, budgetTokens: number): { text: string; truncated: boolean } {
  const budgetChars = Math.max(0, budgetTokens) * APPROX_CHARS_PER_TOKEN;
  if (text.length <= budgetChars) return { text, truncated: false };
  // Reserve room for the notice itself, so the thing announcing the cut is never
  // the thing that gets cut, and the result still fits the budget it was given.
  // A budget too small to hold even the notice yields the notice alone — honest,
  // and never a bare empty string the caller would mistake for "nothing to say".
  const room = Math.max(0, budgetChars - NOTICE.length);
  return { text: text.slice(0, room) + NOTICE, truncated: true };
}

// --- Root project instructions (AGENTS.md / CLAUDE.md) ----------------------
//
// This one is NOT injected as a message: it is baked into the byte-stable system
// prompt (prompt-assembly.ts), which is assembled once per session and never
// rewritten — that is what makes project rules immortal, safe from compaction.
// So it needs its own fitter rather than fitInjection:
//   - it names the source file, because the model CAN go read the rest with the
//     Read tool ("ask for the rest" is the wrong advice when the file is on disk);
//   - it counts the sections it dropped, because "truncated" alone doesn't tell
//     a model whether it lost a sentence or two thirds of the project's rules;
//   - it cuts on a line boundary, preferring a heading, because a byte slice can
//     land mid-sentence or inside an open code fence.
// It replaced a bare `.slice(0, 20_000)` — a CHARACTER cap, unscaled by model,
// silent, and byte-offset — on 2026-08-10 (program §7 item 3).
const HEADING_LINE = /^#{1,6} /;

function countHeadings(text: string): number {
  let n = 0;
  for (const line of text.split('\n')) if (HEADING_LINE.test(line)) n++;
  return n;
}

function instructionNotice(omitted: number, total: number, fileName: string): string {
  const scope = total > 0 ? ` — ${omitted} of ${total} sections omitted` : '';
  return `\n\n[...truncated to fit this model's context window${scope}. Read ${fileName} directly for the rest.]`;
}

/** Last safe cut point at or before `candidate`'s end, preferring the coarsest
 *  boundary that still keeps most of the room: a heading (drops whole trailing
 *  sections) → a paragraph break → any line end. The 50% floor stops a boundary
 *  near the very start from throwing away most of the budget just to be tidy;
 *  below it we take the hard cut and keep the content. */
function boundaryIndex(candidate: string): number {
  const floor = candidate.length * 0.5;
  for (const sep of ['\n#', '\n\n', '\n']) {
    const at = candidate.lastIndexOf(sep);
    if (at > floor) return at;
  }
  return candidate.length;
}

export function fitProjectInstructions(
  text: string,
  budgetTokens: number,
  fileName: string,
): { text: string; truncated: boolean } {
  const budgetChars = Math.max(0, budgetTokens) * APPROX_CHARS_PER_TOKEN;
  if (text.length <= budgetChars) return { text, truncated: false };

  const total = countHeadings(text);
  // Reserve against the LONGEST notice this call could produce (omitted === total
  // has the most digits), so the notice can be rendered with its real counts
  // afterwards and the result still fits the budget. Sizing the reservation from
  // the real notice would be circular — its counts depend on where we cut.
  const room = Math.max(0, budgetChars - instructionNotice(total, total, fileName).length);
  if (room === 0) return { text: instructionNotice(total, total, fileName).trimStart(), truncated: true };

  const kept = text.slice(0, boundaryIndex(text.slice(0, room)));
  return { text: kept + instructionNotice(total - countHeadings(kept), total, fileName), truncated: true };
}
