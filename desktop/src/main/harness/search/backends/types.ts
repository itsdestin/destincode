// Shared contract for the WebSearch backend chain (exa → ddg → tavily).
// Each backend turns one provider's raw HTTP response into a uniform list of
// results; the chain (search-chain.ts) walks them in order until one succeeds.

export interface SearchResult {
  title: string;
  url: string;
  snippet?: string;
}

/**
 * A backend failure the chain absorbs and reports honestly.
 * WHY: per docs/error-message-standards.md every user-facing message must be
 * specific and true — never a bare status code, never a guessed-at cause.
 * `permanent` marks failures that must NOT be retried against the same backend
 * this pass (rate-limits, rejected keys, changed markup) so the chain moves on
 * to the next provider instead of hammering a dead end.
 */
export class SearchBackendError extends Error {
  constructor(message: string, public readonly permanent = false) {
    super(message);
    this.name = 'SearchBackendError';
  }
}

export interface SearchBackend {
  id: 'exa' | 'ddg' | 'tavily';
  search(
    query: string,
    opts: { key: string | null; signal: AbortSignal; fetchImpl?: typeof fetch },
  ): Promise<SearchResult[]>;
}
