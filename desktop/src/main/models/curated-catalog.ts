// Curated model list (spec §4.1): shipped in-app AND refreshed from a raw
// GitHub URL in the youcoded repo (the announcements pattern) so
// recommendations update without an app release. Remote failure falls back to
// the freshest thing we have: disk cache first, shipped copy last.
import * as fs from 'fs';
import * as path from 'path';
import type { CuratedModel } from '../../shared/model-manager-types';
import { SHIPPED_CURATED, CURATED_SCHEMA_VERSION } from './curated-models';

const REMOTE_URL = 'https://raw.githubusercontent.com/itsdestin/youcoded/master/curated-models.json';
const CACHE_FILE = 'curated-models-cache.json';
const TTL_MS = 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 10_000;

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; json: () => Promise<any> }>;

function validList(payload: any): CuratedModel[] | null {
  if (!payload || payload.schemaVersion !== CURATED_SCHEMA_VERSION || !Array.isArray(payload.models)) return null;
  const out: CuratedModel[] = [];
  for (const m of payload.models) {
    // Defensive parse: a malformed row is dropped, never guessed at.
    if (typeof m?.id !== 'string' || typeof m?.hfRepo !== 'string' || typeof m?.label !== 'string') continue;
    if (!['small', 'everyday', 'large'].includes(m?.tier)) continue; // 3 tiers (Amendment A)
    if (typeof m?.quantDefault !== 'string') continue;               // no quants[] in the shape (Amendment D)
    out.push(m as CuratedModel);
  }
  return out.length > 0 ? out : null;
}

export class CuratedCatalog {
  private cachePath: string;
  constructor(cacheDir: string, private fetchImpl: FetchLike = fetch as any) {
    this.cachePath = path.join(cacheDir, CACHE_FILE);
  }

  private readCache(): { fetchedAt: number; models: CuratedModel[] } | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      const models = validList({ schemaVersion: CURATED_SCHEMA_VERSION, models: parsed.models });
      if (typeof parsed.fetchedAt !== 'number' || !models) return null;
      return { fetchedAt: parsed.fetchedAt, models };
    } catch { return null; }
  }

  /** Never throws: remote → cache → shipped, in freshness order. */
  async get(): Promise<CuratedModel[]> {
    const cached = this.readCache();
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) return cached.models;
    try {
      const res = await this.fetchImpl(REMOTE_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok) {
        const models = validList(await res.json());
        if (models) {
          try {
            fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
            fs.writeFileSync(this.cachePath, JSON.stringify({ fetchedAt: Date.now(), models }));
          } catch { /* cache write is best-effort */ }
          return models;
        }
      }
    } catch { /* offline / timeout — fall through */ }
    return cached?.models ?? SHIPPED_CURATED;
  }
}
