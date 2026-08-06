# test-engine — llama.cpp smoke probes

Dev-run probes against the REAL pinned `llama-server` binary (never CI). Run all
three on every engine pin bump and record outcomes in
`../../docs/engine-dependencies.md` — the same discipline as `test-conpty/` on a
Claude Code bump.

The pinned version + per-platform asset table live in
`../src/main/engine/engine-pin.ts`. Regenerate that table with
`node ../scripts/generate-engine-pin.mjs <tag>`.

## Setup (once)

1. Get a `llama-server` binary of the pinned version. Easiest: install through
   the app (Settings → Providers → Install) and point `--binary` at
   `<userData>/engine/<version>-<backend>/llama-server(.exe)`. Or download the
   pinned release asset from
   `https://github.com/ggml-org/llama.cpp/releases/tag/<ENGINE_VERSION>` and
   unpack it (Windows `.zip` is flat; macOS/Linux `.tar.gz` nests under
   `llama-<tag>/`).
2. Drop a small single-file GGUF into `test-engine/cache/` (any works;
   ~0.5 GB keeps runs fast), e.g. `Qwen3-0.6B-Q4_K_M.gguf` from
   `unsloth/Qwen3-0.6B-GGUF` on Hugging Face.

`cache/` and `engine/` are git-ignored.

## Probes

- `node probe-health.mjs --binary <path>` — spawn shape: router mode boots with
  our exact flag set; `GET /health` returns 200 when ready. (Observed on b9992:
  200 with an EMPTY body — the supervisor only checks `res.ok`, never parses the
  body, so this is fine.)
- `node probe-models.mjs --binary <path>` — `GET /models` schema; asserts the
  router's model ids match `cache-scan.ts`'s filename-derived ids for the same
  directory. PRINTS both lists — on mismatch, fix `ggufIdFromFileName` in
  `cache-scan.ts` and this probe together, and update `engine-dependencies.md`.
- `node probe-chat.mjs --binary <path>` — streamed `/v1/chat/completions`
  round-trip: auto-load on first request, delta frames, final usage/timings.

Each probe exits 0 on pass and prints the raw JSON it saw (that output is what
goes into `engine-dependencies.md` entries).

## Review harness

`review-harness.mjs` drives a roster of cloud models through the same battery
of agentic tasks (navigate, read, search, edit, bash, web) against YouCoded's
native agent harness, and appends each model's free-form review to
`docs/active/investigations/2026-08-01-native-agent-harness-reviews.md` in the
workspace repo. It replaces the old workflow of copy-pasting a prompt by hand
into five separate sessions.

Build the compiled harness code first — the script imports `dist/`, never
`src/`, so it never runs something different from what the app ships:

```
npm run build
```

Then:

- `node test-engine/review-harness.mjs --dry-run` — prints the roster and the
  full battery prompt without spending anything or requiring a key. Use this
  to sanity-check the roster file before a real run.
- `OPENROUTER_API_KEY=sk-... node test-engine/review-harness.mjs --only "Kimi K3"` —
  runs a single model by its label from `review-roster.json`. The key is
  required even for a single model — only `--dry-run` skips the check.
- `OPENROUTER_API_KEY=sk-... node test-engine/review-harness.mjs` — runs the
  whole roster. Requires an OpenRouter API key; the script refuses to start
  without one and never writes the key to disk.

Each model gets its own disposable fixture workspace (a small seeded project
tree under `os.tmpdir()`, deleted after the run) so every model is tested
against identical files and no model can see another's leftovers. The full
event transcript for each model is saved to
`docs/active/investigations/harness-review-runs/<date>/<model-slug>.json`
**before** the review is appended to the doc, so any claim a review makes can
be checked against what the harness actually returned. Those transcripts are
git-ignored — the appended reviews are the durable record.

One model failing (a bad API response, a timeout) does not stop the rest of
the roster; the script prints the failure and moves on to the next model.
