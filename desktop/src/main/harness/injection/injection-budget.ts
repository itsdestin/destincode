// Bounding injected content (program §4 item 5).
//
// A 600-word rule, a long SKILL.md, or a nested CLAUDE.md can consume a
// meaningful slice of a small model's window. Everything injected as a message
// passes through here first.
//
// WHY it always announces the cut: a silently truncated procedure is worse than
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
