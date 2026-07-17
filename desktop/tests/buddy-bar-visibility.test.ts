import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BarVisibilityTracker } from '../src/main/buddy-bar-visibility';

describe('BarVisibilityTracker', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows on mascot hover, hides after grace when hover ends', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v), 350);
    t.setHover('mascot', true);
    expect(changes).toEqual([true]);
    t.setHover('mascot', false);
    expect(changes).toEqual([true]); // not yet — grace pending
    vi.advanceTimersByTime(349);
    expect(changes).toEqual([true]);
    vi.advanceTimersByTime(2);
    expect(changes).toEqual([true, false]);
  });

  it('crossing the mascot→bar gap within grace does not flicker', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v), 350);
    t.setHover('mascot', true);
    t.setHover('mascot', false);      // left mascot…
    vi.advanceTimersByTime(100);
    t.setHover('bar', true);          // …arrived on bar inside grace
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true]);  // never hid
  });

  it('stays pinned while chat is open regardless of hover', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v), 350);
    t.setChatOpen(true);
    expect(changes).toEqual([true]);
    t.setHover('mascot', true);
    t.setHover('mascot', false);
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true]); // chat pins it
    t.setChatOpen(false);
    vi.advanceTimersByTime(351);
    expect(changes).toEqual([true, false]);
  });

  it('reset() clears state without firing callbacks', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v), 350);
    t.setHover('bar', true);
    t.reset();
    vi.advanceTimersByTime(1000);
    expect(changes).toEqual([true]);
    expect(t.wantsVisible()).toBe(false);
  });
});
