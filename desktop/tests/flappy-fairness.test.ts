// desktop/tests/flappy-fairness.test.ts
//
// The leaderboard's fairness guarantees, checked from OUTSIDE the engine —
// these assert the OUTCOME (same seed, same score) rather than the mechanism
// (a fixed-timestep bank), so they still hold if the engine is rewritten.
//
// WHY they are worth their own file: a Flappy score is ranked against your
// friends' scores. If a 240 Hz monitor scored higher than a 60 Hz one, or a
// pipe could bank points every frame it sat behind the bird, the board would
// be measuring hardware and bugs instead of skill — and nobody would be able
// to tell from looking at it.
import { describe, it, expect } from 'vitest';
import { createFlappyState, flap, step, type FlappyState } from '../src/renderer/components/game/flappy-engine';

/** Play one identical scripted run at a given frame rate. The bot flaps
 *  whenever it is below a fixed height — dumb, but identical across rates,
 *  which is the whole point. */
function runAt(fps: number, seed: number): { score: number; frames: number } {
  const dt = 1000 / fps;
  let s: FlappyState = flap(createFlappyState(seed));
  let frames = 0;
  while (s.status !== 'dead' && frames < fps * 60) {
    if (s.birdY > 55) s = flap(s);
    s = step(s, dt);
    frames++;
  }
  return { score: s.score, frames };
}

describe('independent check — the leaderboard must not reward a faster monitor', () => {
  it('the same run scores the same at 30, 60 and 240 fps', () => {
    for (const seed of [1, 7, 42, 1234]) {
      const a = runAt(30, seed).score;
      const b = runAt(60, seed).score;
      const c = runAt(240, seed).score;
      expect([a, b, c], `seed ${seed}`).toEqual([a, a, a]);
    }
  });
});

describe('independent check — a pipe scores once, not once per frame', () => {
  it('score never jumps by more than 1 in a single step', () => {
    let s = flap(createFlappyState(99));
    let prev = 0;
    for (let i = 0; i < 4000 && s.status !== 'dead'; i++) {
      if (s.birdY > 55) s = flap(s);
      s = step(s, 16);
      expect(s.score - prev).toBeLessThanOrEqual(1);
      prev = s.score;
    }
    // And the bot actually got somewhere, or this proves nothing.
    expect(prev).toBeGreaterThan(0);
  });
});

describe('independent check — a huge delta cannot tunnel the bird', () => {
  it('one enormous frame does not skip a pipe or teleport the bird', () => {
    // A backgrounded pane resuming: 5 whole seconds in one frame.
    const s = step(flap(createFlappyState(3)), 5000);
    // Either it died honestly, or it advanced a clamped amount — what it must
    // NOT do is sail through pipes and bank a free score.
    expect(s.score).toBeLessThanOrEqual(1);
  });
});
