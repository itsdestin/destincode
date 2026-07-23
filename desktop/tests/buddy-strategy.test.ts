import { describe, it, expect } from 'vitest';
import { chooseBuddyStrategy } from '../src/main/buddy-manager';

// 2026-07-23: default flipped to 'windows' EVERYWHERE — setIgnoreMouseEvents
// is a total no-op on native Wayland, so the overlay (which depends on
// click-through) is dormant behind the env override until the platform
// supports it. See chooseBuddyStrategy's WHY comment and the workspace
// investigation doc. These tests pin the dormant-by-default contract.
describe('chooseBuddyStrategy', () => {
  it('windows everywhere by default — overlay is dormant, even on linux wayland', () => {
    expect(chooseBuddyStrategy('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe('windows');
    expect(chooseBuddyStrategy('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('windows');
    expect(chooseBuddyStrategy('linux', { XDG_SESSION_TYPE: 'x11' })).toBe('windows');
    expect(chooseBuddyStrategy('win32', { XDG_SESSION_TYPE: 'wayland' })).toBe('windows');
    expect(chooseBuddyStrategy('darwin', {})).toBe('windows');
  });
  it('env override is the only path to overlay, and only on linux', () => {
    expect(chooseBuddyStrategy('linux', { XDG_SESSION_TYPE: 'wayland', YOUCODED_BUDDY_STRATEGY: 'overlay' })).toBe('overlay');
    expect(chooseBuddyStrategy('linux', { XDG_SESSION_TYPE: 'x11', YOUCODED_BUDDY_STRATEGY: 'overlay' })).toBe('overlay');
    expect(chooseBuddyStrategy('linux', { XDG_SESSION_TYPE: 'wayland', YOUCODED_BUDDY_STRATEGY: 'windows' })).toBe('windows');
    expect(chooseBuddyStrategy('win32', { YOUCODED_BUDDY_STRATEGY: 'overlay' })).toBe('windows');
  });
});
