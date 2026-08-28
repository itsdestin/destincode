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
    expect(api.percent).toBe(25);        // fit is 20%: the next round rung up
    for (let i = 0; i < 12; i++) act(() => api.zoomIn());
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

  it('a press on a control is not a drag, so the button keeps its click', () => {
    // Reported 2026-08-27: "goes from 12 to 50 and then freezes and +/- dont
    // work anymore". Above fit, a press ANYWHERE started a pan and captured the
    // pointer — including a press on "+", which then never saw its own pointerup,
    // so every button went dead after the first zoom. At fit there is nothing to
    // pan, which is exactly why the first click always worked.
    render(<Probe />);
    act(() => api.zoomIn());                 // above fit — the drag path is live
    expect(api.isFit).toBe(false);

    const captured: number[] = [];
    const container = document.createElement('div');
    (container as any).setPointerCapture = (id: number) => captured.push(id);
    const button = document.createElement('button');
    container.appendChild(button);
    document.body.appendChild(container);

    const press = (target: Element, pointerId: number) => act(() => {
      api.bind.onPointerDown({
        pointerId, clientX: 10, clientY: 10, target, currentTarget: container,
      } as unknown as React.PointerEvent);
    });

    press(button, 1);
    expect(captured).toEqual([]);            // the control keeps its own click
    act(() => api.bind.onPointerUp({ pointerId: 1, currentTarget: container } as unknown as React.PointerEvent));

    press(container, 2);
    expect(captured).toEqual([2]);           // the picture still pans
    container.remove();
  });

  it('re-fits when the pane is resized, instead of stranding a stale scale', () => {
    const { rerender } = render(<Probe />);
    expect(api.percent).toBe(20);                        // 400/2000
    rerender(<Probe sizes={{ ...SIZES, containerW: 1000, containerH: 800 }} />);
    expect(api.percent).toBe(50);                        // 1000/2000 — still fitted
    expect(api.isFit).toBe(true);
  });

  it('never ends up smaller than fitted after the pane grows', () => {
    // Widening the pane raises the fit scale. A scale chosen before that can be
    // below the new fit, which would leave the picture smaller than fitted with
    // "zoom out" still on offer.
    const { rerender } = render(<Probe />);
    act(() => api.zoomIn());                             // 25%, explicit
    expect(api.percent).toBe(25);
    rerender(<Probe sizes={{ ...SIZES, containerW: 1000, containerH: 800 }} />);
    expect(api.percent).toBe(50);                        // pulled up to the new fit
    expect(api.isFit).toBe(true);
    expect(api.canZoomOut).toBe(false);
  });
});
