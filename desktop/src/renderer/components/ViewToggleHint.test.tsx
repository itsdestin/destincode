// @vitest-environment jsdom
//
// Pins the two things that make this coach mark useful rather than decorative:
// it lands under the real toggle, and it stays on screen when the toggle sits
// near a window edge (which is where it actually sits on Windows/Linux — the
// bubble is wider than the toggle's own left offset, so an unclamped centre
// puts half of it past x=0).
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ViewToggleHint from './ViewToggleHint';

const ANCHOR_WIDTH = 144;
const ANCHOR_BOTTOM = 34;
const PANEL_WIDTH = 300;

function mountAnchor(left: number): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute('data-view-toggle', '');
  el.getBoundingClientRect = () => ({
    x: left, y: 6, left, right: left + ANCHOR_WIDTH,
    top: 6, bottom: ANCHOR_BOTTOM, width: ANCHOR_WIDTH, height: 28,
    toJSON: () => ({}),
  }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

/** jsdom lays nothing out, so the bubble measures 0 wide and every clamp
 *  becomes a no-op. Give it a width. */
beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => PANEL_WIDTH,
  });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).offsetWidth;
});

// Plain DOM query, not getByRole: while the bubble is unmeasured it is
// visibility:hidden, and role queries skip anything hidden — which is exactly
// the state the third test below is about.
function wrapper(): HTMLElement {
  return document.querySelector('[role="status"]')!.parentElement as HTMLElement;
}

function arrow(): HTMLElement {
  return wrapper().querySelector('[aria-hidden="true"]') as HTMLElement;
}

describe('ViewToggleHint', () => {
  it('sits under the toggle and points at its centre', () => {
    mountAnchor(400); // centre 472, comfortably inside a 1024px window
    render(<ViewToggleHint onDismiss={vi.fn()} />);
    expect(wrapper().style.top).toBe(`${ANCHOR_BOTTOM + 8}px`);
    expect(wrapper().style.left).toBe(`${472 - PANEL_WIDTH / 2}px`);
    // Arrow offset is relative to the bubble, and the bubble is centred here.
    expect(arrow().style.left).toBe(`${PANEL_WIDTH / 2 - 5}px`);
  });

  it('stays on screen when the toggle is near the left edge, and re-aims the arrow', () => {
    mountAnchor(76); // centre 148 — a centred 300px bubble would start at -2
    render(<ViewToggleHint onDismiss={vi.fn()} />);
    expect(wrapper().style.left).toBe('8px');
    // Still pointing at the toggle's real centre, now off-centre in the bubble.
    expect(arrow().style.left).toBe(`${148 - 8 - 5}px`);
  });

  it('hides rather than parking itself in the corner when there is no toggle', () => {
    render(<ViewToggleHint onDismiss={vi.fn()} />);
    expect(wrapper().style.visibility).toBe('hidden');
  });

  it('the ✕ reports the dismissal', () => {
    const onDismiss = vi.fn();
    mountAnchor(400);
    render(<ViewToggleHint onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText('Dismiss hint'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});
