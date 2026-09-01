// Flappy — the pure simulation (spec §5.1).
//
// WHY THIS FILE HAS NO REACT AND NO DOM: the rules of the game (gravity, the
// flap impulse, where pipes appear, what counts as a crash, what counts as a
// point) are the part that has to be RIGHT, and the only way to prove it is
// right is to run it in a test with no browser attached. Everything visual —
// the mascot, the pipes, the scrolling ground — lives in FlappyGame.tsx and
// reads this file's numbers. Nothing here knows what a pixel is.
//
// COORDINATES. The world is a fixed logical box, `WORLD_W` × `WORLD_H` "units"
// wide and tall, with y growing DOWNWARD (0 = ceiling) so it matches how the
// screen is laid out. The component scales that box to whatever size the pane
// has been dragged to, which is what makes the game play EXACTLY the same at
// a 320px pane and a 900px one — the leaderboard (§6) would be meaningless if
// a wider pane gave you more warning before each pipe.
//
// PURITY. Every function returns a NEW state and mutates nothing, including
// the random-number generator: the generator's position is carried in the
// state as `rngSeed`. That is what makes a run reproducible from a seed —
// give it the same seed and the same sequence of flaps and you get the same
// run, every time, which is the only reason the tests can be non-flaky.

// ── The tunable rules ───────────────────────────────────────────────────────

export interface FlappyConfig {
  /** Downward acceleration, units/second². */
  gravity: number;
  /** Instant upward speed a flap sets, units/second (negative = upward). */
  flapVelocity: number;
  /** Fastest the bird may ever fall, units/second. */
  maxFallSpeed: number;
  /** Horizontal speed of the world at score 0, units/second. */
  scrollSpeed: number;
  /** Added to `scrollSpeed` for each pipe cleared… */
  scrollSpeedPerPipe: number;
  /** …up to this much extra, so it ramps and then stops. */
  scrollSpeedMaxBonus: number;
  /** Pipe column width, units. */
  pipeWidth: number;
  /** Height of the hole between the two halves of a pipe, units. */
  pipeGap: number;
  /** Distance from one pipe to the next, units. */
  pipeSpacing: number;
  /** How far off the right edge the FIRST pipe starts — the grace period. */
  firstPipeOffset: number;
  /** Closest a gap edge may come to the ceiling or the ground, units. */
  gapMargin: number;
  /** Most a gap may move vertically from the previous one, units. */
  gapMaxDelta: number;
  /** Half-width/half-height of the bird's COLLISION box, units. Deliberately
   *  smaller than the drawn mascot — a near-miss that clips the mascot's ear
   *  should not end the run (every flappy game does this). */
  birdHitRadius: number;
  /** Longest slice of real time a single `step` will simulate, ms. A tab that
   *  was backgrounded for a minute comes back with a huge delta; without this
   *  clamp the bird would move hundreds of units in one go and teleport
   *  straight through a pipe instead of hitting it. */
  maxStepMs: number;
  /** The FIXED size of one physics tick, ms. `step` banks whatever real time
   *  it is handed and spends it one whole tick at a time, so a 30fps machine
   *  and a 240fps machine run byte-identical physics — which is what makes a
   *  shared leaderboard (§6) mean anything. */
  subStepMs: number;
}

/** The world box, in units. Fixed on purpose — see the COORDINATES note. */
export const WORLD_W = 100;
export const WORLD_H = 125;
/** Height of the solid ground strip along the bottom, in units. */
export const GROUND_H = 12;
/** The bird never moves horizontally; the world moves past it. */
export const BIRD_X = 30;
/** Half the size of the DRAWN mascot, units (the collision box is smaller). */
export const BIRD_DRAW_RADIUS = 6.5;

/** The ceiling of the playable band (0) and its floor. */
export const FLOOR_Y = WORLD_H - GROUND_H;

export const FLAPPY_DEFAULTS: FlappyConfig = {
  // A flap lifts about 19 units (15% of the screen) and tops out after ~0.27s,
  // so a single tap is a clearly readable hop rather than a jump to the
  // ceiling, and the fall back down is quick enough to feel responsive.
  // (rise = flapVelocity² / (2 × gravity) = 140² / 1040 ≈ 18.8)
  gravity: 520,
  flapVelocity: -140,
  maxFallSpeed: 300,
  // 52 units/s past a 62-unit spacing = a pipe roughly every 1.2 seconds.
  scrollSpeed: 52,
  // +0.6 per pipe, capped at +18: the game is ~35% faster by pipe 30 and then
  // stops getting faster, so a good run ends because you slipped, not because
  // the game became physically impossible.
  scrollSpeedPerPipe: 0.6,
  scrollSpeedMaxBonus: 18,
  pipeWidth: 14,
  // The gap is 38 units against a 9.2-unit-tall COLLISION box — a shade over
  // four bird-heights, which is where the original sits. Tuned against the
  // flap: one flap lifts 18.8 units and the safe band inside a gap is
  // 38 − 9.2 = 28.8, so a single tap fits inside a gap with room either side.
  // Any tighter and one tap overshoots the hole, which is unplayable rather
  // than merely hard.
  pipeGap: 38,
  pipeSpacing: 62,
  firstPipeOffset: 30,
  gapMargin: 8,
  // Capping how far a gap may jump from the last one stops the generator from
  // producing a ceiling-then-floor pair that no reaction time can clear. There
  // are 48 units of clear air between pipes (spacing − width) ≈ 0.9s, which is
  // about two flaps' worth of climb — so 28 is what is actually reachable.
  gapMaxDelta: 28,
  birdHitRadius: 4.6,
  maxStepMs: 50,
  subStepMs: 16,
};

// ── State ───────────────────────────────────────────────────────────────────

export type FlappyStatus = 'ready' | 'flying' | 'dead';
export type DeathCause = 'pipe' | 'ground' | 'ceiling';

export interface Pipe {
  /** Stable id, so the renderer can tell a new pipe from a moved one. */
  id: number;
  /** Left edge, in units. Decreases as the world scrolls. */
  x: number;
  /** Centre of the hole, in units from the ceiling. */
  gapY: number;
  /** Set the moment the bird passes this pipe — the guard that makes a pipe
   *  worth exactly one point no matter how many frames it takes to pass it. */
  scored: boolean;
}

export interface FlappyState {
  status: FlappyStatus;
  /** Bird centre, units from the ceiling. */
  birdY: number;
  /** Bird vertical speed, units/second. Negative = rising. */
  birdV: number;
  pipes: Pipe[];
  score: number;
  /** Why the run ended, or null while it is still going. */
  deathCause: DeathCause | null;
  /** True once a dead bird has finished falling and is lying on the ground —
   *  the cue for the mascot's `dizzy` face. */
  grounded: boolean;
  /** Simulated time since the run started, ms. Not wall-clock. */
  elapsedMs: number;
  /** How far the world has scrolled, in units. The renderer's scrolling ground
   *  reads this instead of keeping its own clock, so the ground can never
   *  drift out of step with the pipes sliding along it. */
  distance: number;
  /** Real time handed to `step` that was not yet a whole physics tick. Banked
   *  here rather than discarded, so no motion is lost between frames. */
  carryMs: number;
  /** The random generator's position. Part of the state so the whole run is
   *  reproducible and nothing in here reads a global. */
  rngSeed: number;
  nextPipeId: number;
}

// ── Seeded randomness (mulberry32) ──────────────────────────────────────────
//
// WHY NOT Math.random: a test cannot assert anything about a run it cannot
// reproduce. This is a tiny, well-known generator; the point is not
// statistical quality, it is that seed N always produces run N.
function nextRandom(seed: number): { value: number; seed: number } {
  const next = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(next ^ (next >>> 15), 1 | next);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, seed: next };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Pick the next gap centre: uniform inside the playable band, then pulled
 *  back so it is never more than `gapMaxDelta` from the previous gap. */
function nextGapY(
  seed: number,
  previousGapY: number | null,
  cfg: FlappyConfig,
): { gapY: number; seed: number } {
  const half = cfg.pipeGap / 2;
  const lo = half + cfg.gapMargin;
  const hi = FLOOR_Y - half - cfg.gapMargin;
  const r = nextRandom(seed);
  let gapY = lo + r.value * (hi - lo);
  if (previousGapY !== null) {
    gapY = clamp(gapY, previousGapY - cfg.gapMaxDelta, previousGapY + cfg.gapMaxDelta);
  }
  return { gapY: clamp(gapY, lo, hi), seed: r.seed };
}

/** A fresh run, parked at 'ready' — nothing moves until the first flap. */
export function createFlappyState(seed: number, cfg: FlappyConfig = FLAPPY_DEFAULTS): FlappyState {
  const base: FlappyState = {
    status: 'ready',
    // Start in the middle of the playable band, not the middle of the box —
    // the ground eats the bottom 12 units.
    birdY: FLOOR_Y / 2,
    birdV: 0,
    pipes: [],
    score: 0,
    deathCause: null,
    grounded: false,
    elapsedMs: 0,
    distance: 0,
    carryMs: 0,
    // `| 0` so a float or a huge seed still lands somewhere the generator
    // understands, rather than silently degenerating.
    rngSeed: seed | 0,
    nextPipeId: 1,
  };
  // Fill the queue up front so the first pipe is already on its way in and the
  // player can see what is coming before they commit to a flap.
  return spawnPipes(base, cfg);
}

/** Current world speed, including the per-pipe ramp. */
export function scrollSpeedFor(score: number, cfg: FlappyConfig = FLAPPY_DEFAULTS): number {
  return cfg.scrollSpeed + Math.min(score * cfg.scrollSpeedPerPipe, cfg.scrollSpeedMaxBonus);
}

/** Add pipes until the queue reaches past the right edge. Pure. */
function spawnPipes(s: FlappyState, cfg: FlappyConfig): FlappyState {
  const pipes = s.pipes.slice();
  let seed = s.rngSeed;
  let nextPipeId = s.nextPipeId;
  // Keep at least one pipe queued beyond the right edge so nothing ever pops
  // into existence inside the visible area.
  const needUntil = WORLD_W + cfg.pipeSpacing;
  let lastX = pipes.length ? pipes[pipes.length - 1]!.x : WORLD_W + cfg.firstPipeOffset - cfg.pipeSpacing;
  let lastGapY = pipes.length ? pipes[pipes.length - 1]!.gapY : null;
  while (lastX < needUntil) {
    const x = lastX + cfg.pipeSpacing;
    const g = nextGapY(seed, lastGapY, cfg);
    seed = g.seed;
    pipes.push({ id: nextPipeId++, x, gapY: g.gapY, scored: false });
    lastX = x;
    lastGapY = g.gapY;
  }
  if (pipes.length === s.pipes.length) return s;
  return { ...s, pipes, rngSeed: seed, nextPipeId };
}

/** The player's only input. Ignored once the run is over. */
export function flap(s: FlappyState, cfg: FlappyConfig = FLAPPY_DEFAULTS): FlappyState {
  if (s.status === 'dead') return s;
  return { ...s, status: 'flying', birdV: cfg.flapVelocity };
}

/**
 * Advance the simulation by `dtMs` of real time.
 *
 * Two safety measures, both about frame rate rather than gameplay:
 *  - the delta is CLAMPED to `maxStepMs` first, so a tab that was hidden for a
 *    minute resumes where it left off instead of fast-forwarding the bird
 *    straight through a pipe;
 *  - what survives the clamp is then chopped into slices of at most
 *    `subStepMs`, so a 30fps machine and a 240fps machine simulate the same
 *    arc rather than the slower one drifting through corners.
 */
export function step(s: FlappyState, dtMs: number, cfg: FlappyConfig = FLAPPY_DEFAULTS): FlappyState {
  // Nothing happens before the first flap: the bird hangs there and the pipes
  // hold their position, so opening the game never costs you a run.
  if (s.status === 'ready') return s;
  const total = clamp(dtMs, 0, cfg.maxStepMs);
  if (total <= 0) return s;
  // FIXED TIMESTEP. Real time goes into a bank; the simulation is only ever
  // advanced by whole `subStepMs` ticks, and whatever is left over waits for
  // the next frame. Two consequences that both matter here: the game plays
  // identically on any machine, and no leftover time is silently dropped.
  let bank = s.carryMs + total;
  const tick = cfg.subStepMs / 1000;
  let next = s;
  while (bank >= cfg.subStepMs) {
    next = advance(next, tick, cfg);
    bank -= cfg.subStepMs;
  }
  return { ...next, carryMs: bank, elapsedMs: s.elapsedMs + total };
}

/** One physics slice. `dt` is in SECONDS. */
function advance(s: FlappyState, dt: number, cfg: FlappyConfig): FlappyState {
  // Gravity always applies — including after death, which is what makes a
  // bird that clipped a pipe fall out of the sky instead of freezing mid-air.
  const birdV = Math.min(s.birdV + cfg.gravity * dt, cfg.maxFallSpeed);
  let birdY = s.birdY + birdV * dt;

  if (s.status === 'dead') {
    // Post-mortem: the body falls, lands, and stops. No pipes move, no score
    // changes, and no further collision can be reported.
    const rest = FLOOR_Y - cfg.birdHitRadius;
    if (birdY >= rest) return { ...s, birdY: rest, birdV: 0, grounded: true };
    return { ...s, birdY, birdV };
  }

  const speed = scrollSpeedFor(s.score, cfg);
  let score = s.score;

  // Move every pipe left, scoring the ones the bird has just cleared. A pipe
  // flips `scored` exactly once and is never re-examined, which is what makes
  // one pipe worth one point however many frames the pass takes.
  const moved: Pipe[] = [];
  for (const p of s.pipes) {
    const x = p.x - speed * dt;
    let scored = p.scored;
    if (!scored && BIRD_X > x + cfg.pipeWidth) {
      scored = true;
      score += 1;
    }
    // Drop pipes fully off the left edge so the list cannot grow forever.
    if (x + cfg.pipeWidth < -cfg.pipeWidth) continue;
    moved.push(x === p.x && scored === p.scored ? p : { ...p, x, scored });
  }

  // Ceiling and ground are hard walls: both end the run (§5.1 — there is no
  // "bonk and continue" here, so the two ends of the screen read the same).
  let deathCause: DeathCause | null = null;
  if (birdY - cfg.birdHitRadius <= 0) {
    birdY = cfg.birdHitRadius;
    deathCause = 'ceiling';
  } else if (birdY + cfg.birdHitRadius >= FLOOR_Y) {
    birdY = FLOOR_Y - cfg.birdHitRadius;
    deathCause = 'ground';
  } else if (hitsAnyPipe(birdY, moved, cfg)) {
    deathCause = 'pipe';
  }

  const flying: FlappyState = {
    ...s,
    birdY,
    birdV,
    pipes: moved,
    distance: s.distance + speed * dt,
    score,
    status: deathCause ? 'dead' : 'flying',
    deathCause,
    grounded: deathCause === 'ground',
  };
  return deathCause ? flying : spawnPipes(flying, cfg);
}

/** Box-vs-box overlap against every pipe. Exported so the tests can ask the
 *  question directly instead of inferring it from a whole run. */
export function hitsAnyPipe(birdY: number, pipes: Pipe[], cfg: FlappyConfig = FLAPPY_DEFAULTS): boolean {
  const r = cfg.birdHitRadius;
  const half = cfg.pipeGap / 2;
  for (const p of pipes) {
    const overlapsHorizontally = BIRD_X + r > p.x && BIRD_X - r < p.x + cfg.pipeWidth;
    if (!overlapsHorizontally) continue;
    if (birdY - r < p.gapY - half || birdY + r > p.gapY + half) return true;
  }
  return false;
}

/** The pipe the bird is heading for — what the renderer aims a hint at, and a
 *  convenience for tests that want to line the bird up with the next gap. */
export function nextPipe(s: FlappyState, cfg: FlappyConfig = FLAPPY_DEFAULTS): Pipe | null {
  for (const p of s.pipes) if (p.x + cfg.pipeWidth >= BIRD_X) return p;
  return null;
}
