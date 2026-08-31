// desktop/tests/twenty-forty-eight.test.ts
//
// The 2048 rules, which are the part of that game everybody gets subtly wrong.
// Every case here is a rule a player would notice being broken within a minute
// of playing — a row that merges twice, a wall press that gifts a free tile, a
// board that declares itself dead while a merge is still on it.
//
// Nothing here touches React or the DOM: the rules module is pure and takes its
// randomness as an argument, so every board below is exact rather than likely.

import { describe, it, expect } from 'vitest';
import {
  SIZE, createGame, hasMove, move, seededRng,
  type Direction, type Game, type Tile,
} from '../src/renderer/components/game/twenty-forty-eight';

// ── helpers ─────────────────────────────────────────────────────────────────

/** Build a board from a picture of it. 0 is an empty square. */
function fromRows(rows: number[][], score = 0): Game {
  const tiles: Tile[] = [];
  let id = 1;
  rows.forEach((row, r) => row.forEach((value, c) => {
    if (value) tiles.push({ id: id++, value, row: r, col: c });
  }));
  return { tiles, ghosts: [], score, moves: 0, over: !hasMove(tiles), won: false, nextId: id };
}

/** The board as a picture again — but WITHOUT the tile the move spawned, so a
 *  test can assert the slide itself without predicting where the new tile went. */
function rowsOf(game: Game, includeSpawned = false): number[][] {
  const grid = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  for (const t of game.tiles) {
    if (t.spawned && !includeSpawned) continue;
    grid[t.row][t.col] = t.value;
  }
  return grid;
}

/** An rng that always drops the new tile on the LAST empty square and always
 *  makes it a 2. Deterministic on purpose: `move` draws the square first and
 *  the value second, so this returns 0.99 (last square) then 0.5 (>= 0.1, so a
 *  2 rather than a 4). */
function cornerRng(): () => number {
  let n = 0;
  return () => (n++ % 2 === 0 ? 0.99 : 0.5);
}

const EMPTY_ROW = [0, 0, 0, 0];

// ── the merge rule ──────────────────────────────────────────────────────────

describe('sliding and merging', () => {
  it('merges each tile at most once per move: [2,2,2,2] left is [4,4], never [8]', () => {
    const g = fromRows([[2, 2, 2, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    const { game, moved } = move(g, 'left', cornerRng());

    expect(moved).toBe(true);
    expect(rowsOf(game)[0]).toEqual([4, 4, 0, 0]);
    // Two merges of two 2s: 4 + 4.
    expect(game.score).toBe(8);
  });

  it('merges the pair nearest the wall first: [2,2,4] left is [4,4]', () => {
    const g = fromRows([[2, 2, 4, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    const { game } = move(g, 'left', cornerRng());

    expect(rowsOf(game)[0]).toEqual([4, 4, 0, 0]);
    expect(game.score).toBe(4);
  });

  it('does not chain a merge into the tile it just made: [4,4,8] left is [8,8]', () => {
    const g = fromRows([[4, 4, 8, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    const { game } = move(g, 'left', cornerRng());

    expect(rowsOf(game)[0]).toEqual([8, 8, 0, 0]);
    expect(game.score).toBe(8);
  });

  it('leaves an unequal pair alone: [2,4,2,4] left does not move or merge', () => {
    const g = fromRows([[2, 4, 2, 4], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    const { moved } = move(g, 'left', cornerRng());
    expect(moved).toBe(false);
  });

  it('closes gaps without merging unequal neighbours', () => {
    const g = fromRows([[0, 2, 0, 4], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    const { game } = move(g, 'left', cornerRng());
    expect(rowsOf(game)[0]).toEqual([2, 4, 0, 0]);
    expect(game.score).toBe(0);
  });
});

describe('all four directions', () => {
  // The usual place a 2048 bug hides is the fourth copy of the slide loop, so
  // the same row is checked through each direction.
  const cases: { dir: Direction; expected: number[][] }[] = [
    { dir: 'left', expected: [[4, 4, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW] },
    { dir: 'right', expected: [[0, 0, 4, 4], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW] },
  ];
  for (const { dir, expected } of cases) {
    it(`packs a full row ${dir}`, () => {
      const g = fromRows([[2, 2, 2, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
      expect(rowsOf(move(g, dir, cornerRng()).game)).toEqual(expected);
    });
  }

  it('packs a full column up', () => {
    const g = fromRows([[2, 0, 0, 0], [2, 0, 0, 0], [2, 0, 0, 0], [2, 0, 0, 0]]);
    const { game } = move(g, 'up', cornerRng());
    expect(rowsOf(game).map((r) => r[0])).toEqual([4, 4, 0, 0]);
    expect(game.score).toBe(8);
  });

  it('packs a full column down', () => {
    const g = fromRows([[2, 0, 0, 0], [2, 0, 0, 0], [2, 0, 0, 0], [2, 0, 0, 0]]);
    const { game } = move(g, 'down', cornerRng());
    expect(rowsOf(game).map((r) => r[0])).toEqual([0, 0, 4, 4]);
  });
});

// ── the blocked press ───────────────────────────────────────────────────────

describe('a move that changes nothing', () => {
  // Packed against the LEFT wall with no equal neighbours: nothing can move
  // left, everything can move right. NOTE it is deliberately not a full row —
  // a full row of four distinct values is immovable in BOTH directions, which
  // would make the last case in this block impossible rather than meaningful.
  const packed = () => fromRows([[2, 4, 8, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);

  it('does not spawn a tile', () => {
    const g = packed();
    const before = g.tiles.length;
    const { game } = move(g, 'left', cornerRng());
    expect(game.tiles.length).toBe(before);
  });

  it('does not count as a move, and reports moved: false', () => {
    const g = packed();
    const { game, moved } = move(g, 'left', cornerRng());
    expect(moved).toBe(false);
    expect(game.moves).toBe(0);
  });

  it('hands back the very same game object', () => {
    // Identity, not just equality: the renderer re-renders on a new object, so
    // a blocked press must not produce one.
    const g = packed();
    expect(move(g, 'left', cornerRng()).game).toBe(g);
  });

  it('still moves that same row the other way', () => {
    // The proof that the refusal above is about THIS row against THAT wall, and
    // not the engine having quietly stopped moving anything.
    const g = packed();
    const { moved, game } = move(g, 'right', cornerRng());
    expect(moved).toBe(true);
    expect(rowsOf(game)[0]).toEqual([0, 2, 4, 8]);
    expect(game.tiles.filter((t) => t.spawned).length).toBe(1);
  });
});

// ── score ───────────────────────────────────────────────────────────────────

describe('score', () => {
  it('adds the value of the tile each merge PRODUCES', () => {
    const g = fromRows([[8, 8, 0, 0], [2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW]);
    const { game } = move(g, 'left', cornerRng());
    // 8+8 makes a 16, 2+2 makes a 4 → 20, not 10 (the inputs) and not 40.
    expect(game.score).toBe(20);
  });

  it('never moves on a slide with no merge', () => {
    const g = fromRows([[0, 0, 2, 4], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW], 100);
    expect(move(g, 'left', cornerRng()).game.score).toBe(100);
  });

  it('accumulates across moves', () => {
    let g = fromRows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    g = move(g, 'left', cornerRng()).game;   // +4
    expect(g.score).toBe(4);
    g = fromRows([[4, 4, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW], g.score);
    g = move(g, 'left', cornerRng()).game;   // +8
    expect(g.score).toBe(12);
  });
});

// ── game over ───────────────────────────────────────────────────────────────

describe('game over', () => {
  it('is false on a FULL board that still has an adjacent equal pair', () => {
    // Full, no empty square anywhere — but the two 2s at the end of row 0 can
    // still merge, so the run is alive. Calling this over is the bug.
    const rows = [
      [4, 8, 2, 2],
      [8, 4, 8, 4],
      [4, 8, 4, 8],
      [8, 4, 8, 4],
    ];
    expect(hasMove(fromRows(rows).tiles)).toBe(true);
    expect(fromRows(rows).over).toBe(false);
    expect(move(fromRows(rows), 'left', cornerRng()).moved).toBe(true);
  });

  it('is false whenever a square is empty', () => {
    const rows = [
      [4, 8, 2, 16],
      [8, 4, 8, 4],
      [4, 8, 4, 8],
      [8, 4, 8, 0],
    ];
    expect(hasMove(fromRows(rows).tiles)).toBe(true);
  });

  it('is true only when no direction would change anything', () => {
    const rows = [
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 4, 2],
    ];
    const g = fromRows(rows);
    expect(hasMove(g.tiles)).toBe(false);
    expect(g.over).toBe(true);
    // And prove it the long way, through the rules the player actually uses.
    for (const dir of ['left', 'right', 'up', 'down'] as Direction[]) {
      expect(move(g, dir, cornerRng()).moved, dir).toBe(false);
    }
  });

  it('is set by the move that fills the last square', () => {
    // One empty square, at (3,2). Sliding left drags the 4 at (3,3) into it —
    // a real move, no merge — which leaves (3,3) as the only empty square. The
    // injected rng then drops a 2 there, and THAT completes a checkerboard with
    // no equal neighbours in any direction: dead.
    const rows = [
      [2, 4, 2, 4],
      [4, 2, 4, 2],
      [2, 4, 2, 4],
      [4, 2, 0, 4],
    ];
    const g = fromRows(rows);
    expect(g.over).toBe(false);
    const { game, moved } = move(g, 'left', cornerRng());
    expect(moved).toBe(true);
    expect(game.tiles.length).toBe(SIZE * SIZE);
    expect(game.over).toBe(true);
  });
});

// ── spawning ────────────────────────────────────────────────────────────────

describe('spawning', () => {
  it('adds exactly one tile per real move, marked as spawned', () => {
    const g = fromRows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    const { game } = move(g, 'left', cornerRng());
    const fresh = game.tiles.filter((t) => t.spawned);
    expect(fresh.length).toBe(1);
    expect([2, 4]).toContain(fresh[0].value);
  });

  it('puts the new tile where the injected rng says, so a test can predict it', () => {
    const g = fromRows([[2, 2, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    // First draw 0 = the FIRST empty square in row-major order. After [2,2]
    // merges into one 4 at (0,0), the first empty square is (0,1).
    const firstSquare = () => 0;
    const { game } = move(g, 'left', firstSquare);
    const fresh = game.tiles.find((t) => t.spawned)!;
    expect([fresh.row, fresh.col]).toEqual([0, 1]);
    expect(fresh.value).toBe(4); // second draw is also 0, and 0 < 0.1 → a 4
  });

  it('gives ids that are never reused, so the renderer can key on them', () => {
    let g = createGame(seededRng(7));
    const seen = new Set(g.tiles.map((t) => t.id));
    for (let i = 0; i < 30 && !g.over; i++) {
      const dir = (['left', 'up', 'right', 'down'] as Direction[])[i % 4];
      const r = move(g, dir, seededRng(i + 1));
      // A blocked press returns the previous game untouched — including the
      // `spawned` flag on the tile the LAST real move added. Re-counting that
      // tile is not an id being reused; it is the same tile, twice.
      if (!r.moved) continue;
      g = r.game;
      for (const t of g.tiles) {
        if (t.spawned) {
          expect(seen.has(t.id), `id ${t.id} reused`).toBe(false);
          seen.add(t.id);
        }
      }
    }
  });

  it('is reproducible from a seed', () => {
    const a = createGame(seededRng(42));
    const b = createGame(seededRng(42));
    expect(rowsOf(a, true)).toEqual(rowsOf(b, true));
  });
});

describe('a new game', () => {
  it('starts with two tiles, no score, and is not over', () => {
    const g = createGame(seededRng(1));
    expect(g.tiles.length).toBe(2);
    expect(g.score).toBe(0);
    expect(g.moves).toBe(0);
    expect(g.over).toBe(false);
    expect(g.won).toBe(false);
  });

  it('only ever opens with 2s and 4s', () => {
    for (let seed = 0; seed < 50; seed++) {
      for (const t of createGame(seededRng(seed)).tiles) expect([2, 4]).toContain(t.value);
    }
  });
});

// ── what the renderer needs ─────────────────────────────────────────────────

describe('animation data', () => {
  it('reports the swallowed tile at the square it was swallowed on', () => {
    const g = fromRows([[2, 0, 0, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    const { game } = move(g, 'left', cornerRng());
    expect(game.ghosts.length).toBe(1);
    expect([game.ghosts[0].row, game.ghosts[0].col]).toEqual([0, 0]);
    // The ghost keeps its own id — that is what lets it slide rather than blink.
    expect(game.tiles.some((t) => t.id === game.ghosts[0].id)).toBe(false);
  });

  it('clears the previous move\'s ghosts', () => {
    let g = fromRows([[2, 0, 0, 2], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    g = move(g, 'left', cornerRng()).game;          // the two 2s merge -> one ghost
    expect(g.ghosts.length).toBe(1);
    // The second move must SLIDE without merging, or the ghost it finds is a
    // fresh one and the test proves nothing about clearing.
    g = move(g, 'right', cornerRng()).game;
    expect(g.ghosts.length).toBe(0);
  });

  it('marks the merged tile, and only the merged tile', () => {
    const g = fromRows([[2, 2, 0, 0], [8, 0, 0, 0], EMPTY_ROW, EMPTY_ROW]);
    const { game } = move(g, 'left', cornerRng());
    const merged = game.tiles.filter((t) => t.merged);
    expect(merged.length).toBe(1);
    expect(merged[0].value).toBe(4);
  });
});

describe('winning', () => {
  it('flags 2048 without ending the run', () => {
    const g = fromRows([[1024, 1024, 0, 0], EMPTY_ROW, EMPTY_ROW, EMPTY_ROW]);
    const { game } = move(g, 'left', cornerRng());
    expect(game.won).toBe(true);
    expect(game.over).toBe(false);
    expect(game.score).toBe(2048);
  });
});
