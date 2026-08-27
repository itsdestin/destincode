// Workbench-mode detection for PRODUCTION components that need a dev-only
// branch (today: TerminalView's canned screen + backing mock-ups).
//
// WHY a separate module and not platform.ts: the existing terminal tests
// `vi.mock('../src/renderer/platform')` with a fixed factory, so a new export
// there would be `undefined` in every one of them and throw at first call.
//
// WHY the URL and not NODE_ENV or `window.__workbenchStore`: index.tsx boots
// the workbench on exactly `import.meta.env.DEV && ?mode=workbench`, and
// WorkbenchFrame stamps `mode=workbench` onto the child iframe it hosts, so the
// query param is the one signal present in every workbench document. The mock
// shim's globals are installed AFTER module evaluation and are absent in the
// unit-test environment. `import.meta.env.DEV` is statically `false` in a
// production build, so Vite folds every branch below to dead code — nothing in
// here can fire in Electron or the Android WebView.

/** True only inside the UI Workbench (`bash scripts/run-workbench.sh`). */
export function isWorkbenchMode(): boolean {
  // @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
  if (!import.meta.env.DEV) return false;
  if (typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('mode') === 'workbench';
}

/** Terminal backing variants for ledger P-20.2 (2026-08-27 UI review): how
 *  solid should the terminal's surface be under a wallpaper theme?
 *
 *  - `today`    — no change. xterm paints an opaque `--canvas` background and
 *                 the whole grid (text included) sits at
 *                 `--terminal-xterm-opacity` (theme `terminal-opacity`, default
 *                 0.6) over the blurred/darkened wallpaper layer.
 *  - `scrim`    — today's mechanism, stronger: the same opaque `--canvas` xterm
 *                 at 0.85 instead of 0.6. This is exactly what a theme pack
 *                 could ship today by setting `terminal-opacity: 0.85`.
 *  - `solid90`  — xterm paints `--panel` (opaque) and the grid sits at 0.9, so
 *                 the wallpaper shows through 10%.
 *  - `solid100` — the same `--panel` xterm at 1: the wallpaper is hidden
 *                 behind the grid.
 *
 *  WHY the solids keep xterm OPAQUE instead of a transparent xterm over a
 *  --panel layer (which was built first, 2026-08-27): with `allowTransparency`
 *  the WebGL glyph atlas paints an opaque black cell behind every DIM glyph,
 *  so each `⎿ …` line and the shortcuts hint rendered on a black bar — an
 *  artefact of transparency, not of the backing, and real Claude Code output
 *  is full of dim text. The opaque form needs no `allowTransparency` (a
 *  measured xterm perf cost), no override of the `.xterm-viewport` colour, and
 *  is one theme value away from shipping. The only visible difference is that
 *  `solid90` text is drawn at 0.9 rather than 1.
 *
 *  The SHIPPING version of whichever wins is a theme guarantee (a value in the
 *  theme manifest / theme-engine default), NOT a query param — this switch
 *  exists only so all four can be screenshotted side by side. */
export type TerminalBacking = 'today' | 'scrim' | 'solid90' | 'solid100';

const TERMINAL_BACKINGS: ReadonlyArray<TerminalBacking> = ['today', 'scrim', 'solid90', 'solid100'];

/** Reads `?termBacking=`; anything unrecognised (or not in workbench mode) is
 *  `today`, so a typo renders the shipped terminal rather than a blank pane. */
export function workbenchTerminalBacking(): TerminalBacking {
  if (!isWorkbenchMode()) return 'today';
  const raw = new URLSearchParams(location.search).get('termBacking') ?? 'today';
  return (TERMINAL_BACKINGS as readonly string[]).includes(raw) ? (raw as TerminalBacking) : 'today';
}

/** Per-variant knobs TerminalView applies. `xtermOpacity` replaces the grid
 *  container's `--terminal-xterm-opacity`; `xtermBackground` is which theme
 *  token xterm paints as its (opaque) background. */
export const TERMINAL_BACKING_STYLE: Record<Exclude<TerminalBacking, 'today'>, {
  xtermOpacity: number;
  xtermBackground: 'canvas' | 'panel';
}> = {
  scrim: { xtermOpacity: 0.85, xtermBackground: 'canvas' },
  solid90: { xtermOpacity: 0.9, xtermBackground: 'panel' },
  solid100: { xtermOpacity: 1, xtermBackground: 'panel' },
};
