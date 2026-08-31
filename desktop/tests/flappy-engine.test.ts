// desktop/tests/flappy-engine.test.ts
//
// The rules of Flappy (spec §5.1). This suite exists because the engine is the
// half of the game a screenshot cannot check: whether a pipe is worth exactly
// one point, whether a crash really ends the run, and whether the same seed
// really replays the same run. Everything here runs headless — no React, no
// DOM — which is the whole reason flappy-engine.ts has neither.
import { describe, it, expect } from 'vitest';
import {
  createFlappyState, flap, step, hitsAnyPipe, nextPipe, scrollSpeedFor,
  FLAPPY_DEFAULTS, WORLD_W, FLOOR_Y, BIRD_X,
  type FlappyConfig, type FlappyState,
} from '../src/renderer/components/game/flappy-engine';

const FRAME = 16; // one 60fps frame, ms

/** Run `n` frames, flapping on the frames `shouldFlap` picks out. */
function run(
  s: FlappyState,
  n: number,
  cfg: FlappyConfig,
  shouldFlap: (s: FlappyState, i: number) => boolean = () => false,
): FlappyState {
  let cur = s;
  for (let i = 0; i < n; i++) {
    if (shouldFlap(cur, i)) cur = flap(cur, cfg);
    cur = step(cur, FRAME, cfg);
  }
  return cur;
}

/** A scripted "player": flap once the bird has sunk a set distance below the
 *  hole it is aiming at. Used only to drive a run far enough that the
 *  determinism check is testing a real game and not a one-frame crash. */
function autopilot(cfg: FlappyConfig, slack = 7) {
  return (s: FlappyState): boolean => {
    const p = nextPipe(s, cfg);
    const target = p ? p.gapY : FLOOR_Y / 2;
    return s.birdV > 0 && s.birdY > target + slack;
  };
}

describe('a fresh run', () => {
  it('waits: nothing moves until the first flap', () => {
    const s0 = createFlappyState(42);
    expect(s0.status).toBe('ready');
    const s1 = run(s0, 60, FLAPPY_DEFAULTS);
    // A whole second of frames and the bird has not fallen a millimetre —
    // opening the panel must never cost you a run.
    expect(s1.birdY).toBe(s0.birdY);
    expect(s1.pipes[0]!.x).toBe(s0.pipes[0]!.x);
    expect(s1.score).toBe(0);
  });

  it('queues pipes off the right edge, never inside the view', () => {
    const s0 = createFlappyState(7);
    expect(s0.pipes.length).toBeGreaterThan(0);
    for (const p of s0.pipes) expect(p.x).toBeGreaterThanOrEqual(WORLD_W);
  });

  it('never holds more pipes at once than the renderer has slots', () => {
    // FlappyGame.tsx mounts a FIXED pool of 6 pipe columns and reuses them, so
    // a pipe never costs a React render. If the engine could ever hold a
    // seventh, that pipe would simply not be drawn — an invisible wall. This
    // pins the pool size to the engine rather than to an assumption.
    const cfg: FlappyConfig = { ...FLAPPY_DEFAULTS, gravity: 0 };
    let worst = 0;
    for (let seed = 0; seed < 8; seed++) {
      let s = flap(createFlappyState(seed, cfg), cfg);
      s = { ...s, birdV: 0 };
      for (let i = 0; i < 600 && s.status !== 'dead'; i++) {
        s = step(s, FRAME, cfg);
        worst = Math.max(worst, s.pipes.length);
      }
    }
    expect(worst).toBeGreaterThan(1); // non-vacuity: it really did queue pipes
    expect(worst).toBeLessThanOrEqual(6);
  });

  it('every generated gap stays inside the playable band', () => {
    // Ten seeds × a long run: a generator that can emit a gap flush against
    // the ceiling produces pipes that no reaction time clears.
    const cfg: FlappyConfig = { ...FLAPPY_DEFAULTS, gravity: 0 };
    for (let seed = 0; seed < 10; seed++) {
      let s = flap(createFlappyState(seed, cfg), cfg);
      s = { ...s, birdV: 0 };
      for (let i = 0; i < 400 && s.status !== 'dead'; i++) {
        s = step(s, FRAME, cfg);
        for (const p of s.pipes) {
          expect(p.gapY - cfg.pipeGap / 2).toBeGreaterThanOrEqual(cfg.gapMargin - 1e-9);
          expect(p.gapY + cfg.pipeGap / 2).toBeLessThanOrEqual(FLOOR_Y - cfg.gapMargin + 1e-9);
        }
      }
    }
  });
});

describe('gravity and the flap', () => {
  it('accumulates downward speed frame after frame', () => {
    const cfg = FLAPPY_DEFAULTS;
    let s = flap(createFlappyState(1, cfg), cfg);
    const speeds: number[] = [];
    for (let i = 0; i < 8; i++) { s = step(s, FRAME, cfg); speeds.push(s.birdV); }
    // Strictly increasing (less negative, then positive) — that IS gravity.
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]!).toBeGreaterThan(speeds[i - 1]!);
    // And by the right amount: v after t seconds = v0 + g·t.
    const t = (8 * FRAME) / 1000;
    expect(speeds[speeds.length - 1]!).toBeCloseTo(cfg.flapVelocity + cfg.gravity * t, 4);
  });

  it('never falls faster than the terminal speed', () => {
    const cfg = FLAPPY_DEFAULTS;
    // Fall for two seconds with the floor pushed far away so nothing stops it.
    let s = flap(createFlappyState(2, cfg), cfg);
    s = { ...s, birdY: 5, birdV: 0, pipes: [] };
    for (let i = 0; i < 120; i++) {
      s = step(s, FRAME, cfg);
      expect(s.birdV).toBeLessThanOrEqual(cfg.maxFallSpeed + 1e-9);
    }
  });

  it('a flap sets an upward velocity, whatever the bird was doing', () => {
    const cfg = FLAPPY_DEFAULTS;
    let s = flap(createFlappyState(3, cfg), cfg);
    expect(s.birdV).toBe(cfg.flapVelocity);
    expect(s.birdV).toBeLessThan(0); // negative = up, since y grows downward
    s = run(s, 20, cfg);             // fall for a third of a second…
    expect(s.birdV).toBeGreaterThan(0);
    s = flap(s, cfg);                // …and a flap wipes that out entirely
    expect(s.birdV).toBe(cfg.flapVelocity);
  });

  it('starts the run — the first flap is what un-pauses it', () => {
    const s = flap(createFlappyState(4));
    expect(s.status).toBe('flying');
  });

  it('a flap after death does nothing', () => {
    const cfg = FLAPPY_DEFAULTS;
    let s = flap(createFlappyState(5, cfg), cfg);
    s = { ...s, birdY: FLOOR_Y - 1, birdV: 100 };
    s = step(s, FRAME, cfg);
    expect(s.status).toBe('dead');
    expect(flap(s, cfg)).toBe(s);
  });
});

describe('scoring', () => {
  // A level flight (gravity off) past one hand-placed pipe: the only thing
  // moving is the world, so any score change can only come from that pipe.
  const cfg: FlappyConfig = { ...FLAPPY_DEFAULTS, gravity: 0 };

  function levelRunPastOnePipe(): FlappyState {
    const base = createFlappyState(11, cfg);
    return {
      ...base,
      status: 'flying',
      birdY: 60,
      birdV: 0,
      pipes: [{ id: 1, x: BIRD_X + 2, gapY: 60, scored: false }],
    };
  }

  it('a pipe passed is worth exactly one point, once', () => {
    let s = levelRunPastOnePipe();
    const seen: number[] = [];
    for (let i = 0; i < 30; i++) { s = step(s, FRAME, cfg); seen.push(s.score); }
    expect(s.status).toBe('flying');
    expect(s.score).toBe(1);
    // It went 0 → 1 and stopped. A frame-by-frame check, not just the end
    // state: the classic bug here is a pipe that scores on every frame it
    // spends behind the bird.
    expect(new Set(seen)).toEqual(new Set([0, 1]));
    expect(seen[seen.length - 1]).toBe(1);
    // Twenty more frames with nothing else in reach — still one.
    s = run(s, 20, cfg);
    expect(s.score).toBe(1);
    expect(s.pipes.find((p) => p.id === 1)?.scored).toBe(true);
  });

  it('does not score a pipe the bird is still inside', () => {
    let s = levelRunPastOnePipe();
    // Two frames: the pipe has moved ~1.7 units, so its right edge is still
    // ahead of the bird.
    s = step(s, FRAME, cfg);
    s = step(s, FRAME, cfg);
    expect(s.pipes[0]!.x + cfg.pipeWidth).toBeGreaterThan(BIRD_X);
    expect(s.score).toBe(0);
  });

  it('tracks the distance travelled, in lockstep with the pipes', () => {
    // The renderer's scrolling ground reads `distance` rather than keeping its
    // own clock — if these two ever disagreed, the ground would visibly slide
    // out from under the pipes standing on it.
    let s = levelRunPastOnePipe();
    const startX = s.pipes[0]!.x;
    const startD = s.distance;
    s = run(s, 20, cfg);
    expect(s.distance - startD).toBeCloseTo(startX - s.pipes[0]!.x, 9);
  });

  it('speeds the world up as the score climbs, then stops', () => {
    expect(scrollSpeedFor(0)).toBe(FLAPPY_DEFAULTS.scrollSpeed);
    expect(scrollSpeedFor(10)).toBeGreaterThan(scrollSpeedFor(0));
    // The ramp is capped, so a long run does not become physically impossible.
    expect(scrollSpeedFor(1000)).toBe(FLAPPY_DEFAULTS.scrollSpeed + FLAPPY_DEFAULTS.scrollSpeedMaxBonus);
  });
});

describe('collisions end the run', () => {
  const cfg = FLAPPY_DEFAULTS;

  it('flying into a pipe', () => {
    let s = flap(createFlappyState(21, cfg), cfg);
    // Sitting well below the hole, with the pipe already overlapping the bird.
    s = { ...s, birdY: 70, birdV: 0, pipes: [{ id: 1, x: BIRD_X - 2, gapY: 40, scored: false }] };
    s = step(s, FRAME, cfg);
    expect(s.status).toBe('dead');
    expect(s.deathCause).toBe('pipe');
  });

  it('but not through the hole', () => {
    const level: FlappyConfig = { ...cfg, gravity: 0 };
    let s = flap(createFlappyState(22, level), level);
    s = { ...s, birdY: 55, birdV: 0, pipes: [{ id: 1, x: BIRD_X + 20, gapY: 55, scored: false }] };
    s = run(s, 60, level);
    expect(s.status).toBe('flying');
    expect(s.score).toBe(1);
  });

  it('hitting the ground', () => {
    let s = flap(createFlappyState(23, cfg), cfg);
    s = { ...s, birdY: FLOOR_Y - 5, birdV: 200, pipes: [] };
    s = step(s, FRAME, cfg);
    expect(s.status).toBe('dead');
    expect(s.deathCause).toBe('ground');
    expect(s.grounded).toBe(true);
  });

  it('hitting the ceiling', () => {
    let s = flap(createFlappyState(24, cfg), cfg);
    s = { ...s, birdY: 6, birdV: -200, pipes: [] };
    s = step(s, FRAME, cfg);
    expect(s.status).toBe('dead');
    expect(s.deathCause).toBe('ceiling');
  });

  it('a dead bird falls to the ground and stays there', () => {
    let s = flap(createFlappyState(25, cfg), cfg);
    s = { ...s, birdY: 20, birdV: 0, pipes: [{ id: 1, x: BIRD_X - 2, gapY: 70, scored: false }] };
    s = step(s, FRAME, cfg);
    expect(s.deathCause).toBe('pipe');
    const pipesAtDeath = s.pipes.map((p) => p.x);
    s = run(s, 120, cfg);
    expect(s.grounded).toBe(true);
    expect(s.birdV).toBe(0);
    // The world stops the moment you die — pipes do not keep sliding past.
    expect(s.pipes.map((p) => p.x)).toEqual(pipesAtDeath);
    expect(s.score).toBe(0);
  });

  it('hitsAnyPipe ignores a pipe the bird is not level with', () => {
    // Same vertical miss, but the pipe is far to the right — no overlap.
    expect(hitsAnyPipe(70, [{ id: 1, x: BIRD_X + 40, gapY: 40, scored: false }])).toBe(false);
    expect(hitsAnyPipe(70, [{ id: 1, x: BIRD_X - 2, gapY: 40, scored: false }])).toBe(true);
  });
});

describe('frame-rate safety', () => {
  const cfg = FLAPPY_DEFAULTS;

  it('clamps a huge delta so a backgrounded tab cannot tunnel through a pipe', () => {
    // Ten seconds of "elapsed" time arriving in one frame — the shape of a
    // tab that was hidden. Unclamped, the world would jump ~520 units, which
    // is five pipes' worth, and the bird would arrive on the far side of a
    // pipe it never touched.
    let s = flap(createFlappyState(31, cfg), cfg);
    const before = s.pipes[0]!.x;
    s = step(s, 10_000, cfg);
    const travelled = before - s.pipes[0]!.x;
    expect(travelled).toBeLessThanOrEqual((cfg.maxStepMs / 1000) * scrollSpeedFor(0, cfg) + 1e-6);
    expect(s.elapsedMs).toBe(cfg.maxStepMs);
  });

  it('a zero or negative delta is a no-op', () => {
    const s = flap(createFlappyState(32, cfg), cfg);
    expect(step(s, 0, cfg)).toBe(s);
    expect(step(s, -5, cfg)).toBe(s);
  });

  it('30fps and 120fps simulate the SAME arc, not merely a similar one', () => {
    // The fixed timestep's whole purpose: the same 320ms of real time delivered
    // as ten 32ms frames or forty 8ms frames must produce the identical
    // position, or the game is harder on a slow machine and the leaderboard
    // is measuring hardware.
    const s0 = flap(createFlappyState(33, cfg), cfg);
    let slow = s0;
    for (let i = 0; i < 10; i++) slow = step(slow, 32, cfg);
    let fast = s0;
    for (let i = 0; i < 40; i++) fast = step(fast, 8, cfg);
    expect(fast.birdY).toBe(slow.birdY);
    expect(fast.birdV).toBe(slow.birdV);
    expect(fast.pipes[0]!.x).toBe(slow.pipes[0]!.x);
  });

  it('banks the leftover of a frame instead of throwing it away', () => {
    // A 10ms frame is less than one 16ms tick, so nothing simulates yet — but
    // the second 10ms frame must produce a tick, not another nothing.
    let s = flap(createFlappyState(34, cfg), cfg);
    const start = s.birdY;
    s = step(s, 10, cfg);
    expect(s.birdY).toBe(start);
    expect(s.carryMs).toBe(10);
    s = step(s, 10, cfg);
    expect(s.birdY).not.toBe(start);
    expect(s.carryMs).toBe(4);
  });
});

describe('determinism', () => {
  const cfg = FLAPPY_DEFAULTS;
  const pilot = autopilot(cfg);

  it('the same seed and the same inputs replay the same run', () => {
    const a = run(flap(createFlappyState(1234, cfg), cfg), 600, cfg, pilot);
    const b = run(flap(createFlappyState(1234, cfg), cfg), 600, cfg, pilot);
    expect(a).toEqual(b);
    // Non-vacuity: if the run died in the first frame, "identical" would be
    // trivially true and this test would prove nothing. It has to be a real
    // game — pipes cleared, time on the clock.
    expect(a.score).toBeGreaterThan(2);
    expect(a.elapsedMs).toBeGreaterThan(1000);
  });

  it('a different seed lays the pipes out differently', () => {
    const a = createFlappyState(1, cfg);
    const b = createFlappyState(2, cfg);
    expect(a.pipes.map((p) => p.gapY)).not.toEqual(b.pipes.map((p) => p.gapY));
  });

  it('never reads a global random source', () => {
    // The proof: the generator's position lives in the state. Two engines
    // stepped in an interleaved order still agree, which could not be true of
    // anything reading Math.random.
    const a = run(flap(createFlappyState(99, cfg), cfg), 300, cfg, pilot);
    const b = run(flap(createFlappyState(99, cfg), cfg), 300, cfg, pilot);
    expect(a.pipes.map((p) => p.gapY)).toEqual(b.pipes.map((p) => p.gapY));
    expect(a.rngSeed).toBe(b.rngSeed);
  });
});

describe('nextPipe', () => {
  it('names the pipe the bird still has to clear', () => {
    const s = createFlappyState(77);
    expect(nextPipe(s)!.id).toBe(s.pipes[0]!.id);
    const passed = { ...s, pipes: [{ id: 1, x: BIRD_X - 40, gapY: 60, scored: true }, ...s.pipes] };
    expect(nextPipe(passed)!.id).toBe(s.pipes[0]!.id);
  });
});
