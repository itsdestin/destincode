# Search backend fixtures

Captured contract fixtures pinning the native WebSearch parsers. Refresh ONLY
via the probes in `desktop/test-search/probe-*.mjs` so every fixture is a real
response, never hand-edited.

- **`exa-response.json`** — the **SSE-decoded** JSON-RPC 2.0 response body from
  `https://mcp.exa.ai/mcp` (`tools/call` → `web_search_exa`). The raw wire
  format is Server-Sent-Events frames, one per line pair:

  ```
  event: message
  data: {"result":{"content":[{"type":"text","text":"Title: ...\nURL: ..."}]},"jsonrpc":"2.0","id":1}
  ```

  The probe strips the `event:`/`data:` framing and stores the decoded
  `data:` JSON object here. Note `result.content[0].text` is itself a
  human-readable plain-text block (Title:/URL:/Published:/Author:/Highlights:
  records split on `---`), NOT nested JSON.
- **`ddg-response.html`** — a raw HTTP 200 capture of
  `https://html.duckduckgo.com/html/?q=...` (the full HTML page, unmodified).
