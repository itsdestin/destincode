// Which provider a native session's model belongs to (Sign in with ChatGPT,
// design 2026-09-04).
//
// WHY a hook rather than a field on SessionInfo: a native session records its
// bound MODEL id; the provider is only known through the catalog. The status
// bar already accepts a `modelProviderType` prop that nothing filled — this is
// what fills it, so the usage chips and the /usage card can tell a ChatGPT-plan
// session from an OpenRouter one.
import { useEffect, useState } from 'react';

interface ProviderRow { id: string; type: string; label: string; ready: boolean }
interface CatalogRow { id: string; providerId: string; label: string }

// One load per page for both lists; the providers screen re-fetches on its own
// and a sign-in/out is rare enough that the next session open refreshes this.
type Lists = { providers: ProviderRow[]; catalog: CatalogRow[] };
let cache: Lists | null = null;
let inflight: Promise<Lists> | null = null;

async function load(): Promise<Lists> {
  if (cache) return cache;
  if (!inflight) {
    inflight = Promise.all([
      window.claude.providers.list().catch(() => []),
      window.claude.providers.catalog().catch(() => []),
    ]).then(([providers, catalog]) => {
      cache = {
        providers: Array.isArray(providers) ? providers as ProviderRow[] : [],
        catalog: Array.isArray(catalog) ? catalog as CatalogRow[] : [],
      };
      return cache;
    });
  }
  return inflight;
}

/** Synchronous read for callers outside React (the /usage snapshot factory).
 *  Null until the hook below has loaded the lists once. */
export function resolveProviderType(modelId: string | null | undefined): string | null {
  if (!modelId || !cache) return null;
  const row = cache.catalog.find((m) => m.id === modelId);
  const p = row && cache.providers.find((x) => x.id === row.providerId);
  return p?.type ?? null;
}

/** The provider type ('chatgpt', 'openrouter', 'local-engine', …) behind a
 *  native session's bound model id; null for Claude Code sessions, unknown ids,
 *  and until the lists have loaded. */
export function useModelProviderType(modelId: string | null | undefined): string | null {
  const [type, setType] = useState<string | null>(() => resolveProviderType(modelId));
  useEffect(() => {
    let alive = true;
    void load().then(() => { if (alive) setType(resolveProviderType(modelId)); });
    return () => { alive = false; };
  }, [modelId]);
  return type;
}
