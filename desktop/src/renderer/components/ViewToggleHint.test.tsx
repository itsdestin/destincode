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
const CHAT_WIDTH = 48;
const PANEL_WIDTH = 300;

/** A stand-in for the toggle: an outer box plus the Chat button inside it, which
 *  is what the arrow actually aims at (the pill's own centre is the seam between
 *  its two halves). The button occupies the left third, as Chat does. */
function mountAnchor(left: number): HTMLElement {
  const rect = (l: number, w: number) => () => ({
    x: l, y: 6, left: l, right: l + w,
    top: 6, bottom: ANCHOR_BOTTOM, width: w, height: 28,
    toJSON: () => ({}),
  }) as DOMRect;
  const el = document.createElement('div');
  el.setAttribute('data-view-toggle', '');
  el.getBoundingClientRect = rect(left, ANCHOR_WIDTH);
  const chat = document.createElement('button');
  chat.getBoundingClientRect = rect(left, CHAT_WIDTH);
  el.appendChild(chat);
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

// Direct child only: the ✕'s own glyph is aria-hidden too, and it comes first
// in document order now that the arrow paints after the bubble.
function arrow(): HTMLElement {
  return wrapper().querySelector(':scope > [aria-hidden="true"]') as HTMLElement;
}

describe('ViewToggleHint', () => {
  it('lines up under the toggle and aims at the chat button, not the pill', () => {
    mountAnchor(400); // chat button spans 400..448, so its centre is 424
    render(<ViewToggleHint onDismiss={vi.fn()} />);
    expect(wrapper().style.top).toBe(`${ANCHOR_BOTTOM + 8}px`);
    expect(wrapper().style.left).toBe('400px');
    // Arrow offset is relative to the bubble; 6 is half the arrow's width.
    expect(arrow().style.left).toBe(`${424 - 400 - 6}px`);
  });

  it('stays on screen when the toggle is near the right edge, and re-aims the arrow', () => {
    mountAnchor(800); // a 300px bubble from x=800 would run to 1100, past 1024
    render(<ViewToggleHint onDismiss={vi.fn()} />);
    expect(wrapper().style.left).toBe(`${1024 - PANEL_WIDTH - 8}px`);
    // Still pointing at the chat button's real centre, now off-centre in the bubble.
    expect(arrow().style.left).toBe(`${824 - (1024 - PANEL_WIDTH - 8) - 6}px`);
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
