# Engine Coupling Registry (llama.cpp)

Tracks every YouCoded touchpoint to the bundled llama.cpp engine
(`llama-server`), mirroring the `cc-dependencies.md` discipline. Populated
starting Phase 1 of the platform roadmap (see youcoded-dev
`docs/superpowers/specs/2026-07-09-platform-vision-roadmap.md` and ADR 007).

## Pinned version

**`b9992`** — pinned 2026-07-13 (Phase 1 Plan B). Empirically verified on Windows
x64 (CPU build) against the real binary via `desktop/test-engine/`.

**Bump procedure** (same discipline as a Claude Code bump):
1. `node desktop/scripts/generate-engine-pin.mjs <new-tag>` → paste rows into
   `desktop/src/main/engine/engine-pin.ts`, bump `ENGINE_VERSION`.
2. Re-verify archive layouts (`binaryRelPath`) — Windows `.zip` is flat, macOS/
   Linux `.tar.gz` nest under `llama-<tag>/` (the generator templates the tag in;
   confirm it still holds).
3. Re-run `desktop/test-engine/probe-{health,models,chat}.mjs --binary <path>`
   with a small GGUF in `test-engine/cache/`. All three must PASS.
4. Update this file with anything that changed.

## Touchpoints

### `llama-server` CLI flags — spawn shape (engine-supervisor.ts)

Exact router-mode arg list (no `-m`):
```
--host 127.0.0.1 --port <ENGINE_PORT> --no-webui --jinja
--models-dir <cacheDir> --models-max 2 -c <contextSize>
```
- **`--models-dir <cacheDir>` is LOAD-BEARING.** It is what makes the router
  DISCOVER manually-placed GGUFs and auto-load them by filename id. Verified
  b9992: WITHOUT it, `GET /models` returns `{"data":[]}` and every
  `/v1/chat/completions` returns HTTP 400 `model '…' not found` — the feature is
  completely non-functional. (This build also has no `LLAMA_CACHE`-based flat
  discovery; see below.)
- **`--models-max 2`** — the router's LRU default is 4; 2 bounds RAM on consumer
  machines while keeping chat↔utility switching cheap.
- **`--jinja`** from day one so Phase 2 tool calling needs no process-shape change.
- **`-c` is inherited by every loaded model instance** — confirmed: the router
  writes each model's preset with `ctx-size = <-c>` (seen in `/models` `status`).

### Model discovery: `--models-dir` vs `LLAMA_CACHE` (engine-supervisor, cache-scan, engine-manager)

- **`--models-dir` serves flat `.gguf` files** dropped in the directory. The model
  id the router exposes is the **filename minus `.gguf`** — this EXACTLY matches
  `cache-scan.ts`'s `ggufIdFromFileName`, so the engine-off list (cache scan) and
  the engine-on list (`GET /models`) agree. Pinned by `probe-models.mjs`
  (router ids == scan ids).
- **`LLAMA_CACHE`** (still set in the env) only tracks `-hf` AUTO-DOWNLOADED models
  in a structured layout; `--cache-list` shows `0` for a flat dropped GGUF. It is
  kept for the Plan C `-hf`/`-hff` download path — NOT the current bring-your-own
  GGUF UX. (Plan C: an `-hf` pull may surface via the cache/preset mechanism
  rather than `--models-dir`; re-probe when Plan C wires downloads.)
- **`--models-preset PATH`** (INI) and `--cache-list` exist but are unused today.

### Health / readiness (engine-supervisor readiness poll)

`GET /health` → `200 {"status":"ok"}` when ready (503 while loading). The
supervisor checks `res.ok` ONLY and never parses the body, so a body-shape shift
is harmless. Router mode reports healthy with ZERO models in the dir — so
install-time `verifyBoot` works on a fresh machine before any GGUF exists.

### `GET /models` schema (engine-supervisor.listModels, cache-scan parity, probe-models.mjs)

Observed b9992 shape:
```json
{ "object": "list", "data": [
  { "id": "Qwen3-0.6B-Q4_K_M", "object": "model", "owned_by": "llamacpp",
    "created": 1783986018, "aliases": [], "tags": [],
    "status": { "value": "unloaded", "args": ["…","--model","…/Foo.gguf"], "preset": "…" },
    "architecture": { "input_modalities": ["text"], "output_modalities": ["text"] },
    "source": "models_dir", "can_remove": false } ] }
```
- **`status` is an OBJECT `{value: 'loaded'|'unloaded'|'loading'}`, NOT a bare
  string.** `listModels` reads `row.status.value` (with a string fallback). The
  original `row.status === 'loaded'` was always false. Regression-pinned in
  `engine-supervisor.test.ts`.
- **No `size` field** on `/models` rows — `sizeBytes` comes from the cache scan.
- `POST /models/load` / `/models/unload` take `{"model":"<id>"}` (unused in Plan B;
  auto-load on first chat request is what we rely on).

### `/v1/chat/completions` streaming (harness via @ai-sdk/openai-compatible; probe-chat.mjs)

- Naming an UNLOADED models-dir model auto-loads it on the first request.
- Stream frames: `data: {…"object":"chat.completion.chunk","choices":[{"delta":{"content":"…"}}]}`,
  terminated by `data: [DONE]`.
- The final frame carries `finish_reason` + a `timings` object
  (`predicted_per_second`, `predicted_n`, `prompt_n`, `prompt_ms`, …) and `usage`
  (`completion_tokens`/`prompt_tokens`/`total_tokens`). `HarnessSession` maps the
  SDK's usage → the transcript `usage` shape (native adds `tokensPerSecond`).
- Note: Qwen3 emits a `reasoning_content` field on the message; not consumed in
  Plan B (dormant reasoning path).

### Release assets + archive layout (engine-pin.ts, generate-engine-pin.mjs, engine-acquisition.ts)

- GitHub release API (`/repos/ggml-org/llama.cpp/releases/tags/<tag>`) publishes a
  per-asset SHA-256 `digest` (`sha256:…`), consumed verbatim by the generator.
- **Windows `.zip` archives are FLAT** — `llama-server.exe` + sibling DLLs at the
  archive root (`binaryRelPath: 'llama-server.exe'`).
- **macOS/Linux `.tar.gz` archives nest under `llama-<tag>/`** — binary at
  `llama-<tag>/llama-server` alongside its `.so`/`.dylib` (`binaryRelPath` is
  version-dependent; the generator templates the tag in). Do NOT revert to
  `build/bin/llama-server` (a stale guess). Enforced by `engine-acquisition`'s
  post-unpack existence check (fails loudly, never installs a broken dir).
- **There is NO upstream Linux CUDA asset** — CUDA opt-in (Plan C) is Windows-only.
- Windows unpack MUST use System32 `bsdtar` (reads both `.zip` and `.tar.gz`); a
  bare `tar` on PATH can resolve to Git's GNU tar, which cannot read `.zip`.

### GGUF cache layout (cache-scan.ts, Plan C downloader)

Flat `*.gguf` files in `--models-dir` (== the configured `cacheDir`). Multi-part
split sets follow `<name>-00001-of-000NN.gguf`; the model is addressed through its
first part and cache-scan sums the parts' sizes into one entry.

## Verification

`desktop/test-engine/` holds dev-run smoke probes (spawn the real engine, assert
health + `/models` parity + a streamed tool-less chat round-trip). Re-run all
three on every engine bump — analogous to `test-conpty/` on a CC bump. All three
PASS on b9992 (Windows x64 CPU, Qwen3-0.6B-Q4_K_M.gguf), 2026-07-13.
