// 2048 — the rules, and nothing else (spec §5.2).
//
// WHY this is a separate file from the component: everything here is a pure
// function of its arguments. No React, no DOM, no timers, and — the part that
// matters most — NO randomness of its own. Every new tile comes from an `Rng`
// the caller hands in, so a test can pass a scripted sequence and get the same
// board every single run, and a real game can pass `Math.random`.
//
// §7: there is no clock in this file. A run has no time limit, no countdown and
// no idle penalty, which is what lets you stop mid-move, look away, and lose
// nothing while the assistant works.

/** The board is 4x4. Row 0 is the top, column 0 is the left. */
export const SIZE = 4;

export type Direction = 'left' | 'right' | 'up' | 'down';

/** Returns a number in [0, 1). `Math.random` satisfies this; so does `seededRng`. */
export type Rng = () => number;

export interface Tile {
  /** Stable for the life of a tile. The renderer keys on it so a tile that
   *  slides keeps its DOM node and can animate; a new id means a new element. */
  id: number;
  value: number;
  row: number;
  col: number;
  /** Set on the tile PRODUCED by a merge in the move that just happened. */
  merged?: boolean;
  /** Set on a tile that appeared in the move that just happened. */
  spawned?: boolean;
}

export interface Game {
  /** Every tile on the board right now. Never two tiles on one square. */
  tiles: Tile[];
  /** Tiles that were SWALLOWED by the move that just happened, already carrying
   *  the square they were swallowed on. They are not on the board any more —
   *  they exist so the renderer can slide them under the merged tile and fade
   *  them out. Replaced wholesale by the next move; ignore them for rules. */
  ghosts: Tile[];
  score: number;
  /** Counts moves that actually changed the board. A blocked press is not one. */
  moves: number;
  /** True when no slide in any of the four directions would change anything. */
  over: boolean;
  /** True once a 2048 tile has existed. The run does NOT stop — reaching 2048
   *  is a milestone, and stopping the board there would throw away a score. */
  won: boolean;
  /** The id the next spawned tile will take. Kept in state so the whole game is
   *  one plain value that can be copied, compared, or restored. */
  nextId: number;
}

/** A small deterministic generator (mulberry32), so a run can be replayed from
 *  a seed. Exists for tests and for "replay this game" — never used by default,
 *  because a real game should be unpredictable. */
export function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const at = (row: number, col: number) => row * SIZE + col;

/** Every square of one line, ordered from the edge the tiles are sliding TOWARD
 *  inward. Writing the four directions as "which order do I walk the squares"
 *  means the slide/merge logic below is written once, not four times — the
 *  usual place a 2048 bug hides is the fourth copy nobody re-read. */
function lines(dir: Direction): { row: number; col: number }[][] {
  const out: { row: number; col: number }[][] = [];
  for (let a = 0; a < SIZE; a++) {
    const line: { row: number; col: number }[] = [];
    for (let b = 0; b < SIZE; b++) {
      if (dir === 'left') line.push({ row: a, col: b });
      else if (dir === 'right') line.push({ row: a, col: SIZE - 1 - b });
      else if (dir === 'up') line.push({ row: b, col: a });
      else line.push({ row: SIZE - 1 - b, col: a });
    }
    out.push(line);
  }
  return out;
}

/** Puts one new tile on a random empty square: a 2 nine times out of ten, a 4
 *  otherwise — the standard 2048 mix. Draws from the rng TWICE and always in
 *  this order (square first, then value), so a scripted rng in a test reads in
 *  the same order the code runs. */
function spawn(tiles: Tile[], nextId: number, rng: Rng): { tiles: Tile[]; nextId: number } {
  const taken = new Set(tiles.map((t) => at(t.row, t.col)));
  const empty: { row: number; col: number }[] = [];
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) if (!taken.has(at(row, col))) empty.push({ row, col });
  }
  if (empty.length === 0) return { tiles, nextId };
  // Clamped because a caller's rng is not ours: a stub that returns exactly 1
  // would otherwise index one past the end and put a tile at `undefined`.
  const pick = empty[Math.min(empty.length - 1, Math.floor(rng() * empty.length))]!;
  const value = rng() < 0.1 ? 4 : 2;
  return {
    tiles: [...tiles, { id: nextId, value, row: pick.row, col: pick.col, spawned: true }],
    nextId: nextId + 1,
  };
}

/** True when at least one of the four slides would change something. A full
 *  board is NOT automatically over — two equal neighbours can still merge. */
export function hasMove(tiles: Tile[]): boolean {
  if (tiles.length < SIZE * SIZE) return true;
  const grid = new Map<number, number>();
  for (const t of tiles) grid.set(at(t.row, t.col), t.value);
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const v = grid.get(at(row, col));
      if (v === undefined) return true;
      if (col + 1 < SIZE && grid.get(at(row, col + 1)) === v) return true;
      if (row + 1 < SIZE && grid.get(at(row + 1, col)) === v) return true;
    }
  }
  return false;
}

/** A fresh board: two tiles, score zero. */
export function createGame(rng: Rng): Game {
  let tiles: Tile[] = [];
  let nextId = 1;
  for (let i = 0; i < 2; i++) {
    const s = spawn(tiles, nextId, rng);
    tiles = s.tiles;
    nextId = s.nextId;
  }
  return { tiles, ghosts: [], score: 0, moves: 0, over: false, won: false, nextId };
}

/**
 * Slide (and merge) every tile one direction.
 *
 * `moved` is false when the press changed nothing — a wall of tiles pushed into
 * the wall they are already against. In that case the RETURNED GAME IS THE ONE
 * PASSED IN, unchanged: no tile spawns and the move counter does not tick.
 * Getting this wrong is the classic 2048 bug — pressing into a wall would hand
 * the player free tiles until the board choked.
 */
export function move(game: Game, dir: Direction, rng: Rng): { game: Game; moved: boolean } {
  const occupied = new Map<number, Tile>();
  for (const t of game.tiles) occupied.set(at(t.row, t.col), t);

  const next: Tile[] = [];
  const ghosts: Tile[] = [];
  let score = game.score;
  let changed = false;

  for (const line of lines(dir)) {
    // The line's tiles, in the order they will be packed against the edge.
    const present: Tile[] = [];
    for (const sq of line) {
      const t = occupied.get(at(sq.row, sq.col));
      if (t) present.push(t);
    }

    let slot = 0;
    for (let i = 0; i < present.length; i++) {
      const a = present[i]!;
      const b = present[i + 1];
      const dest = line[slot]!;

      if (b && b.value === a.value) {
        // A merge consumes BOTH tiles and produces one new value. `i++` here is
        // the whole reason [2,2,2,2] slides to [4,4] and not to [8]: the tile
        // just produced is skipped over, so it cannot merge again this move.
        const value = a.value * 2;
        score += value; // the score is the sum of every tile ever made by merging
        next.push({ id: a.id, value, row: dest.row, col: dest.col, merged: true });
        // The swallowed tile keeps its own id and travels to the same square, so
        // the renderer can slide it there before it disappears.
        ghosts.push({ id: b.id, value: b.value, row: dest.row, col: dest.col });
        i++;
        changed = true;
      } else {
        if (a.row !== dest.row || a.col !== dest.col) changed = true;
        next.push({ id: a.id, value: a.value, row: dest.row, col: dest.col });
      }
      slot++;
    }
  }

  if (!changed) return { game, moved: false };

  const spawned = spawn(next, game.nextId, rng);
  return {
    game: {
      tiles: spawned.tiles,
      ghosts,
      score,
      moves: game.moves + 1,
      over: !hasMove(spawned.tiles),
      won: game.won || spawned.tiles.some((t) => t.value >= 2048),
      nextId: spawned.nextId,
    },
    moved: true,
  };
}
