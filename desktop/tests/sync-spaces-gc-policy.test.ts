// desktop/tests/sync-spaces-gc-policy.test.ts
import { describe, it, expect } from 'vitest';
import { nextGcCounter } from '../src/main/sync-spaces/gc-policy';

describe('nextGcCounter', () => {
  it('increments and only fires on the Nth sync', () => {
    expect(nextGcCounter(0, 50)).toEqual({ counter: 1, shouldGc: false });
    expect(nextGcCounter(48, 50)).toEqual({ counter: 49, shouldGc: false });
    expect(nextGcCounter(49, 50)).toEqual({ counter: 50, shouldGc: true });   // 50th sync
    expect(nextGcCounter(50, 50)).toEqual({ counter: 51, shouldGc: false });
    expect(nextGcCounter(99, 50)).toEqual({ counter: 100, shouldGc: true });  // wraps: 100th
  });

  it('treats missing/corrupt prev as 0', () => {
    expect(nextGcCounter(NaN, 50)).toEqual({ counter: 1, shouldGc: false });
    expect(nextGcCounter(-5, 50)).toEqual({ counter: 1, shouldGc: false });
    expect(nextGcCounter(3.7, 50)).toEqual({ counter: 1, shouldGc: false });
    expect(nextGcCounter(undefined as any, 50)).toEqual({ counter: 1, shouldGc: false });
  });

  it('guards a bad interval (defaults to 50)', () => {
    expect(nextGcCounter(49, 0)).toEqual({ counter: 50, shouldGc: true });
    expect(nextGcCounter(49, NaN)).toEqual({ counter: 50, shouldGc: true });
  });

  it('honors a small injected interval (test convenience)', () => {
    expect(nextGcCounter(0, 2)).toEqual({ counter: 1, shouldGc: false });
    expect(nextGcCounter(1, 2)).toEqual({ counter: 2, shouldGc: true });
    expect(nextGcCounter(2, 2)).toEqual({ counter: 3, shouldGc: false });
    expect(nextGcCounter(3, 2)).toEqual({ counter: 4, shouldGc: true });
  });
});
