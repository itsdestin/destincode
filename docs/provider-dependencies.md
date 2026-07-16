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
- **AI SDK v7 tool-call loop surface** — tools passed WITHOUT `execute` make
  `streamText` emit a `tool-call` fullStream part and finish the step with
  finishReason `'tool-calls'` (the SDK does NOT loop on its own). The RAW
  provider chunk (`LanguageModelV4ToolCall`) carries `input` as a STRINGIFIED
  JSON string and `finishReason` as the V4 object `{ unified, raw }`;
  `streamText` TRANSFORMS these into the fullStream `tool-call` part
  `{ type:'tool-call', toolCallId, toolName, input:<parsed object> }` and
  flattens `result.finishReason` back to the `'tool-calls'` string. The driver
  executes tools itself and appends an assistant message with a
  `{ type:'tool-call', toolCallId, toolName, input:<object> }` part plus a
  `role:'tool'` message whose parts are
  `{ type:'tool-result', toolCallId, toolName, output:{ type:'text', value } }`
  — the v7 field is `output` (a `ToolResultOutput`), NOT `result`. Error
  surface (for the Task 9 retry wrapper): `streamText` returns synchronously
  and never throws; a `doStream` rejection appears as a `{ type:'error' }`
  fullStream part AND rejects the awaited promises (`result.text` throws
  `AI_NoOutputGeneratedError`); the SDK already wraps calls in
  `retryWithExponentialBackoff` internally. Field names verified against
  ai@7.0.22 and PINNED by
  `desktop/tests/harness-sdk-toolcall-contract.test.ts` — run it first on any
  ai bump. (harness)
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
- **HF model search** —
  `https://huggingface.co/api/models?search=<q>&filter=gguf&sort=downloads&limit=30`.
  Fields consumed per row: `id` (string, required — rows without it are
  skipped), `downloads` / `likes` (numbers, default 0 when absent). Parsed
  DEFENSIVELY — a non-array response yields no hits. Consumer:
  `src/main/models/hf-client.ts`. (hf-client)
- **HF repo tree** —
  `https://huggingface.co/api/models/<owner>/<repo>/tree/main?recursive=true`.
  `recursive=true` is REQUIRED (unsloth keeps dynamic quants in subfolders).
  Fields consumed per row: `type` (`file` / `directory` — only `file` rows
  are kept), `path` (string, required), `size` (number, required), `lfs.oid`
  (64-hex sha256, optional → null when absent or malformed; the downloader
  skips verification when null). Rows missing a required field are skipped.
  Consumers: `src/main/models/hf-client.ts`, `model-downloader.ts`. (hf-client)
- **HF resolve URLs** —
  `https://huggingface.co/<owner>/<repo>/resolve/main/<path>` → 302 to the CDN
  (Node fetch follows redirects). `Range` request support is relied on for
  resumable downloads. Path segments are individually `encodeURIComponent`-encoded
  (subfolders preserved). Consumer: `model-downloader.ts`. (hf-client)
- **Curated remote list** —
  `https://raw.githubusercontent.com/itsdestin/youcoded/master/curated-models.json`.
  Gated on `schemaVersion` (must equal 1); on fetch failure or a malformed /
  version-mismatched payload, falls back to the shipped copy. Consumer:
  `src/main/models/curated-catalog.ts`. (curated-catalog)
