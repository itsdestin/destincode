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
