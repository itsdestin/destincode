// Single source of truth for the "Ask Claude about this" prompt scaffold
// (spec 2026-07-26). build-reference.ts is the only BUILDER (turns a chat
// selection / artifact selection into promptText); UserMessage.tsx is the
// only PARSER (turns a dispatched message's content back into the pieces it
// renders as an inline reply). Both used to hold their own copy of the lead
// strings and separators — the real risk here isn't either one being wrong
// in isolation, it's the two silently drifting apart. Putting both directions
// through the same constants closes that gap.
//
// WHY the parser can't assume literal '\n': the scaffold's promptText (built
// with real '\n'/'\n\n') gets prepended to the user's draft in InputBar's
// composeOutgoing(), and the COMBINED string is then run through
// buildOutgoingMessage()'s sanitize step — `rawText.replace(/[\r\n]+/g, ' ')`
// — before it ever becomes the dispatched message content (see
// outgoing-message.ts). That collapses every run of newlines, INCLUDING the
// ones inside the scaffold itself, to a single space. So the string that
// actually lands in a timeline entry's `content` is single-line, not the
// multi-line text buildScaffold() returns. The parser matches on `\s+`
// (falls back to `\s*` only where the gap can legally be empty) specifically
// so it recognizes BOTH the raw builder output (used directly in the
// round-trip unit test below) and the flattened runtime string (what
// UserMessage actually receives) with one code path.

/** Lead-in above a quoted chat message. Neutral when we can't tell whose bubble it was. */
export const LEAD_ASSISTANT = 'In an earlier message, you said:';
export const LEAD_USER = 'Earlier I wrote:';
export const LEAD_NEUTRAL = 'Regarding this:';
/** Lead-in above a fenced code reference — always this one string, never the three above. */
export const LEAD_CODE = 'Earlier, you shared this code:';

/** Marks the boundary between the quoted reference and the user's own words.
 *
 * Known miss: if the user sends a chat-text/chat-code reference with a
 * completely EMPTY follow-up, buildOutgoingMessage's trailing `.trim()`
 * strips this marker's own trailing space (nothing follows it, so it's the
 * last char of the string) — the marker then no longer occurs literally in
 * the dispatched content, parseChat's indexOf lookup misses, and the message
 * renders as plain text instead of the reply block. Rare in practice (it
 * requires holding a reference and hitting Send with zero typed follow-up)
 * and not worth widening the marker match for one all-punctuation edge case. */
export const FOLLOW_UP_MARKER = 'The user has a follow-up: ';

const ARTIFACT_PREFIX = 'The user is referencing ';
const ARTIFACT_MIDDLE = ' from "';
// Everything up to (not including) the '\n\n' + draft that composeOutgoing appends.
const ARTIFACT_SUFFIX_FIXED = '". Respond to the following prompt accordingly:';

/** Builds the lead+quote scaffold for a chat-text or chat-code reference. */
export function buildScaffold(lead: string, body: string, fenced: boolean): string {
  const quoted = fenced ? '```\n' + body + '\n```' : `"${body}"`;
  return `${lead}\n${quoted}\n\n${FOLLOW_UP_MARKER}`;
}

/** Builds the scaffold for an artifact (file/line) reference — no quoted body. */
export function buildArtifactScaffold(descriptor: string, path: string): string {
  return `${ARTIFACT_PREFIX}${descriptor}${ARTIFACT_MIDDLE}${path}${ARTIFACT_SUFFIX_FIXED}\n\n`;
}

export type ParsedReference =
  | { kind: 'chat-text' | 'chat-code'; lead: string; quote: string; fenced: boolean; followUp: string }
  | { kind: 'artifact'; descriptor: string; path: string; followUp: string };

const CHAT_LEADS: ReadonlyArray<{ lead: string; fenced: boolean }> = [
  { lead: LEAD_ASSISTANT, fenced: false },
  { lead: LEAD_USER, fenced: false },
  { lead: LEAD_NEUTRAL, fenced: false },
  { lead: LEAD_CODE, fenced: true },
];

// Strips a fixed prefix/suffix pair, trimming exactly the whitespace that
// separates them from the body (the flattened-or-not newline). Returns null
// when the shape doesn't match — the caller falls through to "not a scaffold".
function unwrapFence(s: string): string | null {
  if (!s.startsWith('```') || !s.endsWith('```') || s.length < 6) return null;
  return s.slice(3, -3).replace(/^\s+/, '').replace(/\s+$/, '');
}

function unwrapQuotes(s: string): string | null {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') return null;
  return s.slice(1, -1);
}

function parseChat(content: string): ParsedReference | null {
  for (const { lead, fenced } of CHAT_LEADS) {
    if (!content.startsWith(lead)) continue;
    // Separator after the lead always has at least one char (a real '\n' in
    // the builder's own output, one collapsed space at runtime) — it's never
    // at the very end of the string, so trim() in buildOutgoingMessage can't
    // have eaten it away. Safe to require \s+.
    const wsAfterLead = content.slice(lead.length).match(/^\s+/);
    if (!wsAfterLead) continue;
    const afterLead = content.slice(lead.length + wsAfterLead[0].length);

    const markerIdx = afterLead.indexOf(FOLLOW_UP_MARKER);
    if (markerIdx === -1) continue;

    // Walk back over the whitespace run between the quote and the marker
    // (the original '\n\n', or one collapsed space) to find where the
    // quoted text actually ends.
    let quotedEnd = markerIdx;
    while (quotedEnd > 0 && /\s/.test(afterLead[quotedEnd - 1])) quotedEnd--;
    const quoted = afterLead.slice(0, quotedEnd);
    const followUp = afterLead.slice(markerIdx + FOLLOW_UP_MARKER.length);

    const quote = fenced ? unwrapFence(quoted) : unwrapQuotes(quoted);
    if (quote === null) continue;

    return { kind: fenced ? 'chat-code' : 'chat-text', lead, quote, fenced, followUp };
  }
  return null;
}

function parseArtifact(content: string): ParsedReference | null {
  if (!content.startsWith(ARTIFACT_PREFIX)) return null;
  // lastIndexOf, not indexOf: the descriptor can itself be a quoted excerpt
  // (describeArtifactSelection falls back to `"${sel}"` when it can't cite a
  // line number), which could coincidentally contain this exact suffix text.
  // Anchoring from the end is the more common case to get right.
  const suffixIdx = content.lastIndexOf(ARTIFACT_SUFFIX_FIXED);
  if (suffixIdx === -1) return null;
  const middleIdx = content.indexOf(ARTIFACT_MIDDLE, ARTIFACT_PREFIX.length);
  if (middleIdx === -1 || middleIdx >= suffixIdx) return null;

  const descriptor = content.slice(ARTIFACT_PREFIX.length, middleIdx);
  const path = content.slice(middleIdx + ARTIFACT_MIDDLE.length, suffixIdx);
  // \s* (not \s+): if the user sent the reference with an EMPTY follow-up,
  // buildOutgoingMessage's trailing .trim() removes the '\n\n'/' ' gap
  // entirely, leaving nothing after the suffix. A required \s+ would reject
  // that (rare but legitimate) case.
  const afterSuffix = content.slice(suffixIdx + ARTIFACT_SUFFIX_FIXED.length);
  const ws = afterSuffix.match(/^\s*/)![0];
  const followUp = afterSuffix.slice(ws.length);

  return { kind: 'artifact', descriptor, path, followUp };
}

/** Returns the parsed pieces of a reference scaffold, or null if `content`
 *  isn't one (an ordinary typed message, for example). */
export function parseReferencePrompt(content: string): ParsedReference | null {
  return parseChat(content) ?? parseArtifact(content);
}
