#!/usr/bin/env node
// patch-xterm-webgl-mipmap.js — applies upstream xterm.js PR #5987 ("fix(webgl):
// avoid glyph atlas mipmaps", merged 2026-06-03) to the INSTALLED
// @xterm/addon-webgl 0.19.0, which predates it. Remove this file, its
// postinstall hook and tests/xterm-webgl-mipmap-patch.test.ts once a STABLE
// @xterm/addon-webgl >= 0.20.0 is installed — that test will tell you.
//
// The bug: after uploading each glyph-atlas page the addon calls
//   gl.generateMipmap(gl.TEXTURE_2D)
// and never sets TEXTURE_MIN_FILTER, so the texture depends on a complete mip
// chain (WebGL's default filter is NEAREST_MIPMAP_LINEAR). On some Linux +
// Wayland GPU stacks the driver rejects the mip allocation — Electron's GPU
// process logs `GL_INVALID_OPERATION … allocateMipmapLevelsForGeneration …
// Unexpected driver error` — which leaves the texture INCOMPLETE, and WebGL
// samples an incomplete texture as opaque black. Every glyph then draws as a
// solid black rectangle. The in-app heal (TerminalView's clearTextureAtlas on
// toggle/resize, 619d064a) re-runs the same failing upload, so it can't fix it.
// Seen on Destin's Strix Halo (mesa-git) 2026-07-29 and 2026-08-27; upstream
// cites Orca and Hermes Agent hitting the identical failure elsewhere.
//
// The fix, verbatim from upstream: set MIN/MAG filters to plain LINEAR (the
// atlas is rasterized at device pixel ratio and sampled 1:1, so mipmaps were
// never useful) and drop the generateMipmap call. Two lines of GL state; no
// behaviour change on drivers that were fine.
//
// Both shipped builds are patched, because Vite bundles the ESM `module` entry
// while plain `require` (tests, tooling) resolves `main`:
//   lib/addon-webgl.js   (CJS)
//   lib/addon-webgl.mjs  (ESM)
// Same source, different minifier-chosen identifiers — hence the regex with a
// back-reference instead of a literal string.
//
// Written temp-then-rename on purpose: dev worktrees hardlink-copy the main
// checkout's node_modules (`cp -al`, see CLAUDE.md), and an in-place write
// would edit the shared inode — i.e. silently patch every other checkout too.
// A rename swaps in a fresh inode for THIS checkout only.

const fs = require('fs');
const path = require('path');

/** Relative to the addon package root. Order = package.json `main`, `module`. */
const ADDON_LIB_FILES = ['lib/addon-webgl.js', 'lib/addon-webgl.mjs'];

// Matches the minified `_bindAtlasPageTexture` upload + mipmap pair:
//   <gl>.texImage2D(<gl>.TEXTURE_2D,0,<gl>.RGBA,<gl>.RGBA,<gl>.UNSIGNED_BYTE,<atlas>.pages[<i>].canvas),<gl>.generateMipmap(<gl>.TEXTURE_2D),
// Group 1 is the GL identifier (`e` in CJS, `t` in ESM); every later `\1`
// pins the same name so an unrelated texImage2D can't match.
const UNPATCHED =
  /(\w+)\.texImage2D\(\1\.TEXTURE_2D,0,\1\.RGBA,\1\.RGBA,\1\.UNSIGNED_BYTE,(\w+)\.pages\[(\w+)\]\.canvas\),\1\.generateMipmap\(\1\.TEXTURE_2D\),/;

// The same upload with upstream's filter calls in front and no mipmap after.
const PATCHED_MARK = /\.texParameteri\(\w+\.TEXTURE_2D,\w+\.TEXTURE_MIN_FILTER,\w+\.LINEAR\)/;

/**
 * Pure transform so it can be unit-tested on the exact minified shapes.
 * @param {string} text
 * @returns {{ text: string, status: 'patched' | 'already-patched' | 'not-found' }}
 */
function patchXtermWebglSource(text) {
  if (PATCHED_MARK.test(text) && !text.includes('generateMipmap')) {
    return { text, status: 'already-patched' };
  }
  const m = UNPATCHED.exec(text);
  if (!m) return { text, status: 'not-found' };
  const gl = m[1];
  const upload = m[0].replace(`,${gl}.generateMipmap(${gl}.TEXTURE_2D),`, ',');
  const filters =
    `${gl}.texParameteri(${gl}.TEXTURE_2D,${gl}.TEXTURE_MIN_FILTER,${gl}.LINEAR),` +
    `${gl}.texParameteri(${gl}.TEXTURE_2D,${gl}.TEXTURE_MAG_FILTER,${gl}.LINEAR),`;
  return { text: text.replace(m[0], filters + upload), status: 'patched' };
}

function main() {
  const addonDir = path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-webgl');
  if (!fs.existsSync(addonDir)) {
    // Not installed yet (or a main-only install) — nothing to patch.
    console.log('addon-webgl: not installed — skipping mipmap patch');
    return;
  }
  for (const rel of ADDON_LIB_FILES) {
    const target = path.join(addonDir, rel);
    if (!fs.existsSync(target)) {
      console.log(`addon-webgl: ${rel} missing — skipping`);
      continue;
    }
    const { text, status } = patchXtermWebglSource(fs.readFileSync(target, 'utf8'));
    if (status === 'already-patched') {
      console.log(`addon-webgl: ${rel} already has the atlas-mipmap patch — skipping`);
      continue;
    }
    if (status === 'not-found') {
      // Don't guess: tests/xterm-webgl-mipmap-patch.test.ts fails on the
      // installed file, which is the right place to notice a changed shape.
      console.log(`addon-webgl: ${rel} atlas-upload pattern not found — NOT patched (shape changed upstream?)`);
      continue;
    }
    const tmp = `${target}.patch-tmp`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
    console.log(`addon-webgl: ${rel} — removed glyph-atlas generateMipmap, set LINEAR filters (xterm.js #5987)`);
  }
}

module.exports = { patchXtermWebglSource, ADDON_LIB_FILES };

if (require.main === module) main();
