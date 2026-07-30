import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// Guard for the 2026-07-30 idle-CPU fix.
//
// Tailwind's `animate-pulse` and `animate-spin` are INFINITE animations, so any
// element wearing one animates for as long as it is on screen. If the animating
// element is not promoted to its own compositor layer, Chromium repaints and
// re-rasterizes the whole window on every frame of that animation.
//
// The cost is per-FRAME, not per-element, so a single small pulsing dot pays it
// in full. Measured on a 2560x1600@180Hz panel: one 64px `animate-pulse` div took
// the idle app from 4% to 43% of one CPU core; adding `will-change` brought the
// same animation back to ~3.5% with no visual change.
//
// This is a source-text assertion because the failure mode is somebody deleting
// two "unused-looking" CSS lines during a cleanup. Nothing renders differently
// when they go — the app just quietly starts burning ~40% of a core whenever a
// spinner or status dot is on screen, which no render test would ever catch.
//
// Full investigation: youcoded-dev/docs/active/investigations/2026-07-30-idle-cpu-burn.md
const GLOBALS = join(__dirname, '..', 'src', 'renderer', 'styles', 'globals.css');

describe('perpetual animations are layer-promoted', () => {
  const css = readFileSync(GLOBALS, 'utf8');

  // Strip comments so the WHY block above the rules (which names these classes)
  // cannot satisfy the assertion on its own.
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('promotes .animate-pulse on opacity', () => {
    expect(code).toMatch(/\.animate-pulse\s*\{[^}]*will-change:\s*opacity/);
  });

  it('promotes .animate-spin on transform', () => {
    expect(code).toMatch(/\.animate-spin\s*\{[^}]*will-change:\s*transform/);
  });

  // The promotion must name the property that is actually animated — promoting
  // the wrong property costs the GPU memory of a layer without moving the work
  // off the main thread, i.e. all of the downside and none of the benefit.
  it('promotes the property each utility actually animates', () => {
    expect(code).not.toMatch(/\.animate-pulse\s*\{[^}]*will-change:\s*transform/);
    expect(code).not.toMatch(/\.animate-spin\s*\{[^}]*will-change:\s*opacity/);
  });
});
