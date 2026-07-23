import { describe, it, expect } from 'vitest';
import { chooseBuddyStrategy } from '../src/main/buddy-manager';

describe('chooseBuddyStrategy', () => {
  it('overlay only on linux wayland', () => {
    expect(chooseBuddyStrategy('linux', { XDG_SESSION_TYPE: 'wayland' })).toBe('overlay');
    expect(chooseBuddyStrategy('linux', { WAYLAND_DISPLAY: 'wayland-0' })).toBe('overlay');
    expect(chooseBuddyStrategy('linux', { XDG_SESSION_TYPE: 'x11' })).toBe('windows');
    expect(chooseBuddyStrategy('win32', { XDG_SESSION_TYPE: 'wayland' })).toBe('windows');
    expect(chooseBuddyStrategy('darwin', {})).toBe('windows');
  });
  it('env override wins on linux', () => {
    expect(chooseBuddyStrategy('linux', { XDG_SESSION_TYPE: 'wayland', YOUCODED_BUDDY_STRATEGY: 'windows' })).toBe('windows');
    expect(chooseBuddyStrategy('linux', { XDG_SESSION_TYPE: 'x11', YOUCODED_BUDDY_STRATEGY: 'overlay' })).toBe('overlay');
    expect(chooseBuddyStrategy('win32', { YOUCODED_BUDDY_STRATEGY: 'overlay' })).toBe('windows');
  });
});
