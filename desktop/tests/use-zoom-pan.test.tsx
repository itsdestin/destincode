// @vitest-environment jsdom
// The hook over zoom-math: what the pill's buttons actually do. Geometry itself
// is tested in zoom-math.test.ts (jsdom rects are all zeros, so it has to be).
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useZoomPan } from '../src/renderer/components/artifact-views/zoom/useZoomPan';

afterEach(cleanup);

const SIZES = { containerW: 400, containerH: 300, contentW: 2000, contentH: 1000 };

let api: ReturnType<typeof useZoomPan>;
function Probe({ sizes = SIZES }: { sizes?: typeof SIZES }) {
  api = useZoomPan(sizes);
  return null;
}

describe('useZoomPan', () => {
  it('starts fitted, with zoom-out unavailable', () => {
    render(<Probe />);
    expect(api.isFit).toBe(true);
    expect(api.percent).toBe(20);
    expect(api.canZoomOut).toBe(false);
    expect(api.canZoomIn).toBe(true);
  });

  it('walks the ladder and stops at the ceiling', () => {
    render(<Probe />);
    act(() => api.zoomIn());
    expect(api.percent).toBe(50);
    for (let i = 0; i < 10; i++) act(() => api.zoomIn());
    expect(api.percent).toBe(800);
    expect(api.canZoomIn).toBe(false);
  });

  it('reset returns to fit and drops any pan', () => {
    render(<Probe />);
    act(() => api.zoomIn());
    act(() => api.zoomIn());
    act(() => api.reset());
    expect(api.isFit).toBe(true);
    expect(api.offset).toEqual({ x: 0, y: 0 });
  });

  it('a picture smaller than the pane cannot zoom below 100%', () => {
    render(<Probe sizes={{ containerW: 900, containerH: 600, contentW: 300, contentH: 200 }} />);
    expect(api.percent).toBe(100);
    expect(api.canZoomOut).toBe(false);
    act(() => api.zoomIn());
    expect(api.percent).toBe(150);
  });

  it('re-fits when the pane is resized, instead of stranding a stale scale', () => {
    const { rerender } = render(<Probe />);
    expect(api.percent).toBe(20);                        // 400/2000
    rerender(<Probe sizes={{ ...SIZES, containerW: 1000, containerH: 800 }} />);
    expect(api.percent).toBe(50);                        // 1000/2000 — still fitted
    expect(api.isFit).toBe(true);
  });

  it('holds an explicit zoom across a resize', () => {
    const { rerender } = render(<Probe />);
    act(() => api.zoomIn());                             // 50%, explicit
    rerender(<Probe sizes={{ ...SIZES, containerW: 1000, containerH: 800 }} />);
    expect(api.percent).toBe(50);
    expect(api.isFit).toBe(true);                        // fit is now 50% too
  });
});
