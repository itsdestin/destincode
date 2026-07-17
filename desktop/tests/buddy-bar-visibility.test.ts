import { describe, it, expect } from 'vitest';
import { BarVisibilityTracker } from '../src/main/buddy-bar-visibility';

describe('BarVisibilityTracker', () => {
  it('shows with the chat and hides with it', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v));
    t.setChatOpen(true);
    expect(changes).toEqual([true]);
    t.setChatOpen(false);
    expect(changes).toEqual([true, false]);
  });

  // The rule Destin asked for on 2026-07-16: the bar's actions are useless
  // without an open chat, so merely hovering the buddy must not summon it.
  it('never reveals on hover alone', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v));
    t.setHover('mascot', true);
    t.setHover('bar', true);
    expect(changes).toEqual([]);
    expect(t.wantsVisible()).toBe(false);
  });

  it('hover does not hold the bar open once the chat closes', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v));
    t.setChatOpen(true);
    t.setHover('bar', true);
    t.setChatOpen(false);
    expect(changes).toEqual([true, false]);
  });

  it('does not re-fire on redundant chat-open pushes', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v));
    t.setChatOpen(true);
    t.setChatOpen(true);
    expect(changes).toEqual([true]);
  });

  // isEngaged() is what suppresses the docked→peek idle timer, so unlike
  // visibility it still has to count hover.
  it('isEngaged() counts hover as well as an open chat', () => {
    const t = new BarVisibilityTracker(() => {});
    expect(t.isEngaged()).toBe(false);
    t.setHover('mascot', true);
    expect(t.isEngaged()).toBe(true);
    t.setHover('mascot', false);
    expect(t.isEngaged()).toBe(false);
    t.setChatOpen(true);
    expect(t.isEngaged()).toBe(true);
  });

  it('reset() clears state without firing callbacks', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v));
    t.setChatOpen(true);
    t.setHover('bar', true);
    t.reset();
    expect(changes).toEqual([true]);
    expect(t.wantsVisible()).toBe(false);
    expect(t.isEngaged()).toBe(false);
  });
});
