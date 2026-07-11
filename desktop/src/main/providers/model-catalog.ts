// Merged, disk-cached model catalog (spec §2.2): OpenRouter /api/v1/models for
// the openrouter provider; models.dev api.json metadata for direct-key
// providers (anthropic/openai/google). openai-compatible custom endpoints get
// no catalog in Plan A (users type a model id). External schemas are recorded
// in docs/provider-dependencies.md — parse DEFENSIVELY; absent fields are
// omitted, never guessed.
import * as fs from 'fs';
import * as path from 'path';
import type { CatalogModel, ModelBinding, ProviderStatus } from '../../shared/provider-types';

const CACHE_FILE = 'provider-catalog-cache.json';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h, marketplace-cache precedent
// Model lists are big but not huge; a slow fetch should not hang the picker.
const FETCH_TIMEOUT_MS = 15_000;
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MODELSDEV_URL = 'https://models.dev/api.json';

type FetchLike = (url: string, init?: any) => Promise<{ ok: boolean; json: () => Promise<any> }>;
interface CacheShape { fetchedAt: number; openrouter: any | null; modelsdev: any | null; }

// models.dev provider keys for our direct-key ProviderTypes.
const MODELSDEV_KEY: Record<string, string> = { anthropic: 'anthropic', openai: 'openai', google: 'google' };

const EMPTY_CACHE: CacheShape = { fetchedAt: 0, openrouter: null, modelsdev: null };

/** Plain-object check — upstream rows can be null / strings / arrays; every
 *  field access below goes through this gate first. */
function isObj(x: unknown): x is Record<string, any> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

export class ModelCatalog {
  private ttlMs = TTL_MS;
  private readonly cachePath: string;
  constructor(cacheDir: string, private fetchImpl: FetchLike = fetch as any) {
    this.cachePath = path.join(cacheDir, CACHE_FILE);
  }

  /** null on missing/corrupt. Unlike providers.json (user data — read errors
   *  must surface), this cache is fully rebuildable from the network, so
   *  absorbing ALL read errors and refetching is the correct behavior. */
  private readCache(): CacheShape | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      if (!isObj(parsed) || typeof parsed.fetchedAt !== 'number') return null;
      return {
        fetchedAt: parsed.fetchedAt,
        openrouter: parsed.openrouter ?? null,
        modelsdev: parsed.modelsdev ?? null,
      };
    } catch {
      return null;
    }
  }

  /** Fresh-or-refetched cache. NEVER throws — a dead network degrades to the
   *  stale cache, or to an empty catalog when there is no cache at all. */
  private async ensureFresh(): Promise<CacheShape> {
    const stale = this.readCache();
    if (stale && Date.now() - stale.fetchedAt < this.ttlMs) return stale;

    let openrouter: any | null = stale?.openrouter ?? null;
    let modelsdev: any | null = stale?.modelsdev ?? null;
    let anySuccess = false;
    // Both sources in parallel; per-source failure keeps that source's stale
    // data (allSettled — one dead upstream must not blank the other's models).
    const [orRes, mdRes] = await Promise.allSettled([
      this.fetchImpl(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
      this.fetchImpl(MODELSDEV_URL, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }),
    ]);
    if (orRes.status === 'fulfilled' && orRes.value.ok) {
      // json() can also reject (truncated body) — treat like a failed fetch.
      try { openrouter = await orRes.value.json(); anySuccess = true; } catch { /* keep stale */ }
    }
    if (mdRes.status === 'fulfilled' && mdRes.value.ok) {
      try { modelsdev = await mdRes.value.json(); anySuccess = true; } catch { /* keep stale */ }
    }

    if (!anySuccess) {
      // Total failure: serve the stale cache entirely if we have one (don't
      // re-stamp fetchedAt — the next call should retry the network), else
      // an empty shape so get() yields [] rather than throwing.
      return stale ?? EMPTY_CACHE;
    }

    const fresh: CacheShape = { fetchedAt: Date.now(), openrouter, modelsdev };
    // Plain write, no tmp+rename: single consumer and fully rebuildable — a
    // torn file just reads as corrupt → refetch on the next call. Write
    // failures (read-only disk) are absorbed: the in-memory data still serves.
    try {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
      fs.writeFileSync(this.cachePath, JSON.stringify(fresh));
    } catch { /* cache write is best-effort */ }
    return fresh;
  }

  /** OpenRouter /api/v1/models rows → CatalogModel. Schema coupling recorded
   *  in docs/provider-dependencies.md; skip anything malformed. */
  private openrouterModels(payload: any, providerId: string): CatalogModel[] {
    const rows = isObj(payload) && Array.isArray(payload.data) ? payload.data : [];
    const out: CatalogModel[] = [];
    for (const row of rows) {
      if (!isObj(row) || typeof row.id !== 'string') continue; // skip malformed
      const m: CatalogModel = {
        id: row.id,
        providerId,
        label: typeof row.name === 'string' ? row.name : row.id,
      };
      if (typeof row.context_length === 'number') m.contextLength = row.context_length;
      if (Array.isArray(row.supported_parameters)) m.supportsTools = row.supported_parameters.includes('tools');
      // OpenRouter pricing is USD-per-TOKEN strings; CatalogModel.pricing is
      // USD per 1M tokens, hence the *1e6.
      const pricing = isObj(row.pricing) ? row.pricing : null;
      if (pricing) {
        const prompt = Number(pricing.prompt);
        const completion = Number(pricing.completion);
        if (Number.isFinite(prompt) && Number.isFinite(completion)) {
          m.pricing = { in: prompt * 1e6, out: completion * 1e6 };
        }
      }
      out.push(m);
    }
    return out;
  }

  /** models.dev api.json rows for one provider key → CatalogModel. */
  private modelsdevModels(payload: any, key: string, providerId: string): CatalogModel[] {
    const models = isObj(payload) && isObj(payload[key]) && isObj(payload[key].models)
      ? payload[key].models : null;
    if (!models) return [];
    const out: CatalogModel[] = [];
    for (const [id, row] of Object.entries(models)) {
      if (!isObj(row)) continue; // skip malformed
      const m: CatalogModel = {
        id,
        providerId,
        label: typeof row.name === 'string' ? row.name : id,
      };
      if (isObj(row.limit) && typeof row.limit.context === 'number') m.contextLength = row.limit.context;
      if (typeof row.tool_call === 'boolean') m.supportsTools = row.tool_call;
      if (typeof row.reasoning === 'boolean') m.supportsReasoning = row.reasoning;
      // models.dev cost is already USD per 1M tokens — no scaling.
      if (isObj(row.cost) && typeof row.cost.input === 'number' && typeof row.cost.output === 'number') {
        m.pricing = { in: row.cost.input, out: row.cost.output };
      }
      out.push(m);
    }
    return out;
  }

  /** Catalog rows scoped to the ENABLED providers passed in. Never throws. */
  async get(providers: ProviderStatus[]): Promise<CatalogModel[]> {
    const cache = await this.ensureFresh();
    const out: CatalogModel[] = [];
    for (const p of providers) {
      if (!p.enabled) continue; // disabled providers contribute nothing
      if (p.type === 'openrouter') {
        out.push(...this.openrouterModels(cache.openrouter, p.id));
      } else if (MODELSDEV_KEY[p.type]) {
        out.push(...this.modelsdevModels(cache.modelsdev, MODELSDEV_KEY[p.type], p.id));
      }
      // local-engine (Plan B) and openai-compatible (user types a model id)
      // have no catalog source in Plan A.
    }
    return out;
  }

  /** HarnessSession asks this for context-window sizing. null when the model
   *  isn't in the catalog (custom endpoints, stale cache) — caller decides. */
  async contextLengthFor(binding: ModelBinding, providers: ProviderStatus[]): Promise<number | null> {
    const models = await this.get(providers);
    const hit = models.find((m) => m.providerId === binding.providerId && m.id === binding.modelId);
    return hit?.contextLength ?? null;
  }
}
