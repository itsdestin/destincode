// ---------------------------------------------------------------------------
// INVARIANT: which mechanism carries a session pill OUT of its window is chosen
// from FACTS about the host, and the session id survives the only channel an
// OS drag gives us to carry it — a file name.
//
// Why this is pinned: the cross-window half of session detach reads screen
// coordinates, and on Linux/Wayland every one of those is zero (see
// session-drag-model.ts for the measurements). The fork below is what keeps
// that half working there. An earlier attempt at this fix disabled the POINTER
// path on Wayland too, which would have thrown away the strip's in-strip motion
// to fix a cross-window problem — hence the test that says what is NOT chosen.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  chooseTearOffModel,
  dragFileNameFor,
  sessionIdFromDragFileName,
} from '../src/renderer/session-drag-model';

describe('chooseTearOffModel', () => {
  it('hands the gesture to the compositor on Linux + Wayland, where coordinates are all zero', () => {
    expect(chooseTearOffModel({ platform: 'linux', wayland: true })).toBe('os-drag');
  });

  it('keeps the live tear-off everywhere it actually works', () => {
    expect(chooseTearOffModel({ platform: 'win32', wayland: false })).toBe('live-window');
    expect(chooseTearOffModel({ platform: 'darwin', wayland: false })).toBe('live-window');
    // Linux on X11 can read and set window positions, so it keeps the animation.
    expect(chooseTearOffModel({ platform: 'linux', wayland: false })).toBe('live-window');
  });

  it('falls back to the live tear-off where nothing is reported', () => {
    // Browser tab, Android, workbench: single-window surfaces where the strip's
    // cross-window paths are inert either way.
    expect(chooseTearOffModel(null)).toBe('live-window');
    expect(chooseTearOffModel(undefined)).toBe('live-window');
  });
});

describe('the drag payload rides on a file name', () => {
  it('round-trips a session id', () => {
    const id = '9f1c0b6e-1c2d-4a3b-9e8f-0a1b2c3d4e5f';
    expect(sessionIdFromDragFileName(dragFileNameFor(id))).toBe(id);
  });

  it('round-trips an id that would otherwise break a file name', () => {
    const id = 'a/b c%d';
    const name = dragFileNameFor(id);
    expect(name).not.toContain('/');
    expect(sessionIdFromDragFileName(name)).toBe(id);
  });

  it('refuses anything that is not one of ours, so a real file drop is not eaten', () => {
    expect(sessionIdFromDragFileName('report.pdf')).toBeNull();
    expect(sessionIdFromDragFileName('youcoded-session--.ycsession')).toBeNull();
    expect(sessionIdFromDragFileName('')).toBeNull();
    expect(sessionIdFromDragFileName(null)).toBeNull();
    expect(sessionIdFromDragFileName(undefined)).toBeNull();
  });
});

describe('preload reports facts, not a verdict', () => {
  // The decision must stay in this module — testable without a live Electron.
  // If preload ever starts deciding, this test is the thing that notices.
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');

  it('exposes the raw facts', () => {
    expect(preload).toMatch(/platformFacts:\s*\{/);
    expect(preload).toMatch(/wayland:/);
  });

  it('does not name a drag model', () => {
    expect(preload).not.toMatch(/'os-drag'|"os-drag"/);
    expect(preload).not.toMatch(/chooseTearOffModel/);
  });
});
