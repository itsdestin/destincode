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
import { join, resolve } from 'node:path';

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

// ────────────────────────────────────────────────────────────────────────────
// Built-in themes (defined in desktop/src/renderer/styles/globals.css).
// Keep in sync with the :root / [data-theme=...] blocks there.

const builtIn = {
  light: {
    canvas: '#F2F2F2', panel: '#EAEAEA', inset: '#E0E0E0', well: '#F7F7F7',
    accent: '#1A1A1A', 'on-accent': '#F2F2F2',
    fg: '#1A1A1A', 'fg-2': '#444444', 'fg-dim': '#666666', 'fg-muted': '#888888', 'fg-faint': '#AAAAAA',
    edge: '#CFCFCF', link: '#2563EB',
  },
  dark: {
    canvas: '#111111', panel: '#191919', inset: '#222222', well: '#1C1C1C',
    accent: '#D4D4D4', 'on-accent': '#111111',
    fg: '#E0E0E0', 'fg-2': '#B0B0B0', 'fg-dim': '#999999', 'fg-muted': '#666666', 'fg-faint': '#444444',
    edge: '#2E2E2E', link: '#66AAFF',
  },
  midnight: {
    canvas: '#0D1117', panel: '#161B22', inset: '#21262D', well: '#0D1117',
    accent: '#B1BAC4', 'on-accent': '#0D1117',
    fg: '#C9D1D9', 'fg-2': '#A0AAB4', 'fg-dim': '#8B949E', 'fg-muted': '#6E7681', 'fg-faint': '#484F58',
    edge: '#30363D', link: '#58A6FF',
  },
  creme: {
    canvas: '#F0E6D6', panel: '#EBE1D1', inset: '#DDD1BE', well: '#F5ECDE',
    accent: '#3D3229', 'on-accent': '#F0E6D6',
    fg: '#2C2418', 'fg-2': '#5C4F3E', 'fg-dim': '#7A6E5D', 'fg-muted': '#9E9283', 'fg-faint': '#BEB3A4',
    edge: '#CBBFAD', link: '#5B4A1E',
  },
};

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
    out[data.slug || dir] = data.tokens;
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

// Proposed fixes — added alongside originals so we can confirm thresholds pass.
const proposed = {
  'creme (proposed)': {
    ...builtIn.creme,
    'fg-muted': '#8A7E6E',  // was #9E9283 → 2.47:1; new target ≥ 3:1
    'fg-faint': '#B0A595',  // was #BEB3A4 → 1.67:1; new target ≥ 1.8:1
  },
  'strawberry-kitty (proposed)': (() => {
    const community = loadCommunityThemes();
    return {
      ...community['strawberry-kitty'],
      accent: '#CC4060',  // was #D94E6B → 4.00:1; new target ≥ 4.5:1
    };
  })(),
};

const themes = { ...builtIn, ...loadCommunityThemes(), ...proposed };
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
