// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// INVARIANT: on the 'os-drag' tear-off model (Linux/Wayland), a session dropped
// on this window's strip is claimed by it, a foreign file drop is left alone,
// and the strip accepts the drop as a COPY.
//
// That last one looks like a detail and is not. The drag is a file drag, so the
// source offers 'copy'; a target asking for 'move' has its drop rejected by
// Chromium SILENTLY — dragover keeps firing forever and the drop event simply
// never arrives. Measured on KDE/Wayland 2026-09-04: three drags, zero drops,
// no error anywhere. It read exactly like "the compositor won't deliver drops"
// and nearly sank the design. Do not "correct" 'copy' to 'move' because a
// session is being moved.
//
// What jsdom CANNOT prove is that the compositor delivers a drag between two
// real windows at all; that was measured directly instead (two-window probe,
// 2026-09-04: drops in both directions, session id intact). What is pinned here
// is the routing, which is where a regression would actually hide.
// ---------------------------------------------------------------------------
import {
  describe, it, expect, vi, beforeEach, beforeAll, afterAll,
} from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import SessionStrip from '../src/renderer/components/SessionStrip';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { dragFileNameFor } from '../src/renderer/session-drag-model';

const MY_WINDOW = 1;

const detach = {
  dragAdopt: vi.fn(),
  dragHandoff: vi.fn(async () => ({ outcome: 'adopted' as const })),
  detachLive: vi.fn(async () => ({ windowId: 2 })),
  detachStart: vi.fn(),
  dragStarted: vi.fn(),
  dragEnded: vi.fn(),
  dragDropped: vi.fn(),
  openDetached: vi.fn(),
  dropResolve: vi.fn(async () => ({ targetWindowId: null })),
  getDirectory: vi.fn(async () => ({ leaderWindowId: MY_WINDOW, windows: [] })),
  onCrossWindowCursor: vi.fn(() => () => {}),
  onDirectoryUpdated: vi.fn(() => () => {}),
};

// The strip packs its pills against the bar parent's clientWidth, which jsdom
// reports as 0 — leaving exactly ONE pill rendered. Hand it a real budget.
//
// The canvas stub is not cosmetic: the strip measures pill labels with
// measureText, and jsdom answers getContext with a "Not implemented" console
// error per call. Fourteen of those per run bury a real failure.
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, value: 1200 });
  (HTMLCanvasElement.prototype as any).getContext = () => ({
    measureText: (t: string) => ({ width: t.length * 7 }),
    font: '',
  });
});
afterAll(() => {
  delete (HTMLElement.prototype as any).clientWidth;
});

let facts: { platform: string; wayland: boolean } = { platform: 'linux', wayland: true };

beforeEach(() => {
  vi.clearAllMocks();
  (window as any).claude = {
    detach,
    platformFacts: facts,
    tags: { list: async () => [] },
    on: { tagsChanged: () => () => {} },
  };
});

function sess(id: string, name: string) {
  return { id, name, cwd: '/tmp', status: 'active', permissionMode: 'normal' } as any;
}

function mount() {
  const view = render(
    <ArtifactProvider value={{ state: {} as any, dispatch: vi.fn() } as any}>
      <SessionStrip
        sessions={[sess('a', 'alpha'), sess('b', 'beta')]}
        activeSessionId="a"
        onSelectSession={vi.fn()}
        onCreateSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenResumeBrowser={vi.fn()}
        onReorderSessions={vi.fn()}
        myWindowId={MY_WINDOW}
      />
    </ArtifactProvider>,
  );
  const bar = view.container.querySelector('[data-session-strip]') as HTMLElement;
  const pills = Array.from(view.container.querySelectorAll('[data-session-idx]')) as HTMLElement[];
  return { ...view, bar, pills };
}

/**
 * jsdom has no DataTransfer. Model only what the handlers read — and model
 * `files` as the real thing does: the NAME is all that carries, because
 * Electron's startDrag is the only mid-gesture drag API and it drags files.
 */
function fileDrag(names: string[]) {
  return {
    get types() { return names.length ? ['Files'] : []; },
    files: names.map((name) => ({ name })),
    dropEffect: 'move',
    effectAllowed: 'copy',
  };
}

describe('SessionStrip — receiving an os-drag (Linux/Wayland)', () => {
  it('claims a session dropped on it from another window', () => {
    const { bar } = mount();
    const dt = fileDrag([dragFileNameFor('from-elsewhere')]);
    fireEvent.dragOver(bar, { dataTransfer: dt });
    fireEvent.drop(bar, { dataTransfer: dt });
    expect(detach.dragAdopt).toHaveBeenCalledWith({ sessionId: 'from-elsewhere' });
  });

  it('the claim names ONLY the session — main resolves the owner itself', () => {
    const { bar } = mount();
    const dt = fileDrag([dragFileNameFor('from-elsewhere')]);
    fireEvent.drop(bar, { dataTransfer: dt });
    // A renderer-supplied source window could misdirect a transfer, so none is sent.
    expect(Object.keys(detach.dragAdopt.mock.calls[0][0])).toEqual(['sessionId']);
  });

  it('accepts the drop as a COPY — asking for a move makes Chromium drop it silently', () => {
    const { bar } = mount();
    const dt = fileDrag([dragFileNameFor('x')]);
    fireEvent.dragOver(bar, { dataTransfer: dt });
    expect(dt.dropEffect).toBe('copy');
  });

  it('leaves a real file drop completely alone', () => {
    const { bar } = mount();
    const dt = fileDrag(['quarterly-report.pdf']);
    fireEvent.dragOver(bar, { dataTransfer: dt });
    fireEvent.drop(bar, { dataTransfer: dt });
    expect(detach.dragAdopt).not.toHaveBeenCalled();
  });

  it('ignores a drag carrying no files at all — a link, selected text', () => {
    const { bar } = mount();
    const foreign = { types: ['text/plain'], files: [], dropEffect: 'move', effectAllowed: 'copy' };
    fireEvent.dragOver(bar, { dataTransfer: foreign as any });
    fireEvent.drop(bar, { dataTransfer: foreign as any });
    expect(detach.dragAdopt).not.toHaveBeenCalled();
    // Untouched: a target that never asked for the drop must not claim the effect.
    expect(foreign.dropEffect).toBe('move');
  });

  it('never makes the pills HTML5-draggable — the pointer path owns the gesture', () => {
    // This is what keeps the strip's in-strip motion alive. A draggable pill
    // gets a browser-run drag at mouse-down and stops sending pointermove, so
    // nothing could animate. The OS drag is entered later, deliberately, only
    // once the pill is clear of the strip.
    const { pills } = mount();
    expect(pills.some((p) => p.getAttribute('draggable') === 'true')).toBe(false);
  });
});

describe('SessionStrip — every other platform is untouched', () => {
  // beforeAll, not beforeEach: the outer beforeEach copies `facts` onto
  // window.claude and runs FIRST, so a sibling beforeEach would set it one
  // test too late — and the test would pass for the wrong reason.
  beforeAll(() => { facts = { platform: 'win32', wayland: false }; });
  afterAll(() => { facts = { platform: 'linux', wayland: true }; });

  it('does not claim a dropped session: Windows keeps the live tear-off', () => {
    const { bar } = mount();
    const dt = fileDrag([dragFileNameFor('from-elsewhere')]);
    fireEvent.dragOver(bar, { dataTransfer: dt });
    fireEvent.drop(bar, { dataTransfer: dt });
    expect(detach.dragAdopt).not.toHaveBeenCalled();
    expect(dt.dropEffect).toBe('move'); // never claimed the drag either
  });
});
