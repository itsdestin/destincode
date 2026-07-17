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
  // without an open chat, so nothing but the chat may summon it. Hover used to
  // be an input here; it isn't tracked at all any more (see buddy-dock.ts —
  // the peek timer it also fed is gone).
  it('the chat is the only thing that opens it', () => {
    const t = new BarVisibilityTracker(() => {});
    expect(t.wantsVisible()).toBe(false);
    t.setChatOpen(true);
    expect(t.wantsVisible()).toBe(true);
  });

  it('does not re-fire on redundant chat-open pushes', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v));
    t.setChatOpen(true);
    t.setChatOpen(true);
    expect(changes).toEqual([true]);
  });

  it('does not re-fire on redundant chat-close pushes', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v));
    t.setChatOpen(false);
    expect(changes).toEqual([]);
  });

  it('reset() clears state without firing callbacks', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v));
    t.setChatOpen(true);
    t.reset();
    expect(changes).toEqual([true]);
    expect(t.wantsVisible()).toBe(false);
  });

  it('reset() leaves the tracker able to fire again', () => {
    const changes: boolean[] = [];
    const t = new BarVisibilityTracker((v) => changes.push(v));
    t.setChatOpen(true);
    t.reset();
    t.setChatOpen(true);
    expect(changes).toEqual([true, true]);
  });
});
