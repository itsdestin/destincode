// desktop/tests/arcade-api.test.ts
import { describe, it, expect } from 'vitest';
import {
  buildStatuses, mergeBests, serverBests, staleNote, toRows,
} from '../src/renderer/components/game/arcade-api';
import { gameById } from '../src/renderer/components/game/game-registry';
import type { GameBoard } from '../src/renderer/state/marketplace-api-client';

// The arcade's data boundary (spec §6.1, §6.5, §6.6). Every function here is
// pure, which is the point: the two bugs this feature shipped and had to fix
// were both states that only occur in the real app — no server board, and a
// board that had never been fetched. A pure mapping can be HANDED those states
// on purpose instead of waiting to meet them.

const flappy = gameById('flappy')!;

describe('serverBests', () => {
  it('reduces the wire rows to plain numbers', () => {
    expect(serverBests({ flappy: { best: 31, best_at: 1, runs: 4 } })).toEqual({ flappy: 31 });
  });

  it('drops a score for a game this build does not have', () => {
    // A row left behind by a removed game is not something any screen can
    // render, so it must not reach one.
    const out = serverBests({
      flappy: { best: 31, best_at: 1, runs: 4 },
      'retired-game': { best: 999, best_at: 1, runs: 1 },
    });
    expect(out).toEqual({ flappy: 31 });
  });

  it('survives an empty answer and a malformed row', () => {
    expect(serverBests({})).toEqual({});
    expect(serverBests({ flappy: { best: 'lots' } as never })).toEqual({});
  });
});

describe('mergeBests — the one rule for "your best"', () => {
  it('takes the server number when you played on another device', () => {
    expect(mergeBests({ flappy: 58 }, { flappy: 31 })).toEqual({ flappy: 58 });
  });

  it('keeps this computer\'s number when the run has not been published', () => {
    // The offline case. Showing the smaller server number here would read to
    // the player as "it lost my score".
    expect(mergeBests({ flappy: 31 }, { flappy: 58 })).toEqual({ flappy: 58 });
  });

  it('accepts either side being absent', () => {
    expect(mergeBests({}, { flappy: 31 })).toEqual({ flappy: 31 });
    expect(mergeBests({ flappy: 31 }, {})).toEqual({ flappy: 31 });
    expect(mergeBests({}, {})).toEqual({});
  });

  it('never lowers a best you have already been shown', () => {
    // The property that matters, stated directly rather than by example.
    for (const [a, b] of [[0, 5], [5, 0], [7, 7], [12480, 9216]] as const) {
      expect(mergeBests({ flappy: a }, { flappy: b }).flappy).toBe(Math.max(a, b));
    }
  });
});

describe('buildStatuses — the picker\'s deciding fact', () => {
  it('words a solo best in the GAME\'s vocabulary, not the server\'s', () => {
    const out = buildStatuses({ bests: { flappy: 31 }, onlineNames: [] });
    // "31 pipes", not "31" — the format comes from game-registry.ts, which is
    // the whole reason scores cross the wire as raw numbers.
    expect(out.flappy!.bestScore).toBe(flappy.scoring!.format(31));
    expect(out.flappy!.bestScore).toContain('31');
  });

  it('says nothing rather than zero for a game never played', () => {
    const out = buildStatuses({ bests: {}, onlineNames: [] });
    expect(out.flappy).toEqual({});
    expect(out.flappy!.bestScore).toBeUndefined();
  });

  it('puts live presence on the versus tiles', () => {
    const out = buildStatuses({ bests: {}, onlineNames: ['Jake'] });
    expect(out['connect-four']!.friendsOnline).toEqual(['Jake']);
    expect(out['connect-four']!.unavailable).toBeUndefined();
  });

  it('an outage replaces the online list, and leaves solo alone', () => {
    // §4.2: the versus service being down must never take the solo games with
    // it, which is the single most important behaviour on this screen.
    const out = buildStatuses({
      bests: { flappy: 31 },
      onlineNames: ['Jake'],
      versusUnavailable: "Can't reach the game server",
    });
    expect(out['connect-four']!.unavailable).toBe("Can't reach the game server");
    expect(out['connect-four']!.friendsOnline).toBeUndefined();
    expect(out.flappy!.bestScore).toBe(flappy.scoring!.format(31));
  });

  it('covers every registered game, so no tile can render undefined', () => {
    const out = buildStatuses({ bests: {}, onlineNames: [] });
    for (const id of ['flappy', 'twenty-forty-eight', 'connect-four', 'chess']) {
      expect(out[id], `${id} has no status`).toBeDefined();
    }
  });
});

describe('toRows', () => {
  const board = (entries: GameBoard['entries']): GameBoard =>
    ({ game: 'flappy', you: entries.find((e) => e.is_you) ?? null, entries });

  const entry = (over: Partial<GameBoard['entries'][number]>) => ({
    id: 'x', display_name: 'X', handle: 'x', avatar_url: null,
    best_score: 1, best_at: 1, rank: 1, is_you: false, ...over,
  });

  it('keeps the server\'s order — rank is decided once, server-side', () => {
    const rows = toRows(board([
      entry({ id: 'mira', display_name: 'Mira', best_score: 58, rank: 1 }),
      entry({ id: 'you', display_name: 'You', best_score: 31, rank: 2, is_you: true }),
    ]), flappy);
    expect(rows.map((r) => r.accountId)).toEqual(['mira', 'you']);
    expect(rows[1]!.isYou).toBe(true);
  });

  it('words each score in the game\'s vocabulary', () => {
    const rows = toRows(board([entry({ best_score: 58 })]), flappy);
    expect(rows[0]!.score).toBe(flappy.scoring!.format(58));
  });

  it('returns nothing for an absent or empty board, never throws', () => {
    // The state that shipped a bug: no board at all. It must be a plain empty
    // list, because every screen downstream renders that correctly already.
    expect(toRows(null, flappy)).toEqual([]);
    expect(toRows(board([]), flappy)).toEqual([]);
    expect(toRows({ game: 'flappy', you: null } as never, flappy)).toEqual([]);
  });
});

describe('staleNote — says WHEN, never why', () => {
  const now = 1_000_000_000_000;

  it('is absent for a fresh board', () => {
    expect(staleNote(null, now)).toBeUndefined();
  });

  it('reads naturally at every scale', () => {
    expect(staleNote(now - 10_000, now)).toBe('Updated just now');
    expect(staleNote(now - 60_000, now)).toBe('Updated 1 minute ago');
    expect(staleNote(now - 4 * 60_000, now)).toBe('Updated 4 minutes ago');
    expect(staleNote(now - 60 * 60_000, now)).toBe('Updated 1 hour ago');
    expect(staleNote(now - 5 * 60 * 60_000, now)).toBe('Updated 5 hours ago');
  });

  it('never names a cause it has not verified', () => {
    for (const ago of [0, 30_000, 5 * 60_000, 3 * 3600_000]) {
      const note = staleNote(now - ago, now)!;
      expect(note).not.toMatch(/offline|network|error|failed|disconnect|down/i);
    }
  });

  it('does not go backwards if the clock jumps', () => {
    // A cached timestamp in the future would otherwise render "Updated -3
    // minutes ago". Clamped to zero.
    expect(staleNote(now + 60_000, now)).toBe('Updated just now');
  });
});
