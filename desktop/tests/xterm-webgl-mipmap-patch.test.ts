// Pins the postinstall patch that removes `gl.generateMipmap` from
// @xterm/addon-webgl's glyph-atlas upload (upstream xterm.js PR #5987, merged
// 2026-06-03 and unreleased as of 0.19.0).
//
// Why this exists: on some Linux + Wayland GPU stacks (Destin's Strix Halo on
// mesa-git; Orca and Hermes Agent report the same on other machines) the driver
// rejects the mip-level allocation. The addon never sets TEXTURE_MIN_FILTER, so
// WebGL's default (NEAREST_MIPMAP_LINEAR) *requires* a complete mip chain — the
// failed texture is "incomplete" and samples as opaque black, i.e. every glyph
// draws as a solid black box. Re-uploading (the 619d064a heal) re-runs the same
// failing call, so it cannot recover. Evidence and options:
// youcoded-dev/docs/active/investigations/2026-08-27-terminal-black-glyphs-mipmap-driver.md
//
// Two layers are pinned:
//   1. the pure transform, on the exact minified shapes of 0.19.0's CJS + ESM
//      builds (minifier-chosen variable names differ between the two);
//   2. the INSTALLED lib files — so a `npm ci` that skipped postinstall, or an
//      xterm bump that changed the call-site shape, fails CI instead of
//      silently shipping the bug again.
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { patchXtermWebglSource, ADDON_LIB_FILES } = require('../scripts/patch-xterm-webgl-mipmap.js') as {
  patchXtermWebglSource: (text: string) => { text: string; status: 'patched' | 'already-patched' | 'not-found' };
  ADDON_LIB_FILES: string[];
};

// Verbatim from @xterm/addon-webgl@0.19.0 lib/addon-webgl.js (`_bindAtlasPageTexture`).
const CJS_SHAPE =
  'e.texParameteri(e.TEXTURE_2D,e.TEXTURE_WRAP_T,e.CLAMP_TO_EDGE),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,t.pages[i].canvas),e.generateMipmap(e.TEXTURE_2D),this._atlasTextures[i].version=t.pages[i].version}';
// Verbatim from lib/addon-webgl.mjs — same code, different minified names.
const ESM_SHAPE =
  't.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.texImage2D(t.TEXTURE_2D,0,t.RGBA,t.RGBA,t.UNSIGNED_BYTE,n.pages[s].canvas),t.generateMipmap(t.TEXTURE_2D),this._atlasTextures[s].version=n.pages[s].version}';

describe('patchXtermWebglSource (upstream xterm.js #5987 applied to 0.19.0)', () => {
  it('drops generateMipmap and sets non-mipmapped LINEAR filters before the atlas upload (CJS names)', () => {
    const out = patchXtermWebglSource(CJS_SHAPE);
    expect(out.status).toBe('patched');
    expect(out.text).not.toContain('generateMipmap');
    // Filters must be set on the bound texture BEFORE texImage2D, exactly as upstream does.
    expect(out.text).toContain(
      'e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR),e.texImage2D(e.TEXTURE_2D,0,e.RGBA,e.RGBA,e.UNSIGNED_BYTE,t.pages[i].canvas),this._atlasTextures[i].version',
    );
  });

  it('handles the ESM build, whose minifier picked different variable names', () => {
    const out = patchXtermWebglSource(ESM_SHAPE);
    expect(out.status).toBe('patched');
    expect(out.text).not.toContain('generateMipmap');
    expect(out.text).toContain('t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MIN_FILTER,t.LINEAR),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texImage2D(');
  });

  it('is idempotent: a second run reports already-patched and changes nothing', () => {
    const once = patchXtermWebglSource(CJS_SHAPE);
    const twice = patchXtermWebglSource(once.text);
    expect(twice.status).toBe('already-patched');
    expect(twice.text).toBe(once.text);
  });

  it('leaves an unrecognised shape untouched and says so, rather than guessing', () => {
    const foreign = 'gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, page.canvas); gl.generateMipmap(gl.TEXTURE_2D);';
    const out = patchXtermWebglSource(foreign);
    expect(out.status).toBe('not-found');
    expect(out.text).toBe(foreign);
  });
});

describe('installed @xterm/addon-webgl is patched (postinstall ran)', () => {
  const addonDir = path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-webgl');
  const version = (JSON.parse(fs.readFileSync(path.join(addonDir, 'package.json'), 'utf8')) as { version: string }).version;

  it('covers both entry points the bundlers can pick (main + module)', () => {
    expect(ADDON_LIB_FILES).toEqual(['lib/addon-webgl.js', 'lib/addon-webgl.mjs']);
  });

  for (const rel of ADDON_LIB_FILES) {
    it(`${rel} carries no generateMipmap and sets LINEAR filters on the atlas texture`, () => {
      const text = fs.readFileSync(path.join(addonDir, rel), 'utf8');
      expect(text, `${rel} still calls generateMipmap — run \`node scripts/patch-xterm-webgl-mipmap.js\` (postinstall)`).not.toContain('generateMipmap');
      expect(text).toMatch(/\.texParameteri\(\w+\.TEXTURE_2D,\w+\.TEXTURE_MIN_FILTER,\w+\.LINEAR\)/);
    });
  }

  it('the patch is retired the day a stable addon ≥ 0.20.0 ships (it carries the fix natively)', () => {
    // 0.20.0-beta.299 (2026-08-24) already has no generateMipmap. When a STABLE
    // ≥ 0.20.0 is installed, delete scripts/patch-xterm-webgl-mipmap.js, its
    // postinstall hook and this file — the installed-file checks above will keep
    // passing on their own, so this is the only assertion that will prompt you.
    const [major, minor] = version.split('.').map(Number);
    const isPrerelease = version.includes('-');
    expect(
      major === 0 && (minor < 20 || isPrerelease),
      `@xterm/addon-webgl ${version} contains upstream #5987 — remove the postinstall patch and this test`,
    ).toBe(true);
  });
});
