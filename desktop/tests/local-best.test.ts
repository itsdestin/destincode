// desktop/tests/local-best.test.ts
// §4.2: "best scores persist locally". The first pass kept them in React state
// inside the arcade panel, so closing the panel forgot them — a run Destin had
// just finished and watched the game count.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readBest, recordRun, readAllBests } from '../src/renderer/components/game/local-best';

beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
  });
});

describe('local best', () => {
  it('an unplayed game is undefined, not zero', () => {
    // A 0 would render as "Your best: 0", which reads as a bad run.
    expect(readBest('flappy')).toBeUndefined();
  });

  it('survives a reload — it is on disk, not in a component', () => {
    recordRun('flappy', 17);
    expect(readBest('flappy')).toBe(17);
  });

  it('a worse run never lowers your best', () => {
    recordRun('flappy', 17);
    expect(recordRun('flappy', 3)).toBe(17);
    expect(readBest('flappy')).toBe(17);
  });

  it('a better run raises it', () => {
    recordRun('flappy', 17);
    expect(recordRun('flappy', 31)).toBe(31);
  });

  it('games do not share a best', () => {
    recordRun('flappy', 17);
    recordRun('twenty-forty-eight', 12480);
    expect(readAllBests(['flappy', 'twenty-forty-eight'])).toEqual({ flappy: 17, 'twenty-forty-eight': 12480 });
  });

  it('a corrupt value reads as never-played rather than NaN', () => {
    localStorage.setItem('youcoded-game-best-flappy', 'banana');
    expect(readBest('flappy')).toBeUndefined();
  });

  it('storage that throws does not take the game down', () => {
    // Private windows and blocked site data throw outright rather than
    // returning null. Losing a record is not worth interrupting a player.
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
    });
    expect(() => readBest('flappy')).not.toThrow();
    expect(readBest('flappy')).toBeUndefined();
    expect(() => recordRun('flappy', 5)).not.toThrow();
  });
});
