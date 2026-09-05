// Serves the live theme to a browser page.
//
// Strictly READ-ONLY against ~/.claude: writing youcoded-appearance.json would
// reach into Destin's RUNNING app, which .claude/rules/live-app-safety.md forbids.
// The dashboard reads which theme is active; it never sets one.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const THEMES_DIR = path.join(os.homedir(), '.claude', 'wecoded-themes');
const APPEARANCE = path.join(os.homedir(), '.claude', 'youcoded-appearance.json');

/** Deep copy with every relative asset path rewritten to a loopback URL.
 *
 *  WHY this needs NO change to the app: inside Electron, theme assets travel over
 *  a `theme-asset://` custom protocol (src/main/theme-protocol.ts) that a browser
 *  cannot resolve. But theme-asset-resolver.ts returns any value already starting
 *  with `http://` unchanged — so once these are absolute loopback URLs, the
 *  renderer's own resolver leaves them alone and the wallpaper simply loads.
 *
 *  WHY a generic walk rather than copying the resolver's field list: it is a
 *  superset, so a manifest field added later is covered without touching this. */
export function rewriteAssets(value, slug, baseUrl) {
  if (typeof value === 'string') {
    return value.startsWith('assets/') ? `${baseUrl}/theme-asset/${slug}/${value}` : value;
  }
  if (Array.isArray(value)) return value.map((v) => rewriteAssets(v, slug, baseUrl));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = rewriteAssets(v, slug, baseUrl);
    return out;
  }
  return value;
}

export async function readAppearance() {
  try {
    return JSON.parse(await fs.readFile(APPEARANCE, 'utf-8'));
  } catch {
    return null; // No file yet is normal on a fresh machine, not an error.
  }
}

export async function listThemes() {
  try {
    const entries = await fs.readdir(THEMES_DIR, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

export async function readTheme(slug, baseUrl) {
  const file = resolveAssetFile(slug, 'manifest.json');
  if (!file) throw new Error(`theme slug rejected: ${slug}`);
  const raw = JSON.parse(await fs.readFile(file, 'utf-8'));
  return JSON.stringify(rewriteAssets(raw, slug, baseUrl));
}

/** Absolute path inside the theme's own directory, or null if it escapes.
 *  Both the slug and the relative path are attacker-controlled in principle, so
 *  containment is checked once, on the fully resolved result — not by pattern. */
export function resolveAssetFile(slug, relPath) {
  const themeDir = path.resolve(THEMES_DIR, slug);
  if (!themeDir.startsWith(THEMES_DIR + path.sep)) return null;
  const full = path.resolve(themeDir, relPath);
  if (!full.startsWith(themeDir + path.sep)) return null;
  return full;
}

export const MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.css': 'text/css',
  '.json': 'application/json',
};

export function assetExists(p) {
  return fsSync.existsSync(p);
}
