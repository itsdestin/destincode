import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// Guard for the 2026-07-30 idle-CPU investigation's actual conclusion.
//
// On a high-refresh display, ANY smoothly-animating element makes Chromium
// produce and present a frame at the full refresh rate — measured ~1.5-1.9ms of
// CPU per frame (~29% of one core at 180Hz) for a single 64px pulsing dot. The
// cost is per-FRAME, not per-element, and not app-specific (bare Electron:
// 33.7%; plain Chrome: 26.7% for the identical div). Layer promotion via
// `will-change` was tried first, shipped briefly, and then MEASURED USELESS
// (29.8% -> 27.8%); an 8px layer-promoted transform animation still cost 31.9%.
//
// The only levers that work:
//   1. present fewer frames  -> steps() timing (28.75% -> 9.33% at steps(8))
//   2. present zero frames   -> finite iteration counts / Reduced Effects
//
// These are source-text assertions because the failure mode is cosmetic-looking:
// someone "smooths out" a stepped animation back to ease-in-out, or makes a
// finite animation infinite again. Nothing breaks visually — the app just
// quietly resumes burning ~30% of a core whenever that element is on screen.
//
// Investigation: youcoded-dev/docs/archive/investigations/2026-07-30-idle-cpu-burn.md
const RENDERER = join(__dirname, '..', 'src', 'renderer');
const read = (...p: string[]) =>
  readFileSync(join(RENDERER, ...p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('perpetual animations are frame-budgeted', () => {
  const globals = read('styles', 'globals.css');

  it('quantizes .animate-pulse with steps() timing', () => {
    expect(globals).toMatch(/\.animate-pulse\s*\{[^}]*animation-timing-function:\s*steps\(/);
  });

  it('quantizes .animate-spin with steps() timing', () => {
    expect(globals).toMatch(/\.animate-spin\s*\{[^}]*animation-timing-function:\s*steps\(/);
  });

  it('keeps .flowing-word finite — its background-position paint cannot be budgeted', () => {
    // Main-thread-painted property: steps() helps far less (still ~40% of a
    // core), so the fix is a finite iteration count. `infinite` here would
    // reintroduce a permanent ~44-66%-of-a-core cost per visible keyword.
    expect(globals).not.toMatch(/animation:\s*flowing-word-pan[^;]*infinite/);
    expect(globals).toMatch(/animation:\s*flowing-word-pan[^;]*\b\d+;/);
  });

  it('quantizes the SessionStrip breathing dot (inline animation)', () => {
    // Inline TSX animations are invisible to a CSS-file sweep — this dot runs
    // for every non-idle session in the always-visible header, making it the
    // app's most persistent animation.
    const src = readFileSync(join(RENDERER, 'components', 'SessionStrip.tsx'), 'utf8');
    expect(src).toMatch(/animation:\s*'breathe[^']*steps\(/);
    expect(src).not.toMatch(/animation:\s*'breathe[^']*ease/);
  });

  it('quantizes the HeaderBar challenge pulse (inline animation)', () => {
    const src = readFileSync(join(RENDERER, 'components', 'HeaderBar.tsx'), 'utf8');
    expect(src).toMatch(/animation:\s*'challenge-pulse[^']*steps\(/);
    expect(src).not.toMatch(/animation:\s*'challenge-pulse[^']*ease/);
  });

  // ── JS animation drivers ──
  // A requestAnimationFrame chain wakes at the display's refresh rate (180/sec
  // on a 180Hz panel). These three drivers do slow work (12.5fps spinner, 30fps
  // particles, ambient sway) and were each converted to interval-driven ticks —
  // rAF remains legitimate ONLY for genuinely full-rate work (MascotRig's
  // drag-trailing) and one-shot next-frame coalescing.

  it('BrailleSpinner is interval-driven, not a rAF chain', () => {
    const src = read('components', 'BrailleSpinner.tsx');
    expect(src).toMatch(/setInterval\(tick/);
    expect(src).not.toMatch(/requestAnimationFrame/);
  });

  it('ThemeEffects draws from an interval, not a rAF chain', () => {
    const src = read('components', 'ThemeEffects.tsx');
    expect(src).toMatch(/setInterval\(draw/);
    // The one-shot resize coalescer may keep rAF; the draw loop may not.
    expect(src).not.toMatch(/requestAnimationFrame\(draw/);
  });

  it('MascotRig runs rAF only for the drag chain, idle from an interval', () => {
    const src = read('components', 'mascot', 'MascotRig.tsx');
    expect(src).toMatch(/setInterval\(/);
    // Every rAF request must belong to the drag-gated chain (rafTick) — an
    // unconditional `requestAnimationFrame(tick)`-style self-chain regressing
    // here would resume 180 presented frames/sec of ambient sway forever.
    const rafCalls = [...src.matchAll(/requestAnimationFrame\(\s*(\w+)/g)].map((m) => m[1]);
    expect(rafCalls.length).toBeGreaterThan(0);
    expect(rafCalls.every((fn) => fn === 'rafTick')).toBe(true);
  });

  it('bans NEW inline infinite animations without steps timing in components', () => {
    // The two above were found only by a manual sweep; this keeps the class
    // closed. An inline `animation: '... infinite'` must carry steps() (or be
    // finite). Scoped to string literals in TSX — CSS files are covered by the
    // reduced-effects test and the assertions above.
    const { readdirSync, statSync } = require('fs') as typeof import('fs');
    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((e: string) => {
        const full = join(dir, e);
        return statSync(full).isDirectory() ? walk(full) : full.endsWith('.tsx') ? [full] : [];
      });
    const offenders: string[] = [];
    for (const f of walk(join(RENDERER, 'components'))) {
      const src = readFileSync(f, 'utf8');
      for (const m of src.matchAll(/animation:\s*'([^']*infinite[^']*)'/g)) {
        if (!/steps\(/.test(m[1])) offenders.push(`${f.split('/components/')[1]}: ${m[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
