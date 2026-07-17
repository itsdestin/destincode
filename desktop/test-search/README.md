# Search backend probes

Live-contract probes for the native WebSearch chain (spec §3.2). Run on every
search-backend change AND whenever a backend starts failing in the wild; record
observed shapes in `docs/provider-dependencies.md` (rows tagged `(search)`).

- `probe-exa.mjs "query" [--key K] [--out f.json]` — Exa hosted MCP (keyless default path)
- `probe-ddg.mjs "query" [--out f.html]` — DDG HTML fallback (single attempt; 202 = rate-limited, never retry)
- `probe-tavily.mjs --key tvly-... ["query"]` — keyed upgrade (skips politely without a key)

Captured fixtures live in `tests/fixtures/search/` and pin the parsers
(`tests/search-backends.test.ts`) — refresh them ONLY via these probes so the
fixture provenance is always a real response.

## What the probes observed (2026-07-16, keyless, from this machine)

- **Exa** — `https://mcp.exa.ai/mcp` answers a **stateless** `tools/call` (no
  `initialize` handshake needed) with HTTP 200. Transport is **SSE-framed**
  (`event: message\ndata: {json}`), not plain JSON. Tool `web_search_exa`
  `{query, numResults}`. Payload path `result.content[0].text` is a
  **human-readable plain-text block** (NOT a JSON string) — records separated by
  `\n\n---\n\n`, each with `Title:` / `URL:` / `Published:` / `Author:` /
  `Highlights:` fields. The `initialize` → `notifications/initialized` sequence
  is kept in the probe as a fallback only.
- **DDG** — `https://html.duckduckgo.com/html/?q=` returned **200** (not
  rate-limited). Parses `result__a` anchors + `result__snippet`. Hrefs are
  **indirect redirects**: `//duckduckgo.com/l/?uddg=<url-encoded target>&amp;rut=<hash>`
  — the parser must HTML-unescape `&amp;`, pull the `uddg` param, and
  `decodeURIComponent` it. A `202` (documented rate-limit) must be surfaced as
  an honest error and NEVER retry-hammered.
- **Tavily** — not exercised (no key on this machine); shape is from official
  docs and pinned to the probe's SKIP message.
