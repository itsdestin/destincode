// @vitest-environment jsdom
// Fix: pin jsdom explicitly (see use-esc-close.test.tsx for why) — this file
// lives under src/**/*.test.ts, outside vitest.config.ts's tests/**/*.tsx
// auto-jsdom glob.
//
// Dev-review fix B: "it doesn't show that I was asking about a specific
// selection" — this is the half of the fix that mutates the (detached)
// CLONE to visually mark the referenced span. These tests fail against the
// pre-fix code because applyHighlightMark doesn't exist there at all.
import { describe, it, expect } from 'vitest';
import { applyHighlightMark } from './apply-highlight';

describe('applyHighlightMark', () => {
  it('wraps a substring within a single text node in <mark class="reference-mark">', () => {
    const root = document.createElement('div');
    root.textContent = 'alpha bravo charlie';
    document.body.appendChild(root);

    applyHighlightMark(root, 6, 11); // "bravo"

    const mark = root.querySelector('mark.reference-mark');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('bravo');
    // The surrounding text must survive unmutated — only the covered run is
    // wrapped, not swallowed or duplicated.
    expect(root.textContent).toBe('alpha bravo charlie');

    document.body.removeChild(root);
  });

  it('wraps only the highlighted run, leaving prefix/suffix as plain text siblings', () => {
    const root = document.createElement('div');
    root.textContent = 'alpha bravo charlie';
    document.body.appendChild(root);

    applyHighlightMark(root, 6, 11);

    // Expect three top-level children of root: text "alpha ", <mark>bravo</mark>, text " charlie".
    const children = Array.from(root.childNodes);
    expect(children.map((n) => n.textContent)).toEqual(['alpha ', 'bravo', ' charlie']);
    expect((children[1] as Element).tagName).toBe('MARK');
    expect((children[1] as Element).className).toBe('reference-mark');

    document.body.removeChild(root);
  });

  it('handles a span crossing multiple text nodes — wraps each covered run separately', () => {
    // Two sibling <span> elements, each with its own text node, standing in
    // for e.g. two adjacent syntax-highlighted tokens in a code clone.
    const root = document.createElement('div');
    const spanA = document.createElement('span');
    spanA.textContent = 'alpha ';
    const spanB = document.createElement('span');
    spanB.textContent = 'bravo';
    root.appendChild(spanA);
    root.appendChild(spanB);
    document.body.appendChild(root);

    // Full text is "alpha bravo" (11 chars). Highlight "ha br" (offsets 3-8),
    // which straddles the boundary between spanA ("alpha ", 0-6) and spanB
    // ("bravo", 6-11).
    applyHighlightMark(root, 3, 8);

    const marks = root.querySelectorAll('mark.reference-mark');
    expect(marks).toHaveLength(2); // one run per covered text node — not one mark spanning across elements
    expect(Array.from(marks).map((m) => m.textContent)).toEqual(['ha ', 'br']);
    // Nothing lost or duplicated across the whole subtree.
    expect(root.textContent).toBe('alpha bravo');

    document.body.removeChild(root);
  });

  it('highlights the ENTIRE text node when the span exactly covers it (no split needed)', () => {
    const root = document.createElement('div');
    root.textContent = 'bravo';
    document.body.appendChild(root);

    applyHighlightMark(root, 0, 5);

    expect(root.childNodes).toHaveLength(1);
    const only = root.firstChild as Element;
    expect(only.tagName).toBe('MARK');
    expect(only.textContent).toBe('bravo');

    document.body.removeChild(root);
  });

  it('is a no-op (no throw, no DOM change) when the span is empty or inverted', () => {
    const root = document.createElement('div');
    root.textContent = 'alpha bravo';
    document.body.appendChild(root);
    const before = root.outerHTML;

    applyHighlightMark(root, 5, 5); // empty
    applyHighlightMark(root, 8, 3); // inverted
    expect(root.outerHTML).toBe(before);

    document.body.removeChild(root);
  });

  it('is a no-op (no throw, no DOM change) when the offsets fall entirely outside the text', () => {
    const root = document.createElement('div');
    root.textContent = 'short';
    document.body.appendChild(root);
    const before = root.outerHTML;

    applyHighlightMark(root, 100, 200); // "offsets can't be resolved" case from the task brief
    expect(root.outerHTML).toBe(before);

    document.body.removeChild(root);
  });

  it('clamps a span that starts inside the text but runs past its end', () => {
    const root = document.createElement('div');
    root.textContent = 'bravo';
    document.body.appendChild(root);

    applyHighlightMark(root, 2, 999); // "avo" is all that exists past offset 2

    const mark = root.querySelector('mark.reference-mark');
    expect(mark).not.toBeNull();
    expect(mark?.textContent).toBe('avo');
    expect(root.textContent).toBe('bravo');

    document.body.removeChild(root);
  });
});
