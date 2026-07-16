// Tavily search backend — the key-gated first choice of the chain (used only
// when the user has added a Tavily key in Settings → Providers).
// Contract from Tavily's documented API. NO live capture exists — there is no
// Tavily key on the build machine — so this is pinned to the documented shape
// via tests/search-backends.test.ts rather than a captured fixture.
//
// Documented shape: POST https://api.tavily.com/search
//   headers: Authorization: Bearer <key>, content-type: application/json
//   body:    { query, max_results }
//   200 →    { results: [ { title, url, content }, … ] }
import { SearchBackend, SearchBackendError, SearchResult } from './types';

const ENDPOINT = 'https://api.tavily.com/search';
const HOST = 'api.tavily.com';
const MAX_RESULTS = 8;

export const tavilyBackend: SearchBackend = {
  id: 'tavily',
  async search(query, { key, signal, fetchImpl = fetch }) {
    // Tavily is the ONLY backend that cannot run keyless — fail early and clearly
    // rather than sending an unauthenticated request that would just 401.
    if (!key) throw new SearchBackendError('Tavily requires an API key.', true);

    let res: Response;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ query, max_results: MAX_RESULTS }),
        signal,
      });
    } catch (err) {
      // NEVER swallow an abort — rethrow the caller's cancellation untouched.
      if (signal.aborted) throw err;
      throw new SearchBackendError(`Could not reach ${HOST} — check the network connection.`);
    }

    // A rejected key is permanent for this pass — don't retry, tell the user
    // exactly where to fix it.
    if (res.status === 401 || res.status === 403) {
      throw new SearchBackendError('The Tavily API key was rejected — check it in Settings → Providers.', true);
    }
    if (!res.ok) throw new SearchBackendError(`Tavily answered HTTP ${res.status}.`);

    let body: any;
    try {
      // res.json() is inside the try too: a timeout/cancel DURING the body read
      // surfaces here, and must propagate as the abort — not a parse failure.
      body = await res.json();
    } catch (err) {
      if (signal.aborted || (err as { name?: string })?.name === 'AbortError') throw err;
      throw new SearchBackendError('Tavily returned a response this app could not parse.');
    }

    const rows = Array.isArray(body?.results) ? body.results : [];
    const results: SearchResult[] = [];
    for (const row of rows) {
      // Defensive: skip any row without a usable URL rather than emit a broken
      // result. `content` is the snippet when present.
      if (!row?.url || typeof row.url !== 'string') continue;
      // Fall back to the URL when the title is missing OR blank; trim both so a
      // whitespace-only field never ships as content.
      const title = (typeof row.title === 'string' ? row.title.trim() : '') || row.url;
      const snippet = typeof row.content === 'string' ? row.content.trim() : '';
      results.push({ title, url: row.url, ...(snippet ? { snippet } : {}) });
      if (results.length >= MAX_RESULTS) break;
    }
    return results;
  },
};
