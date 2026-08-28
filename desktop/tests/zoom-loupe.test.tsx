// @vitest-environment jsdom
// jsdom ships NO canvas 2D context: getContext('2d') returns null and logs
// "Not implemented". The lens must survive that — which is also a real
// production defense on a context-starved device, so it is worth pinning.
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, cleanup, fireEvent, act } from '@testing-library/react';
import { Loupe } from '../src/renderer/components/artifact-views/zoom/Loupe';

// jsdom has no rAF-with-real-frames; drive it manually so the draw loop runs
// exactly as many times as the test wants.
let frames: FrameRequestCallback[] = [];
beforeEach(() => {
  frames = [];
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {});
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function tick() {
  const pending = frames;
  frames = [];
  act(() => { pending.forEach((cb) => cb(0)); });
}

function sourceEl(width = 800, height = 600) {
  const el = document.createElement('canvas');
  el.getBoundingClientRect = () => ({
    width, height, left: 0, top: 0, right: width, bottom: height, x: 0, y: 0, toJSON: () => ({}),
  }) as DOMRect;
  return el;
}

describe('Loupe', () => {
  it('renders and no-ops when there is no 2D context', () => {
    const { container } = render(
      <Loupe resolveSource={() => ({ el: sourceEl() })} displayScale={1} />,
    );
    fireEvent.pointerMove(window, { clientX: 10, clientY: 10 });
    expect(() => tick()).not.toThrow();
    expect(container.querySelector('canvas')).toBeTruthy();
  });

  it('hides itself when the pointer resolves to no source', () => {
    const { container } = render(<Loupe resolveSource={() => null} displayScale={1} />);
    fireEvent.pointerMove(window, { clientX: 5, clientY: 5 });
    tick();
    const lens = container.firstElementChild as HTMLElement;
    expect(lens.style.visibility).toBe('hidden');
  });

  it('hides itself over a source smaller than the lens', () => {
    // A 16px favicon under a 180px lens is four fat pixels and reads as broken.
    const { container } = render(
      <Loupe resolveSource={() => ({ el: sourceEl(16, 16) })} displayScale={1} />,
    );
    fireEvent.pointerMove(window, { clientX: 8, clientY: 8 });
    tick();
    expect((container.firstElementChild as HTMLElement).style.visibility).toBe('hidden');
  });

  it('follows the cursor by transform, without a React re-render per move', () => {
    let renders = 0;
    function Counting() {
      renders++;
      return <Loupe resolveSource={() => ({ el: sourceEl() })} displayScale={1} />;
    }
    const { container } = render(<Counting />);
    const before = renders;
    fireEvent.pointerMove(window, { clientX: 300, clientY: 200 });
    tick();
    const lens = container.firstElementChild as HTMLElement;
    expect(lens.style.visibility).toBe('visible');
    expect(lens.style.transform).toContain('translate(');
    expect(renders).toBe(before);   // cursor tracking must not re-render React
  });

  it('hides over a control that must stay usable', () => {
    // The lens parked itself on top of the pill that turns it off, making the
    // magnifier impossible to switch off (reported 2026-08-27). Anything marked
    // data-loupe-block is off limits.
    const block = document.createElement('div');
    block.setAttribute('data-loupe-block', '');
    block.getBoundingClientRect = () => ({
      left: 200, top: 0, right: 340, bottom: 40, width: 140, height: 40, x: 200, y: 0, toJSON: () => ({}),
    }) as DOMRect;
    document.body.appendChild(block);

    const { container } = render(
      <Loupe resolveSource={() => ({ el: sourceEl() })} displayScale={1} />,
    );
    fireEvent.pointerMove(window, { clientX: 250, clientY: 20 });   // over the control
    tick();
    expect((container.firstElementChild as HTMLElement).style.visibility).toBe('hidden');

    fireEvent.pointerMove(window, { clientX: 250, clientY: 300 });  // over the picture
    tick();
    expect((container.firstElementChild as HTMLElement).style.visibility).toBe('visible');
    block.remove();
  });

  it('hides outside the pane that clips the picture', () => {
    // A picture zoomed past its pane is only trimmed by CSS overflow: its rect
    // still reports the whole untrimmed box, so hit-testing the picture alone
    // sent the lens out over the chat pane, magnifying off-screen margin
    // (reported 2026-08-27). The clip box is the second gate.
    const pane = document.createElement('div');
    pane.getBoundingClientRect = () => ({
      left: 100, top: 100, right: 400, bottom: 500, width: 300, height: 400, x: 100, y: 100, toJSON: () => ({}),
    }) as DOMRect;
    const clipTo = { current: pane };

    const { container } = render(
      // Source spans 0,0..800,600 — wider than the pane on the left.
      <Loupe resolveSource={() => ({ el: sourceEl() })} displayScale={1} clipTo={clipTo} />,
    );

    fireEvent.pointerMove(window, { clientX: 20, clientY: 300 });   // on the picture, outside the pane
    tick();
    expect((container.firstElementChild as HTMLElement).style.visibility).toBe('hidden');

    fireEvent.pointerMove(window, { clientX: 200, clientY: 300 });  // inside the pane
    tick();
    expect((container.firstElementChild as HTMLElement).style.visibility).toBe('visible');
  });

  it('goes quiet behind a dialog', () => {
    // Reported 2026-08-27: with a dialog open, the lens kept tracking and
    // painting behind the scrim. It should not react when it is not the surface
    // being pointed at.
    const { container } = render(
      <Loupe resolveSource={() => ({ el: sourceEl() })} displayScale={1} />,
    );
    const lens = () => (container.firstElementChild as HTMLElement).style.visibility;

    fireEvent.pointerMove(window, { clientX: 250, clientY: 300 });
    tick();
    expect(lens()).toBe('visible');

    // A scrim element is mounted at ALL times and fades in/out, so an invisible
    // one must NOT hide the lens — testing for mere presence stopped the
    // magnifier working entirely (2026-08-27).
    const idle = document.createElement('div');
    idle.className = 'layer-scrim';
    idle.style.opacity = '0';
    document.body.appendChild(idle);
    tick();
    expect(lens()).toBe('visible');

    const scrim = document.createElement('div');
    scrim.className = 'layer-scrim';
    scrim.style.opacity = '1';
    document.body.appendChild(scrim);
    tick();
    expect(lens()).toBe('hidden');

    scrim.remove();
    tick();
    expect(lens()).toBe('visible');            // closing the dialog resumes it
    idle.remove();
  });

  it('never reads pixels back — canvas tainting must stay unreachable', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'src/renderer/components/artifact-views/zoom/Loupe.tsx'),
      'utf8',
    );
    // Call syntax, not the words — the file's own comment explains WHY it must
    // never read pixels back, and a prose mention is not a call.
    expect(src).not.toMatch(/\.(getImageData|toDataURL)\s*\(/);
  });
});
