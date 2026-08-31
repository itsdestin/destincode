// How a head-to-head record is worded (games spec §6.2).
//
// ONE module so the two places a record appears — the lobby row you pick an
// opponent from, and the card at the end of a match — can never word the same
// fact differently. A player who reads "4–2" in one place and "2–4" in the other
// has no way to tell which is wrong.
//
// EVERY NUMBER HERE IS FROM YOUR POINT OF VIEW. `wins` is YOUR wins. That is
// also how the Worker sends it, and it is the one thing that must not get
// flipped: a reversed record is not a cosmetic bug, it is the app telling your
// friend you beat them when they beat you.
//
// Deliberately NOT chess's "4–2–1" W–L–D notation. It is standard among chess
// players and opaque to everyone else, and this app is built for people who are
// not specialists in the thing they are looking at.

import type { HeadToHead } from '../../state/marketplace-api-client';

/** The terse form, for a list row where space is short: "4–2", or "4–2, 1 draw"
 *  when there have been draws. En dash, not a hyphen — it is a score, and the
 *  hyphen reads as a range or a minus sign at small sizes. */
export function recordLabel(r: HeadToHead): string {
  const base = `${r.wins}–${r.losses}`;
  if (r.draws === 0) return base;
  return `${base}, ${r.draws} draw${r.draws === 1 ? '' : 's'}`;
}

/** The sentence form, for the end of a match, where there is room to say what
 *  the numbers MEAN. `opponent` is the display name — the only place a name is
 *  the right thing to show, because you are looking at the person you just
 *  played. */
export function recordSentence(r: HeadToHead, opponent: string | null): string {
  const name = opponent?.trim();
  const draws = r.draws > 0 ? ` (${r.draws} draw${r.draws === 1 ? '' : 's'})` : '';
  if (r.wins > r.losses) return `You lead ${r.wins}–${r.losses}${draws}`;
  if (r.losses > r.wins) {
    // A name takes "leads"; the nameless fallback is "they", which takes
    // "lead". The display name can genuinely be missing for a moment after a
    // reconnect, and "They leads 5–2" is the kind of wrong that makes the whole
    // screen look unfinished.
    const lead = name ? `${name} leads` : 'They lead';
    return `${lead} ${r.losses}–${r.wins}${draws}`;
  }
  // Level. "All square" rather than "4–4" alone, so the line still reads as a
  // statement about the two of you rather than a bare pair of numbers.
  return `All square at ${r.wins}–${r.losses}${draws}`;
}

/** Index records by opponent so a list can look one up per row without scanning.
 *  Narrow to a game first — a record is always "at chess" or "at Connect 4",
 *  never a total across games, because winning at Connect 4 says nothing about
 *  who is better at chess. */
export function recordsByOpponent(records: HeadToHead[], game: string): Map<string, HeadToHead> {
  const out = new Map<string, HeadToHead>();
  for (const r of records) if (r.game === game) out.set(r.opponent_id, r);
  return out;
}
