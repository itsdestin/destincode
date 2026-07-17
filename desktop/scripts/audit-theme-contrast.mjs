#!/usr/bin/env node
// Theme contrast audit. Computes WCAG relative-luminance contrast ratios
// for the color pairs we care about across all themes (4 built-in +
// every community theme in wecoded-themes/themes/) and prints a table
// flagging any that fall below the chosen thresholds.
//
// Pairs checked:
//   panel ↔ canvas  — chrome surface vs content surface (the new rule)
//   fg ↔ canvas     — primary text on content
//   fg-2 ↔ canvas   — secondary text on content
//   fg-dim ↔ canvas — dim text
//   fg-muted ↔ canvas
//   fg-faint ↔ canvas
//   fg ↔ inset      — text in assistant bubbles (which use --inset bg)
//   on-accent ↔ accent — text in user bubbles
//
// Run from anywhere: node scripts/audit-theme-contrast.mjs

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));

// ────────────────────────────────────────────────────────────────────────────
// Color math — standard sRGB → linear luminance → WCAG contrast ratio.

function srgbChannelToLinear(c) {
  c = c / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function relLuminance(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const m = hex.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!m) return null;
  const r = srgbChannelToLinear(parseInt(m[1], 16));
  const g = srgbChannelToLinear(parseInt(m[2], 16));
  const b = srgbChannelToLinear(parseInt(m[3], 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(hexA, hexB) {
  const lA = relLuminance(hexA);
  const lB = relLuminance(hexB);
  if (lA == null || lB == null) return null;
  const [hi, lo] = lA > lB ? [lA, lB] : [lB, lA];
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean RGB distance — the accent-vs-fg guard the engine uses to decide
 *  whether accent is usable as a link color. */
function rgbDistance(hexA, hexB) {
  const pa = hexA?.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  const pb = hexB?.replace('#', '').match(/^([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i);
  if (!pa || !pb) return null;
  return Math.sqrt(
    [1, 2, 3].reduce((sum, i) => sum + (parseInt(pa[i], 16) - parseInt(pb[i], 16)) ** 2, 0),
  );
}

// Mirrors computeOverlayTokens() in src/renderer/themes/theme-engine.ts — the
// audit has to check the colors that actually RENDER, and link/destructive/
// on-destructive are derived at runtime rather than declared by most packs.
// The two must agree; tests/theme-builtin-sources.test.ts pins them together.
function withDerivedTokens(data) {
  const t = { ...data.tokens };
  const destructive = data.overlay?.destructive ?? '#DD4444';
  t.destructive = destructive;
  t['on-destructive'] =
    contrast('#FFFFFF', destructive) >= contrast('#1A1A1A', destructive) ? '#FFFFFF' : '#1A1A1A';
  if (!t.link) {
    const dist = rgbDistance(t.accent, t.fg);
    t.link = dist != null && dist > 40 ? t.accent : t['fg-2'];
  }
  return t;
}

// ────────────────────────────────────────────────────────────────────────────
// Built-in themes — read straight from src/renderer/themes/builtin/*.json,
// which is the single source of truth (it is what the theme engine actually
// applies at runtime). This used to be a hand-maintained copy and it drifted:
// creme's fg-muted/fg-faint were fixed in globals.css but not here or in the
// JSON, so the audit passed values the app never rendered. Reading the JSON
// removes that failure mode by construction. The globals.css [data-theme]
// blocks are anti-FOUC only and are pinned against these files by
// tests/theme-builtin-sources.test.ts.

const builtinRoot = resolve(scriptDir, '..', 'src', 'renderer', 'themes', 'builtin');

function loadBuiltinThemes() {
  const out = {};
  for (const file of readdirSync(builtinRoot)) {
    if (!file.endsWith('.json')) continue;
    const data = JSON.parse(readFileSync(join(builtinRoot, file), 'utf-8'));
    if (!data.tokens) continue;
    out[data.slug || file.replace(/\.json$/, '')] = withDerivedTokens(data);
  }
  return out;
}

const builtIn = loadBuiltinThemes();

// ────────────────────────────────────────────────────────────────────────────
// Load community themes from wecoded-themes/themes/*/manifest.json.

const themesRoot = resolve(process.cwd(), '..', '..', '..', 'wecoded-themes', 'themes');

function loadCommunityThemes() {
  if (!existsSync(themesRoot)) {
    console.warn(`[skip] wecoded-themes not found at ${themesRoot} — community themes not audited`);
    return {};
  }
  const out = {};
  for (const dir of readdirSync(themesRoot)) {
    const manifest = join(themesRoot, dir, 'manifest.json');
    if (!existsSync(manifest)) continue;
    const data = JSON.parse(readFileSync(manifest, 'utf-8'));
    if (!data.tokens) continue;
    out[data.slug || dir] = withDerivedTokens(data);
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// The pairs we want to check + thresholds.
// Surface-to-surface contrast is laxer than text-on-surface (WCAG-style).

const pairs = [
  { name: 'panel/canvas',     a: 'panel',      b: 'canvas', min: 1.07, label: 'chrome vs content surface' },
  { name: 'fg/canvas',        a: 'fg',         b: 'canvas', min: 4.5,  label: 'primary text on content (AA)' },
  { name: 'fg-2/canvas',      a: 'fg-2',       b: 'canvas', min: 4.5,  label: 'secondary text on content (AA)' },
  { name: 'fg-dim/canvas',    a: 'fg-dim',     b: 'canvas', min: 3.0,  label: 'dim text on content (AA large)' },
  { name: 'fg-muted/canvas',  a: 'fg-muted',   b: 'canvas', min: 3.0,  label: 'muted text on content' },
  { name: 'fg-faint/canvas',  a: 'fg-faint',   b: 'canvas', min: 1.8,  label: 'faint text on content (decorative)' },
  { name: 'fg/inset',         a: 'fg',         b: 'inset',  min: 4.5,  label: 'primary text on bubbles (AA)' },
  { name: 'on-accent/accent', a: 'on-accent',  b: 'accent', min: 4.5,  label: 'user-bubble text (AA)' },
  { name: 'link/canvas',      a: 'link',       b: 'canvas', min: 4.5,  label: 'link on content (AA)' },
  // Danger-button label. --destructive is pack-overridable with no guard, and
  // --on-destructive derives to whichever of white/near-black reads better —
  // this catches mid-tone destructives where NEITHER label clears AA.
  { name: 'on-destructive/destructive', a: 'on-destructive', b: 'destructive', min: 4.5, label: 'danger button label (AA)' },
];

// ────────────────────────────────────────────────────────────────────────────
// Run audit + print results.

function auditTheme(name, tokens) {
  const results = pairs.map((p) => {
    const ratio = contrast(tokens[p.a], tokens[p.b]);
    return { ...p, ratio, fail: ratio != null && ratio < p.min };
  });
  return results;
}

// (A `proposed` staging block used to live here for two in-flight fixes —
// creme's fg-muted/fg-faint and strawberry-kitty's accent. Both have since
// landed in their source files, so the synthetic entries were removed.)

const themes = { ...builtIn, ...loadCommunityThemes() };
const ordered = Object.keys(themes).sort();
const overallFails = [];

for (const name of ordered) {
  const results = auditTheme(name, themes[name]);
  const hasFail = results.some((r) => r.fail);
  if (hasFail) overallFails.push(name);

  const header = hasFail ? `❌ ${name}` : `✓ ${name}`;
  console.log(`\n${header}`);
  for (const r of results) {
    const ratio = r.ratio == null ? 'n/a' : r.ratio.toFixed(3);
    const status = r.fail ? '  ✗' : '   ';
    const minStr = `(min ${r.min.toFixed(2)})`;
    console.log(`${status} ${r.name.padEnd(20)} ${ratio.padStart(5)}:1 ${minStr.padEnd(13)} — ${r.label}`);
  }
}

console.log(`\n────────────────────────────────────────`);
if (overallFails.length === 0) {
  console.log('All themes pass.');
} else {
  console.log(`${overallFails.length} theme${overallFails.length === 1 ? '' : 's'} fail at least one check:`);
  for (const name of overallFails) console.log(`  - ${name}`);
}
