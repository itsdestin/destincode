// @vitest-environment jsdom
// The app-wide pinch handler is capture-phase on window and preventDefaults
// EVERY ctrlKey wheel event, but does not stopPropagation. Without a guard, a
// pinch over a picture zooms the whole app AND the picture at once, with two
// different percentages showing in two corners. That double-zoom is what this
// pins against.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { useZoomControls } from '../src/renderer/hooks/useZoomControls';

const zoomIn = vi.fn(async () => 110);

beforeEach(() => {
  vi.useFakeTimers();
  zoomIn.mockClear();
  (window as any).claude = {
    zoom: { zoomIn, zoomOut: vi.fn(async () => 90), reset: vi.fn(async () => 100), get: vi.fn(async () => 100) },
  };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Host() {
  useZoomControls();
  return (
    <div>
      <div data-zoomable><span data-testid="picture" /></div>
      <span data-testid="outside" />
    </div>
  );
}

function pinchOn(el: Element) {
  act(() => {
    el.dispatchEvent(new WheelEvent('wheel', { ctrlKey: true, deltaY: -120, bubbles: true }));
    vi.advanceTimersByTime(100);
  });
}

describe('useZoomControls pinch guard', () => {
  it('ignores a ctrl+wheel that starts inside a zoomable viewer', () => {
    const { getByTestId } = render(<Host />);
    pinchOn(getByTestId('picture'));
    expect(zoomIn).not.toHaveBeenCalled();
  });

  it('still zooms the app for a ctrl+wheel anywhere else', () => {
    const { getByTestId } = render(<Host />);
    pinchOn(getByTestId('outside'));
    expect(zoomIn).toHaveBeenCalled();
  });
});
