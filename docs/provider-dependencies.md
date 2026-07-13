# Provider Coupling Registry (cloud APIs + AI SDK)

Tracks YouCoded's couplings to external model-provider APIs and the Vercel
AI SDK, mirroring `cc-dependencies.md`. Populated starting Phase 1 (ADR 006
in the youcoded-dev workspace).

## Pinned versions

_None yet — Phase 1 pins the AI SDK major/minor here._

## Touchpoints (to be filled as built)

- **Vercel AI SDK surface** — `streamText` stream-part shapes, tool-approval
  mechanism (`needsApproval` vs `toolApproval` — version-sensitive), provider
  factory signatures. (harness, provider-registry)
- **models.dev `api.json` schema** — `https://models.dev/api.json`, shape
  `{ [providerKey]: { models: { [modelId]: {...} } } }`. Fields consumed per
  model row: `name` (string label), `limit.context` (number → contextLength),
  `tool_call` (boolean → supportsTools), `reasoning` (boolean →
  supportsReasoning), `cost.input` / `cost.output` (numbers, ALREADY USD per
  1M tokens — no scaling). Provider keys used: `anthropic`, `openai`,
  `google`. Parsed DEFENSIVELY in `src/main/providers/model-catalog.ts` —
  malformed rows are skipped, absent fields omitted (never guessed), and a
  failed fetch falls back to the 24h disk cache
  (`provider-catalog-cache.json` in Electron userData — per-profile, so the
  dev instance and the built app never share or contend for it),
  stale-if-offline. If
  models.dev renames fields or restructures the top level, the catalog
  silently thins out rather than erroring — check this consumer first.
  (model-catalog)
- **OpenRouter `/api/v1/models`** — `https://openrouter.ai/api/v1/models`,
  shape `{ data: [...] }`. Fields consumed per row: `id` (string, required —
  rows without it are skipped), `name` (string label), `context_length`
  (number), `supported_parameters` (string array — `includes('tools')` →
  supportsTools), `pricing.prompt` / `pricing.completion` (STRINGS, USD per
  single token — multiplied by 1e6 into CatalogModel's per-1M convention).
  Same defensive-parse + stale-cache-fallback posture as models.dev; consumer
  is `src/main/providers/model-catalog.ts`. (model-catalog)
- **OpenRouter attribution + BYOK** — attribution headers (`HTTP-Referer`,
  `X-Title`), BYOK behavior. (provider-registry)
- **Per-vendor quirks** — reasoning blocks, prompt caching, rate-limit
  headers; one entry per adopted `@ai-sdk/*` provider. (provider-registry)
