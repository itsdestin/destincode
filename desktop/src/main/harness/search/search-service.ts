// Walks the data-driven backend chain (spec §3.2): first usable backend wins;
// failures are COLLECTED and, on exhaustion, surfaced as one honest message
// ending in the "add a key" upgrade path (never a silent empty result).
import type { SearchChainEntry } from './search-chain';
import { SearchBackendError, type SearchBackend, type SearchResult } from './backends/types';

const PER_BACKEND_TIMEOUT_MS = 10_000;

export class SearchUnavailableError extends Error {}

export interface SearchOutcome { results: SearchResult[]; source: string }

interface ChainLike { get(): Promise<SearchChainEntry[]> }
interface KeysLike { getKey(backend: 'tavily' | 'exa'): Promise<string | null> }

export class SearchService {
  constructor(
    private chain: ChainLike,
    private keys: KeysLike,
    private backends: Record<'exa' | 'ddg' | 'tavily', SearchBackend>,
  ) {}

  async search(query: string, signal: AbortSignal): Promise<SearchOutcome> {
    const failures: string[] = [];
    let anyKey = false;
    for (const entry of await this.chain.get()) {
      // Defend the precondition HERE, don't trust the chain layer: search-chain.ts
      // filters to VALID_BACKENDS today, but that's an unstated cross-file
      // invariant. If the chain ever names a backend with no registered impl,
      // a bare this.backends[x].search would TypeError and leak an internals
      // message (error-message-standards.md forbids). Surface a clean failure.
      const impl = this.backends[entry.backend];
      if (!impl) { failures.push(`${entry.backend}: no backend implementation registered`); continue; }
      const key = entry.backend === 'ddg' ? null : await this.keys.getKey(entry.backend);
      if (key) anyKey = true;
      if (entry.requiresKey && !key) continue;
      try {
        const results = await impl.search(query, {
          key, signal: AbortSignal.any([signal, AbortSignal.timeout(PER_BACKEND_TIMEOUT_MS)]),
        });
        if (results.length > 0) return { results, source: entry.backend };
        failures.push(`${entry.backend}: returned no results`);
      } catch (err: any) {
        if (signal.aborted) throw err; // user interrupt — let the driver own it
        failures.push(`${entry.backend}: ${err instanceof SearchBackendError ? err.message : `Could not reach the service (${err?.message ?? err}).`}`);
      }
    }
    // These hints become the isError tool text the model may relay VERBATIM, so
    // phrase them as plain pass-through statements — no "tell the user:" meta.
    const hint = anyKey
      ? 'All configured search backends failed — this may be temporary.'
      : 'Web search has no API key configured; adding a free Tavily or Exa key in Settings → Providers makes it faster and more reliable.';
    throw new SearchUnavailableError(`Web search is unavailable right now. ${failures.join(' | ')}. ${hint}`);
  }

  /** Never-throw key check for the Settings "Test" button (testConnection pattern). */
  async testBackend(backend: 'tavily' | 'exa', key: string): Promise<{ ok: boolean; message: string }> {
    try {
      const results = await this.backends[backend].search('youcoded connectivity test', {
        key, signal: AbortSignal.timeout(PER_BACKEND_TIMEOUT_MS),
      });
      return { ok: true, message: `Working — ${results.length} results returned.` };
    } catch (err: any) {
      return { ok: false, message: err?.message ?? String(err) };
    }
  }
}
