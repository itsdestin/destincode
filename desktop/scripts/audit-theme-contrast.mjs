#!/usr/bin/env node
// Theme contrast audit — all 4 built-in themes plus every community theme in
// the sibling wecoded-themes checkout.
//
// WHY THIS WAS REWRITTEN (2026-07-19)
// -----------------------------------
// This script used to carry its own hand-written list of 8 token pairs, all
// measured against `canvas`. It was the THIRD independent implementation of the
// same idea — alongside the theme-builder's contrast-rules.js and
// wecoded-themes/scripts/audit-contrast.mjs — each with different pairs and
// different thresholds.
//
// Three tables in three repos is how the app shipped with:
//   - `fg-muted` failing on raised surfaces in 9 of 11 themes
//   - `fg-faint` never once passing on a raised surface in any shipped theme,
//     while being used as real text in ~107 places
//   - meadow-mist painting text at a genuine 1.01 contrast (identical
//     luminance) while every audit reported 1.24, because they all measured the
//     flat `inset` token instead of the glass composite the app actually paints
//
// The rules now live in ONE place — the theme-builder skill in
// wecoded-marketplace — and this script consumes a vendored copy at
// scripts/vendor/contrast-rules.js. Do not edit that file by hand.
// tests/theme-builtin-sources.test.ts uses the same copy, so the audit and the
// test can no longer disagree about what "passing" means.
//
// Run from anywhere: node scripts/audit-theme-contrast.mjs

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const scriptDir = dirname(fileURLToPath(import.meta.url));
const rules = require('./vendor/contrast-rules.js');

const builtinDir = resolve(scriptDir, '..', 'src', 'renderer', 'themes', 'builtin');

function loadBuiltins() {
  return readdirSync(builtinDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const j = JSON.parse(readFileSync(join(builtinDir, f), 'utf8'));
      // Built-ins are opaque — no wallpaper, so the flat token IS what is painted.
      return { slug: j.slug, tokens: j.tokens, opts: {}, kind: 'builtin' };
    });
}

function loadCommunity() {
  // Workspace layout puts wecoded-themes as a sibling of youcoded/.
  const themesRoot = resolve(scriptDir, '..', '..', '..', 'wecoded-themes', 'themes');
  if (!existsSync(themesRoot)) {
    console.warn(`[skip] wecoded-themes not found at ${themesRoot} — community themes not audited`);
    return [];
  }
  const out = [];
  for (const slug of readdirSync(themesRoot).sort()) {
    const p = join(themesRoot, slug, 'manifest.json');
    if (!existsSync(p)) continue;
    const j = JSON.parse(readFileSync(p, 'utf8'));
    if (!j.tokens) continue;
    const bg = j.background || {};
    const panelsOpacity = typeof bg['panels-opacity'] === 'number' ? bg['panels-opacity'] : 1;
    out.push({
      slug: j.slug || slug,
      tokens: j.tokens,
      // Wallpaper themes paint surfaces translucently, so measure the composite.
      // `average-color` is precomputed by the theme-builder — decoding the image
      // here would mean adding an image dependency to a zero-dep script.
      opts: { wallpaperAvg: bg['average-color'] || null, panelsOpacity },
      kind: 'community',
      needsGlass: panelsOpacity < 1 && !bg['average-color'],
    });
  }
  return out;
}

const themes = [...loadBuiltins(), ...loadCommunity()];
const failing = [];
const warnings = [];

for (const t of themes) {
  if (t.needsGlass) {
    warnings.push(
      `${t.slug}: translucent panels but no background.average-color — audited FLAT, ` +
        `which understates the real ratios. Re-run the theme-builder to populate it.`,
    );
  }

  const { results, hardFails, surfaceFails, softWarns, glassAware } = rules.evaluate(t.tokens, t.opts);
  const blocking = hardFails + surfaceFails;
  if (blocking > 0) failing.push(t.slug);

  const glassNote = glassAware
    ? ` [glass ${Math.round(t.opts.panelsOpacity * 100)}% over ${t.opts.wallpaperAvg}]`
    : '';
  console.log(`\n${blocking > 0 ? '❌' : '✓'} ${t.slug} (${t.kind})${glassNote}`);

  for (const tier of ['HARD', 'SURFACE', 'SOFT']) {
    for (const r of results[tier]) {
      if (r.status === 'PASS') continue;
      if (r.status === 'SKIP') {
        console.log(`    · ${tier.padEnd(7)} ${r.rule.padEnd(24)} skipped — ${r.reason}`);
        continue;
      }
      console.log(
        `${tier === 'SOFT' ? '  ⚠' : '  ✗'} ${tier.padEnd(7)} ${r.rule.padEnd(24)} ` +
          `${String(r.actual).padStart(6)} (min ${r.threshold}) — ${r.description}`,
      );
    }
  }
  if (blocking === 0 && softWarns === 0) console.log('    all checks pass');
}

console.log('\n────────────────────────────────────────');
for (const w of warnings) console.log(`⚠ ${w}`);

if (failing.length === 0) {
  console.log(`All ${themes.length} themes pass HARD and SURFACE checks.`);
  process.exit(0);
}
console.log(`${failing.length} of ${themes.length} themes fail a blocking check:`);
for (const slug of failing) console.log(`  - ${slug}`);
process.exit(1);
