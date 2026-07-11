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
- **models.dev `api.json` schema** — model/provider metadata. (model-catalog)
- **OpenRouter** — `/api/v1/models` shape, attribution headers
  (`HTTP-Referer`, `X-Title`), BYOK behavior. (provider-registry)
- **Per-vendor quirks** — reasoning blocks, prompt caching, rate-limit
  headers; one entry per adopted `@ai-sdk/*` provider. (provider-registry)
