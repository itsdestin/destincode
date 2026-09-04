// @vitest-environment jsdom
//
// ---------------------------------------------------------------------------
// INVARIANT: on the 'html-drag' tear-off model (Linux/Wayland) the pill is a
// browser-native draggable whose drag carries the session id under the private
// MIME type and offers 'move'; a session dropped on this window's strip from
// another window is claimed by it; our own pill dropped back on the strip is a
// reorder; a foreign file drop is left alone; and the pills are NOT draggable
// on any other platform, where the pointer path owns the whole gesture.
//
// What jsdom CANNOT prove is that the compositor delivers a drag between two
// real windows, or what the picture looks like; both were measured directly
// (two-window probe, 2026-09-04: drops in both directions, session id intact,
// a 330px picture whole and crisp at 1.5x). What is pinned here is the
// routing, which is where a regression would actually hide.
// ---------------------------------------------------------------------------
import {
  describe, it, expect, vi, beforeEach, beforeAll, afterAll,
} from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import SessionStrip from '../src/renderer/components/SessionStrip';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { SESSION_DRAG_MIME, endLocalSessionDrag } from '../src/renderer/session-drag-model';

const MY_WINDOW = 1;

const detach = {
  dragAdopt: vi.fn(),
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
  endLocalSessionDrag();
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

function mount(extra: Partial<React.ComponentProps<typeof SessionStrip>> = {}) {
  const onReorderSessions = vi.fn();
  const onSelectSession = vi.fn();
  const view = render(
    <ArtifactProvider value={{ state: {} as any, dispatch: vi.fn() } as any}>
      <SessionStrip
        sessions={[sess('a', 'alpha'), sess('b', 'beta'), sess('c', 'gamma')]}
        activeSessionId="a"
        onSelectSession={onSelectSession}
        onCreateSession={vi.fn()}
        onCloseSession={vi.fn()}
        onOpenResumeBrowser={vi.fn()}
        onReorderSessions={onReorderSessions}
        myWindowId={MY_WINDOW}
        {...extra}
      />
    </ArtifactProvider>,
  );
  const bar = view.container.querySelector('[data-session-strip]') as HTMLElement;
  const pills = Array.from(view.container.querySelectorAll('[data-session-idx]')) as HTMLElement[];
  return { ...view, bar, pills, onReorderSessions, onSelectSession };
}

/** jsdom has no DataTransfer. Model what the real one does with types/data. */
function transfer(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    get types() { return Array.from(data.keys()); },
    setData: (t: string, v: string) => { data.set(t, v); },
    getData: (t: string) => data.get(t) ?? '',
    setDragImage: vi.fn(),
    dropEffect: 'none',
    effectAllowed: 'uninitialized',
    files: [] as { name: string }[],
  };
}
const sessionDrag = (id: string) => transfer({ [SESSION_DRAG_MIME]: id });
const fileDrag = () => Object.assign(transfer({ Files: '' }), { files: [{ name: 'quarterly-report.pdf' }] });

describe('SessionStrip — html-drag (Linux/Wayland)', () => {
  it('makes every pill a browser draggable', () => {
    const { pills } = mount();
    expect(pills.length).toBe(3);
    expect(pills.every((p) => p.getAttribute('draggable') === 'true')).toBe(true);
  });

  it('dragstart carries the session id under the private type and offers a MOVE', () => {
    const { pills } = mount();
    const dt = transfer();
    fireEvent.pointerDown(pills[1], { button: 0, clientX: 100, clientY: 10, pointerId: 1, pointerType: 'mouse' });
    fireEvent.dragStart(pills[1], { dataTransfer: dt, clientX: 100, clientY: 10 });
    expect(dt.getData(SESSION_DRAG_MIME)).toBe('b');
    expect(dt.effectAllowed).toBe('move');
    // The picture is the pill itself, snapshotted — never main's link-drag helper.
    expect(dt.setDragImage).toHaveBeenCalled();
    // No screen-coordinate ticker: on Wayland it would stream zeros.
    expect(detach.dragStarted).not.toHaveBeenCalled();
  });

  it('claims a session dropped on it from another window, naming ONLY the session', () => {
    const { bar } = mount();
    const dt = sessionDrag('from-elsewhere');
    fireEvent.dragOver(bar, { dataTransfer: dt });
    expect(dt.dropEffect).toBe('move');
    fireEvent.drop(bar, { dataTransfer: dt });
    expect(detach.dragAdopt).toHaveBeenCalledWith({ sessionId: 'from-elsewhere' });
    // A renderer-supplied source window could misdirect a transfer, so none is sent.
    expect(Object.keys(detach.dragAdopt.mock.calls[0][0])).toEqual(['sessionId']);
  });

  it('our own pill dropped back on the strip is a reorder, not an adoption', () => {
    const { bar, pills, onReorderSessions, onSelectSession } = mount();
    const dt = transfer();
    fireEvent.pointerDown(pills[0], { button: 0, clientX: 20, clientY: 10, pointerId: 1, pointerType: 'mouse' });
    fireEvent.dragStart(pills[0], { dataTransfer: dt, clientX: 20, clientY: 10 });
    // jsdom lays nothing out, so no slot is ever "nearest": the drop lands
    // in place. What is pinned is the ROUTE — local commit, no adopt.
    fireEvent.dragOver(bar, { dataTransfer: dt, clientX: 200, clientY: 10 });
    fireEvent.drop(bar, { dataTransfer: dt, clientX: 200, clientY: 10 });
    expect(detach.dragAdopt).not.toHaveBeenCalled();
    expect(onSelectSession).toHaveBeenCalledWith('a');
    expect(onReorderSessions.mock.calls.every(([from, to]) => typeof from === 'number' && typeof to === 'number')).toBe(true);
  });

  it('leaves a real file drop completely alone', () => {
    const { bar } = mount();
    const dt = fileDrag();
    fireEvent.dragOver(bar, { dataTransfer: dt });
    fireEvent.drop(bar, { dataTransfer: dt });
    expect(detach.dragAdopt).not.toHaveBeenCalled();
    expect(dt.dropEffect).toBe('none'); // never claimed the drag
  });

  it('never opens a window from dragend — "released over nothing" and Escape look identical', () => {
    const { pills } = mount();
    const dt = transfer();
    fireEvent.pointerDown(pills[0], { button: 0, clientX: 20, clientY: 10, pointerId: 1, pointerType: 'mouse' });
    fireEvent.dragStart(pills[0], { dataTransfer: dt, clientX: 20, clientY: 10 });
    fireEvent.dragEnd(pills[0], { dataTransfer: dt });
    expect(detach.openDetached).not.toHaveBeenCalled();
    expect(detach.detachStart).not.toHaveBeenCalled();
  });

  it('right-click offers "Move to new window" and every other window by name', () => {
    const { pills, getByText } = mount({
      windowDirectory: {
        leaderWindowId: MY_WINDOW,
        windows: [
          { window: { id: MY_WINDOW, label: 'window 1', createdAt: 0 }, sessions: [] },
          { window: { id: 7, label: 'window 2', createdAt: 0 }, sessions: [sess('z', 'zeta')] },
        ],
      } as any,
    });
    fireEvent.contextMenu(pills[1], { clientX: 50, clientY: 20 });
    fireEvent.click(getByText('Move to new window'));
    expect(detach.openDetached).toHaveBeenCalledWith({ sessionId: 'b' });
    fireEvent.contextMenu(pills[1], { clientX: 50, clientY: 20 });
    fireEvent.click(getByText(/Move to window 2/));
    expect(detach.dragDropped).toHaveBeenCalledWith({ sessionId: 'b', targetWindowId: 7, insertIndex: 0 });
  });

  it('the menu refuses to tear off a window\'s only session', () => {
    const { pills, getByText } = mount({ sessions: [sess('only', 'solo')] });
    fireEvent.contextMenu(pills[0], { clientX: 50, clientY: 20 });
    const item = getByText('Move to new window').closest('button, [role="menuitem"]') as HTMLElement;
    expect(item).toBeTruthy();
    expect(item.getAttribute('aria-disabled') === 'true' || (item as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(item);
    expect(detach.openDetached).not.toHaveBeenCalled();
  });
});

describe('SessionStrip — every other platform is untouched', () => {
  // beforeAll, not beforeEach: the outer beforeEach copies `facts` onto
  // window.claude and runs FIRST, so a sibling beforeEach would set it one
  // test too late — and the test would pass for the wrong reason.
  beforeAll(() => { facts = { platform: 'win32', wayland: false }; });
  afterAll(() => { facts = { platform: 'linux', wayland: true }; });

  it('pills are not browser-draggable: the pointer path owns the gesture', () => {
    const { pills } = mount();
    expect(pills.some((p) => p.getAttribute('draggable') === 'true')).toBe(false);
  });

  it('does not claim a dropped session: Windows keeps the live tear-off', () => {
    const { bar } = mount();
    const dt = sessionDrag('from-elsewhere');
    fireEvent.dragOver(bar, { dataTransfer: dt });
    fireEvent.drop(bar, { dataTransfer: dt });
    expect(detach.dragAdopt).not.toHaveBeenCalled();
    expect(dt.dropEffect).toBe('none'); // never claimed the drag either
  });
});
