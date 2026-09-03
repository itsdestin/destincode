// Search matching for name-shaped lists (models, skills, themes…).
//
// WHY this exists: a plain `haystack.includes(query)` fails the way people
// actually type. Model names are punctuated — "GPT-5.6", "claude-opus-5" —
// but nobody types the hyphen, so searching "gpt 5.6" for "OpenAI: GPT-5.6
// Luna Pro" returned "No models match." while "gpt" alone found it.
//
// The rule: split what was typed into words, and every word must appear
// somewhere in the row — in any order, and with the row's punctuation
// treated as a space. So "gpt 5.6", "gpt-5.6", "luna gpt" and "pro openai"
// all find that row, while a word that is genuinely absent still excludes it.

/** Punctuation between words is interchangeable with a space when matching. */
const loosen = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ');

/**
 * True when every whitespace-separated word of `query` appears in any of
 * `fields`. A blank query matches everything — callers show their default
 * view (favourites, full list) rather than filtering.
 */
export function matchesQuery(query: string, ...fields: (string | null | undefined)[]): boolean {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  // Fields are joined with a gap wide enough that no term can straddle two of
  // them (matching "pro openrouter" across a label/provider boundary).
  const exact = fields.map((f) => (f ?? '').toLowerCase()).join('   ');
  // The loosened copy is searched too, so a typed hyphen still matches a row
  // that uses a space and vice versa — "gpt 5" finds "GPT-5", "gpt-5" finds "GPT 5".
  const loose = loosen(exact);
  return terms.every((t) => exact.includes(t) || loose.includes(loosen(t)));
}
