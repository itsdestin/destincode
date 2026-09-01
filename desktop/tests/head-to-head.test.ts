import { describe, it, expect } from 'vitest';
import { recordAria, recordLabel, recordSentence, recordsByOpponent } from '../src/renderer/components/game/head-to-head';
import type { HeadToHead } from '../src/renderer/state/marketplace-api-client';

// Wording a head-to-head record (games spec §6.2). The stakes are higher than
// they look: this is the app making a claim ABOUT ANOTHER PERSON, on a screen
// they can also see. A flipped record tells your friend you beat them when they
// beat you, and there is no way for either of you to tell which side is wrong.

const rec = (over: Partial<HeadToHead> = {}): HeadToHead => ({
  opponent_id: 'jake', game: 'chess', wins: 4, losses: 2, draws: 0,
  last_played_at: 1756600000, ...over,
});

describe('recordLabel — the terse form', () => {
  it('labels each number, so it cannot be read backwards', () => {
    // Destin's call (deck H-1). "4–2" relies on knowing YOUR number comes
    // first, and read the wrong way round it is still a plausible record — so
    // nothing tips the reader off. The letters ARE the labels.
    expect(recordLabel(rec({ wins: 4, losses: 2 }))).toBe('4W - 2L');
  });

  it('is not symmetric — reversing the record reverses the label', () => {
    // The property that matters. If this ever passes for both orders, the
    // function has stopped distinguishing winner from loser.
    expect(recordLabel(rec({ wins: 4, losses: 2 })))
      .not.toBe(recordLabel(rec({ wins: 2, losses: 4 })));
    expect(recordLabel(rec({ wins: 2, losses: 4 }))).toBe('2W - 4L');
  });

  it('mentions draws only when there are some', () => {
    expect(recordLabel(rec({ draws: 0 }))).toBe('4W - 2L');
    expect(recordLabel(rec({ draws: 1 }))).toBe('4W - 2L - 1D');
    expect(recordLabel(rec({ draws: 3 }))).toBe('4W - 2L - 3D');
  });

  it('handles a first-ever result without reading as an error', () => {
    expect(recordLabel(rec({ wins: 1, losses: 0, draws: 0 }))).toBe('1W - 0L');
    expect(recordLabel(rec({ wins: 0, losses: 1, draws: 0 }))).toBe('0W - 1L');
  });
});

describe('recordAria — the same record, spoken', () => {
  it('spells it out, because "4W - 2L" is read as letters', () => {
    expect(recordAria(rec({ wins: 4, losses: 2 }))).toBe('4 wins, 2 losses');
  });

  it('gets the singulars right', () => {
    expect(recordAria(rec({ wins: 1, losses: 1, draws: 1 }))).toBe('1 win, 1 loss, 1 draw');
    expect(recordAria(rec({ wins: 0, losses: 2, draws: 2 }))).toBe('0 wins, 2 losses, 2 draws');
  });

  it('leaves draws out when there are none', () => {
    expect(recordAria(rec({ draws: 0 }))).not.toContain('draw');
  });
});

describe('recordSentence — the end-of-match form', () => {
  it('says who is ahead, in plain words', () => {
    expect(recordSentence(rec({ wins: 5, losses: 2 }), 'Jake')).toBe('You lead 5–2');
    expect(recordSentence(rec({ wins: 2, losses: 5 }), 'Jake')).toBe('Jake leads 5–2');
  });

  it('always states the leader\'s score first, whoever leads', () => {
    // "Jake leads 2–5" would be wrong in the way nobody notices until a friend
    // points at the screen.
    expect(recordSentence(rec({ wins: 1, losses: 7 }), 'Mira')).toBe('Mira leads 7–1');
  });

  it('has a form for level', () => {
    expect(recordSentence(rec({ wins: 4, losses: 4 }), 'Jake')).toBe('All square at 4–4');
    expect(recordSentence(rec({ wins: 0, losses: 0, draws: 2 }), 'Jake')).toBe('All square at 0–0 (2 draws)');
  });

  it('carries draws without letting them change who leads', () => {
    expect(recordSentence(rec({ wins: 5, losses: 2, draws: 1 }), 'Jake')).toBe('You lead 5–2 (1 draw)');
  });

  it('falls back to a name-less sentence that is still grammatical', () => {
    // The display name can be missing for a moment after a reconnect. Both the
    // empty gap ("  leads 5–2") and the mismatched verb ("They leads") make the
    // screen look unfinished.
    expect(recordSentence(rec({ wins: 2, losses: 5 }), null)).toBe('They lead 5–2');
    expect(recordSentence(rec({ wins: 2, losses: 5 }), '   ')).toBe('They lead 5–2');
    expect(recordSentence(rec({ wins: 2, losses: 5 }), '')).not.toMatch(/^\s/);
  });
});

describe('recordsByOpponent', () => {
  const all: HeadToHead[] = [
    rec({ opponent_id: 'jake', game: 'chess', wins: 4, losses: 2 }),
    rec({ opponent_id: 'jake', game: 'connect-four', wins: 1, losses: 0 }),
    rec({ opponent_id: 'mira', game: 'chess', wins: 0, losses: 3 }),
  ];

  it('keeps one game apart from another', () => {
    // Winning at Connect 4 says nothing about who is better at chess, so a
    // combined total would be a number that means nothing.
    const chess = recordsByOpponent(all, 'chess');
    expect(chess.get('jake')!.wins).toBe(4);
    expect(chess.get('mira')!.losses).toBe(3);
    expect(recordsByOpponent(all, 'connect-four').get('jake')!.wins).toBe(1);
  });

  it('has no entry for someone you have never finished a game against', () => {
    expect(recordsByOpponent(all, 'chess').has('nobody')).toBe(false);
    expect(recordsByOpponent([], 'chess').size).toBe(0);
  });
});
