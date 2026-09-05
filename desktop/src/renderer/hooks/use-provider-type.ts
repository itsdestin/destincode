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

// One load per page for both lists, held until something that changes the
// answer says so. WHY not "load once and never again" (the first version):
// a session started right after signing in to ChatGPT resolved to null — no
// chips, no plan on /usage — until the whole app reloaded, because the lists
// were captured before the sign-in added the plan's rows (design review
// R3-4, 2026-09-05). The ChatGPT card and the providers screen now call
// invalidateProviderTypeCache() after every change they make, and every
// mounted hook re-resolves from the fresh lists.
type Lists = { providers: ProviderRow[]; catalog: CatalogRow[] };
let cache: Lists | null = null;
let inflight: Promise<Lists> | null = null;
// Mounted hooks, told to re-read after an invalidation.
const listeners = new Set<() => void>();
// Model ids that already earned their one miss-triggered refetch (below).
const refetchedMisses = new Set<string>();

/** Forget the cached lists and make every mounted hook re-read them. Call
 *  after anything that adds or removes a provider or its models: a ChatGPT
 *  sign-in/out, a provider upsert/remove/setKey. Cheap — two IPC reads. */
export function invalidateProviderTypeCache(): void {
  cache = null;
  inflight = null;
  // A fresh sign-in may have just added the rows an earlier miss was about,
  // so every id gets its one refetch back.
  refetchedMisses.clear();
  for (const fn of Array.from(listeners)) fn();
}

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
  // INTERIM RULE for an id several providers share: the ChatGPT plan's row
  // wins. models.dev's `openai` list carries the same ids the plan uses
  // (`gpt-5.5`, …), so with an OpenAI-key provider AND the plan configured a
  // plain first-match could call a plan session "openai" — wrong chips, wrong
  // /usage plan, wrong limit card. The registry appends the plan's row FIRST
  // for the same reason. This stays until the session carries its own
  // providerType from main (a later task); then the lookup is a fallback only.
  const rows = cache.catalog.filter((m) => m.id === modelId);
  const row = rows.find((m) => m.providerId === 'chatgpt') ?? rows[0];
  const p = row && cache.providers.find((x) => x.id === row.providerId);
  return p?.type ?? null;
}

/** True when the lists are loaded and the id is genuinely not in them —
 *  the case that earns one refetch, since a session's model can arrive a
 *  beat before the catalog that names it. */
function isMiss(modelId: string | null | undefined): boolean {
  return !!modelId && !!cache && !cache.catalog.some((m) => m.id === modelId);
}

/** The provider type ('chatgpt', 'openrouter', 'local-engine', …) behind a
 *  native session's bound model id; null for Claude Code sessions, unknown ids,
 *  and until the lists have loaded. */
export function useModelProviderType(modelId: string | null | undefined): string | null {
  const [type, setType] = useState<string | null>(() => resolveProviderType(modelId));
  useEffect(() => {
    let alive = true;
    const read = () => {
      void load().then(() => {
        if (!alive) return;
        // ONE refetch on a miss, then accept the answer: an id nobody lists
        // (a removed provider's model) must not re-read the lists on every
        // render. The guard is per id and resets only on an invalidation.
        if (isMiss(modelId) && !refetchedMisses.has(modelId!)) {
          refetchedMisses.add(modelId!);
          cache = null;
          inflight = null;
          void load().then(() => { if (alive) setType(resolveProviderType(modelId)); });
          return;
        }
        setType(resolveProviderType(modelId));
      });
    };
    listeners.add(read);
    read();
    return () => { alive = false; listeners.delete(read); };
  }, [modelId]);
  return type;
}
