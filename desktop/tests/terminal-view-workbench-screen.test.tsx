// @vitest-environment jsdom
//
// UI Workbench terminal mock-ups (ledger P-20.1 / P-20.2, 2026-08-27):
//   1. under `?mode=workbench` TerminalView writes the canned Claude Code screen
//      (there is no PTY, so the pane used to be blank);
//   2. `?termBacking=solid90` switches xterm to an opaque --panel background at
//      grid opacity 0.9; `today` (or no param) applies none of it;
//   3. outside workbench mode — the app — NOTHING is written and no backing is
//      applied, whatever the URL says. That third case is the one that matters:
//      the real PTY terminal must be byte-for-byte what it was.
//
// xterm mocks mirror tests/terminal-view-touch-mode.test.tsx.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const terminalCtorArgs: any[] = [];
const writeSpy = vi.fn();

vi.mock('@xterm/xterm', () => {
  return {
    Terminal: vi.fn(function (this: any, opts: any) {
      terminalCtorArgs.push(opts);
      this.loadAddon = vi.fn();
      this.open = vi.fn();
      this.unicode = { activeVersion: '11' };
      this.attachCustomKeyEventHandler = vi.fn();
      this.onData = vi.fn();
      this.onScroll = vi.fn().mockReturnValue({ dispose: vi.fn() });
      this.write = writeSpy;
      this.refresh = vi.fn();
      this.focus = vi.fn();
      this.blur = vi.fn();
      this.dispose = vi.fn();
      this.clearTextureAtlas = vi.fn();
      this.hasSelection = vi.fn().mockReturnValue(false);
      this.getSelection = vi.fn().mockReturnValue('');
      this.paste = vi.fn();
      this.options = {};
      this.cols = 100;
      this.rows = 30;
      this.buffer = { active: { length: 30, viewportY: 0, ydisp: 0 } };
      this.scrollLines = vi.fn();
    }),
  };
});

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: vi.fn(function (this: any) {
    this.fit = vi.fn();
    this.proposeDimensions = vi.fn().mockReturnValue({ cols: 100, rows: 30 });
  }),
}));
vi.mock('@xterm/addon-unicode11', () => ({ Unicode11Addon: vi.fn(function (this: any) {}) }));
vi.mock('@xterm/addon-webgl', () => ({
  WebglAddon: vi.fn(function (this: any) {
    this.onContextLoss = vi.fn();
    this.dispose = vi.fn();
  }),
}));
vi.mock('@xterm/xterm/css/xterm.css', () => ({}));
vi.mock('../src/renderer/platform', () => ({
  isAndroid: vi.fn().mockReturnValue(false),
  isTouchDevice: vi.fn().mockReturnValue(false),
  getPlatform: vi.fn().mockReturnValue('electron'),
}));
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({ activeTheme: null, reducedEffects: false }),
}));
vi.mock('../src/renderer/hooks/terminal-registry', () => ({
  registerTerminal: vi.fn(),
  unregisterTerminal: vi.fn(),
  notifyBufferReady: vi.fn(),
}));
vi.mock('../src/renderer/hooks/useIpc', () => ({ usePtyOutput: vi.fn() }));
vi.mock('../src/renderer/hooks/usePtyRawBytes', () => ({ usePtyRawBytes: vi.fn() }));

import TerminalView from '../src/renderer/components/TerminalView';
import { renderTerminalScreen } from '../src/renderer/dev/workbench/fixtures/terminal-screen';

// The detection reads `location.search` at mount, exactly as index.tsx and
// WorkbenchFrame do — so the tests drive it through the real URL rather than a
// mocked helper. `import.meta.env.DEV` is true under vitest.
function setUrl(search: string) {
  window.history.replaceState({}, '', `/${search}`);
}

// jsdom lays nothing out, so every element is 0×0 and TerminalView's fit
// guard ("skip when collapsed") would never run a fit — and the canned screen
// is written on the first fit that runs. Give the grid container a size so the
// mount-timer fit goes through, exactly as it does once the pane is visible.
Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 700; } });

const container = () => document.querySelector('[data-term-backing]') as HTMLElement;

beforeEach(() => {
  terminalCtorArgs.length = 0;
  writeSpy.mockReset();
  (globalThis as any).window.claude = {
    session: { signalReady: vi.fn(), sendInput: vi.fn(), resize: vi.fn() },
  };
});

afterEach(() => {
  cleanup();
  setUrl('');
  delete (globalThis as any).window.claude;
});

describe('TerminalView in the UI Workbench (?mode=workbench)', () => {
  it('writes the canned Claude Code screen once, sized to the terminal grid', async () => {
    setUrl('?mode=workbench');
    render(<TerminalView sessionId="s1" visible={true} />);
    // The write is scheduled behind the 100ms initial-fit timer plus a dynamic
    // import; waitFor polls until it lands.
    await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
    const text: string = writeSpy.mock.calls[0][0];
    expect(text).toContain('Claude Code v2');
    expect(text).toContain('/home/destin/youcoded-dev/youcoded');
    expect(text).toContain('› ');
    expect(text).toContain('? for shortcuts');
    // Built for the mocked 100×30 grid — the fixture pads to the row count and
    // rules the prompt box across the column count.
    expect(text).toBe(renderTerminalScreen(100, 30));
    // Later fits (window resize → fitAndSync) must not write it again.
    window.dispatchEvent(new Event('resize'));
    window.dispatchEvent(new Event('resize'));
    await new Promise((r) => setTimeout(r, 50));
    expect(writeSpy).toHaveBeenCalledTimes(1);
  });

  it('writes nothing until a fit actually runs (a collapsed 0×0 container skips the fit)', async () => {
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 0; } });
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 0; } });
    try {
      setUrl('?mode=workbench');
      render(<TerminalView sessionId="s1" visible={true} />);
      await new Promise((r) => setTimeout(r, 300));
      expect(writeSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get() { return 1200; } });
      Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 700; } });
    }
  });

  // jsdom's getComputedStyle returns '' for every CSS variable, so xterm's
  // theme falls back to getXtermTheme's literal defaults: '#0A0A0A' for the
  // canvas token, '#191919' for the panel token. Asserting those tells the two
  // tokens apart without a real stylesheet.
  const CANVAS_FALLBACK = '#0A0A0A';
  const PANEL_FALLBACK = '#191919';

  it('`today` (the default) applies no backing: shipped opacity, --canvas xterm', () => {
    setUrl('?mode=workbench&termBacking=today');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('today');
    // Solid theme (activeTheme null) → shipped path forces opacity 1 and paints
    // --canvas on the grid container.
    expect(container().style.opacity).toBe('1');
    expect(container().style.backgroundColor).toBe('var(--canvas)');
    expect(terminalCtorArgs[0].allowTransparency).toBeUndefined();
    expect(terminalCtorArgs[0].theme.background).toBe(CANVAS_FALLBACK);
  });

  it('`solid90` paints an opaque --panel xterm with the grid at 0.9', () => {
    setUrl('?mode=workbench&termBacking=solid90');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('solid90');
    expect(container().style.opacity).toBe('0.9');
    expect(container().style.backgroundColor).toBe('var(--panel)');
    // Still opaque — no allowTransparency (see workbench-mode.ts for why).
    expect(terminalCtorArgs[0].allowTransparency).toBeUndefined();
    expect(terminalCtorArgs[0].theme.background).toBe(PANEL_FALLBACK);
  });

  it('`solid100` is the same --panel xterm, fully opaque', () => {
    setUrl('?mode=workbench&termBacking=solid100');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('solid100');
    expect(container().style.opacity).toBe('1');
    expect(container().style.backgroundColor).toBe('var(--panel)');
    expect(terminalCtorArgs[0].theme.background).toBe(PANEL_FALLBACK);
  });

  it('`scrim` keeps the --canvas xterm (today\'s mechanism) and raises the grid opacity to 0.85', () => {
    setUrl('?mode=workbench&termBacking=scrim');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('scrim');
    expect(container().style.opacity).toBe('0.85');
    expect(container().style.backgroundColor).toBe('var(--canvas)');
    expect(terminalCtorArgs[0].theme.background).toBe(CANVAS_FALLBACK);
  });

  it('an unknown termBacking value falls back to `today`', () => {
    setUrl('?mode=workbench&termBacking=nonsense');
    render(<TerminalView sessionId="s1" visible={true} />);
    expect(container().dataset.termBacking).toBe('today');
    expect(container().style.backgroundColor).toBe('var(--canvas)');
  });
});

describe('TerminalView in the app (no ?mode=workbench)', () => {
  it('writes nothing and applies no backing even if ?termBacking= is present', async () => {
    setUrl('?termBacking=solid90');
    render(<TerminalView sessionId="s1" visible={true} />);
    // Give the 100ms initial-fit timer (and any import it might have kicked
    // off) ample time to run before asserting the negative.
    await new Promise((r) => setTimeout(r, 300));
    expect(writeSpy).not.toHaveBeenCalled();
    expect(container().dataset.termBacking).toBe('today');
    expect(container().style.opacity).toBe('1');
    expect(container().style.backgroundColor).toBe('var(--canvas)');
    expect(terminalCtorArgs[0].allowTransparency).toBeUndefined();
    expect(terminalCtorArgs[0].theme.background).toBe('#0A0A0A');
  });
});
