// changelog-service.ts — fetches + caches CHANGELOG.md for the UpdatePanel.
// Cache file: $HOME/.claude/.changelog-cache.json (Electron's app.getPath('home') returns ~/).
// Cache is keyed on the running app version — invalidates automatically on update install.

import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import { app } from 'electron';
import { parseChangelog, ChangelogEntry } from './changelog-parser';

const CHANGELOG_URL = 'https://raw.githubusercontent.com/itsdestin/youcoded/master/CHANGELOG.md';
const FETCH_TIMEOUT_MS = 10000;

export interface ChangelogResult {
  markdown: string | null;
  entries: ChangelogEntry[];
  fromCache: boolean;
  error?: boolean;
}

interface CacheFile {
  markdown: string;
  entries: ChangelogEntry[];
  fetched_at: string;
  app_version_at_fetch: string;
}

function cachePath(): string {
  // ~/.claude/.changelog-cache.json — Electron's app.getPath('home') returns ~/.
  // Test suite stubs app.getPath('home') with a temp dir.
  return path.join(app.getPath('home'), '.claude', '.changelog-cache.json');
}

function readCache(): CacheFile | null {
  try {
    const raw = fs.readFileSync(cachePath(), 'utf8');
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

function writeCache(data: CacheFile): void {
  try {
    const dir = path.dirname(cachePath());
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(cachePath(), JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Best-effort — a failed cache write shouldn't fail the whole operation.
  }
}

function fetchRemote(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'YouCoded' }, timeout: FETCH_TIMEOUT_MS }, (res: any) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        const redirect = res.headers?.location;
        if (!redirect) { reject(new Error('Redirect without location')); return; }
        fetchRemote(redirect).then(resolve, reject);
        return;
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve(body));
    });
    req.on('error', (err: Error) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

export async function getChangelog(opts: { forceRefresh: boolean }): Promise<ChangelogResult> {
  const cached = readCache();
  const currentVersion = app.getVersion();
  const cacheIsValid = cached && cached.app_version_at_fetch === currentVersion;

  if (!opts.forceRefresh && cacheIsValid && cached) {
    return { markdown: cached.markdown, entries: cached.entries, fromCache: true };
  }

  try {
    const markdown = await fetchRemote(CHANGELOG_URL);
    const entries = parseChangelog(markdown);
    const toCache: CacheFile = {
      markdown,
      entries,
      fetched_at: new Date().toISOString(),
      app_version_at_fetch: currentVersion,
    };
    writeCache(toCache);
    return { markdown, entries, fromCache: false };
  } catch {
    // Fetch failed — serve stale cache if any (even if app_version mismatch), else error shape.
    if (cached) {
      return { markdown: cached.markdown, entries: cached.entries, fromCache: true };
    }
    return { markdown: null, entries: [], fromCache: false, error: true };
  }
}
