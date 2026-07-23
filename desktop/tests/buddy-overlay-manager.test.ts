import { describe, it, expect } from 'vitest';
import { overlayInitPayload, localToScreenPoint, displayGeometryChanged } from '../src/main/buddy-overlay-manager';

describe('overlayInitPayload', () => {
  const bounds = { x: 0, y: 0, width: 1707, height: 1067 };
  const workArea = { x: 0, y: 0, width: 1707, height: 1018 };
  it('converts workArea to window-local and clamps persisted mascot', () => {
    const p = overlayInitPayload(bounds, workArea, { mascot: { x: 5000, y: -50 }, dock: 'right' });
    expect(p.workArea).toEqual({ x: 0, y: 0, width: 1707, height: 1018 });
    expect(p.mascot!.x).toBeLessThanOrEqual(1707 - 112);   // MASCOT_SIZE.width
    expect(p.mascot!.y).toBeGreaterThanOrEqual(0);
    expect(p.dock).toBe('right');
  });
  it('offsets workArea when display bounds do not start at 0 (secondary-display safety)', () => {
    const p = overlayInitPayload({ x: 1707, y: 0, width: 1920, height: 1080 },
      { x: 1707, y: 40, width: 1920, height: 1040 }, { mascot: null, dock: null });
    expect(p.workArea).toEqual({ x: 0, y: 40, width: 1920, height: 1040 });
    expect(p.mascot).toBeNull();
  });
});

// Coordinator review finding 2: persistFromRenderer must translate the
// renderer's window-local mascot point to screen-absolute before writing to
// buddy-positions.json, since overlayInitPayload's LOAD path (above) always
// subtracts displayBounds.x/y assuming a screen-absolute input. Round-trip
// through NON-ORIGIN bounds proves the two ends of the frame contract agree.
describe('localToScreenPoint / overlayInitPayload round trip (non-origin display)', () => {
  it('local -> screen -> local recovers the same window-local point', () => {
    const bounds = { x: 1920, y: 0, width: 1707, height: 1067 };
    const workArea = { x: 1920, y: 0, width: 1707, height: 1018 };
    const localPoint = { x: 500, y: 300 }; // what the renderer holds/persists

    const screenPoint = localToScreenPoint(localPoint, bounds);
    expect(screenPoint).toEqual({ x: 2420, y: 300 }); // screen-absolute for buddy-positions.json

    const payload = overlayInitPayload(bounds, workArea, { mascot: screenPoint, dock: null });
    expect(payload.mascot).toEqual(localPoint); // identical local point recovered
  });
});

// 2026-07-23 black-flash-loop root cause: on KWin Wayland, merely MAPPING a
// window fires display-metrics-changed with changedMetrics=[] and IDENTICAL
// geometry (probe-verified — 3 spurious events within 200ms of showInactive).
// handleDisplayChange rebuilding on every event therefore self-sustained:
// create -> spurious event -> destroy+recreate -> spurious event -> ... with
// each renderer destroyed before first paint (black full-screen flashes) until
// Electron hit a V8 fatal. The guard: only rebuild when the geometry the
// window was BUILT FOR actually changed. These tests pin the comparison.
describe('displayGeometryChanged', () => {
  const geo = {
    bounds: { x: 0, y: 0, width: 1707, height: 1067 },
    workArea: { x: 0, y: 0, width: 1707, height: 1018 },
    scaleFactor: 1.4997071027755737,
  };
  it('identical geometry -> false (spurious event must NOT rebuild)', () => {
    expect(displayGeometryChanged(geo, { ...geo })).toBe(false);
    // deep copies, not reference equality
    expect(displayGeometryChanged(geo, {
      bounds: { ...geo.bounds }, workArea: { ...geo.workArea }, scaleFactor: geo.scaleFactor,
    })).toBe(false);
  });
  it('bounds change -> true (resolution switch)', () => {
    expect(displayGeometryChanged(geo, { ...geo, bounds: { x: 0, y: 0, width: 1920, height: 1080 } })).toBe(true);
  });
  it('workArea-only change -> true (panel moved/resized)', () => {
    expect(displayGeometryChanged(geo, { ...geo, workArea: { x: 0, y: 44, width: 1707, height: 974 } })).toBe(true);
  });
  it('scaleFactor change -> true (fractional scaling toggle)', () => {
    expect(displayGeometryChanged(geo, { ...geo, scaleFactor: 2 })).toBe(true);
  });
});
