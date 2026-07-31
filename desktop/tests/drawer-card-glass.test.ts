import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// Guard: command-drawer tiles must never carry their own backdrop-filter.
//
// This bug has shipped TWICE, both times as "drawer cards blink in and out" on
// Windows Electron with a wallpaper/gradient theme:
//
//   2026-04-30 (516411a5) — FavoriteStar's corner variant hardcoded
//     `bg-panel/80 backdrop-blur-sm`. ~20 stars = 20 blur layers.
//   2026-07-22 (1f68a7f0, "change 22") — every drawer tile moved onto
//     `.layer-surface`, which theme-engine.ts gives a backdrop-filter under
//     [data-wallpaper]. That is 20-40 tiles at the theme's FULL panels-blur
//     (halftone-dimension: 20px), i.e. strictly worse than the 2026-04-30 bug
//     the first fix removed.
//
// Mechanism: each backdrop-filter is its own Chromium compositing layer with a
// live blur region. The drawer is `overflow-hidden` and animates `transform`,
// so all of them re-rasterize per frame; Windows Electron drops their paint and
// individual CARDS (not rows) go blank. Reported 2026-07-31 on halftone-dimension;
// clean on creme (a solid theme, so [data-wallpaper] never matches) and fixed by
// Reduced Effects (theme-engine.ts gates the whole glass stylesheet on it).
//
// Why removing it is visually free: the drawer root is plain `bg-panel`, and
// globals.css deliberately excludes .bg-panel from glass treatment ("keep it as
// a plain background token"), so it is OPAQUE. Blurring a flat opaque color
// returns that same flat color — the filter's output is identical to no filter.
// Only the blur is dropped; --panels-opacity translucency is retained, so the
// card-vs-drawer tonal separation is unchanged.
//
// NOT extended to the marketplace grid on purpose: those cards sit over
// <WallpaperBackdrop /> (MarketplaceScreen.tsx), a real wallpaper image, so
// their blur IS visible. That grid solves the same cost the other way — one
// pre-blurred backdrop element instead of N live filters.
const RENDERER = join(__dirname, '..', 'src', 'renderer');
const GLOBALS = join(RENDERER, 'styles', 'globals.css');
const DRAWER = join(RENDERER, 'components', 'CommandDrawer.tsx');
const THEME_ENGINE = join(RENDERER, 'themes', 'theme-engine.ts');

// Strip comments so the WHY prose (which names these selectors) cannot satisfy
// an assertion on its own.
const stripCss = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('command-drawer tiles opt out of glassmorphism', () => {
  const css = stripCss(readFileSync(GLOBALS, 'utf8'));
  const drawer = stripTs(readFileSync(DRAWER, 'utf8'));
  const engine = stripTs(readFileSync(THEME_ENGINE, 'utf8'));

  it('globals.css cancels backdrop-filter for .layer-surface inside the drawer', () => {
    expect(css).toMatch(
      /\[data-wallpaper\]\s+\.command-drawer\s+\.layer-surface\s*\{[^}]*(?<!-webkit-)backdrop-filter:\s*none/,
    );
  });

  it('cancels the -webkit- prefixed property too', () => {
    // theme-engine sets BOTH; cancelling only the unprefixed one would leave the
    // prefixed declaration live on any engine that honours it.
    expect(css).toMatch(
      /\[data-wallpaper\]\s+\.command-drawer\s+\.layer-surface\s*\{[^}]*-webkit-backdrop-filter:\s*none/,
    );
  });

  it('CommandDrawer actually carries the .command-drawer hook class', () => {
    // The CSS above matches nothing without this class on the drawer root, and
    // the failure is silent — the cards just start flickering again.
    expect(drawer).toMatch(/command-drawer/);
  });

  it('the hazard the override answers is still live in theme-engine', () => {
    // If this ever stops being true, [data-wallpaper] .layer-surface no longer
    // gets a backdrop-filter and the override above can be deleted. Pinned so
    // the override cannot outlive its reason and become cargo cult.
    expect(engine).toMatch(/\[data-wallpaper\]\s+\.layer-surface,?[\s\S]{0,200}?backdrop-filter:\s*blur\(/);
  });

  it('the override out-specifies theme-engine\'s injected rule', () => {
    // theme-engine injects `[data-wallpaper] .layer-surface` (0,2,0) into a
    // runtime <style> in <head>, which lands AFTER globals.css. Equal
    // specificity would lose on source order, so the override MUST keep a third
    // compound (.command-drawer) to win at (0,3,0). Both rules are unlayered.
    const override = css.match(
      /\[data-wallpaper\]\s+([^{]*?)\.layer-surface\s*\{[^}]*backdrop-filter:\s*none[^}]*\}/,
    );
    expect(override).not.toBeNull();
    expect(override![1].trim()).toBe('.command-drawer');
  });
});
