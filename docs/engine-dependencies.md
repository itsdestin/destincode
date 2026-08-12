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
- **`--models-dir` MUST EXIST or the router exits during startup (verified b9992).**
  A missing directory is FATAL: `error: '<dir>' does not exist or is not a directory`
  and the process exits immediately — it is NOT treated as "zero models, empty
  router." Since `cacheDir` (`~/.cache/llama.cpp`) is created lazily on the first
  model download, a fresh install's verify-boot ran BEFORE any model existed and
  always died this way. `EngineSupervisor.start()` therefore `fs.mkdirSync(cacheDir,
  {recursive:true})` before spawning (an empty dir boots fine — the router just
  serves no models yet). The supervisor also drains + tail-captures child stdout/
  stderr so a startup exit surfaces the engine's REAL message instead of a guess.
- **`--models-max 2`** — the router's LRU default is 4; 2 bounds RAM on consumer
  machines while keeping chat↔utility switching cheap.
- **`--sleep-idle-seconds 300` (2026-07-14)** — the router frees an idle model's
  memory after 5 min (status → `'sleeping'`) and wakes it on the next request.
  Verified b9992. FINER-grained than the engine-wide idle stop (`idleMs`, 10 min)
  which tears down the whole process — the two are complementary. `SLEEP_IDLE_SECONDS`
  in `engine-supervisor.ts`; the flag presence is pinned in `engine-supervisor.test.ts`.
- **`--jinja`** from day one so Phase 2 tool calling needs no process-shape change.
- **`-c` is inherited by every loaded model instance** — confirmed: the router
  writes each model's preset with `ctx-size = <-c>` (seen in `/models` `status`).

### Model discovery: `--models-dir` vs `LLAMA_CACHE` (engine-supervisor, cache-scan, engine-manager)

- **`--models-dir` serves flat `.gguf` files** dropped in the directory. The model
  id the router exposes is the **filename minus `.gguf`** — this EXACTLY matches
  `cache-scan.ts`'s `ggufIdFromFileName`, so the engine-off list (cache scan) and
  the engine-on list (`GET /models`) agree. Pinned by `probe-models.mjs`
  (router ids == scan ids).
- **`LLAMA_CACHE`** (still set in the env) only tracks `llama-server`'s own `-hf`
  AUTO-DOWNLOADED models in a structured layout; `--cache-list` shows `0` for a
  flat dropped GGUF. It is effectively **vestigial**: Plan C does NOT use
  `llama-server --hf` — its downloader (`model-downloader.ts`) fetches HF files
  over plain HTTP and writes them FLAT into this same cache dir, so Plan C models
  land under `--models-dir` discovery exactly like a hand-placed GGUF. So
  `--models-dir` covers BOTH bring-your-own AND Plan C downloads; `LLAMA_CACHE`
  is kept harmlessly, and should be revisited only if some future path actually
  invokes `-hf`. (Any new probe — including Plan C's `probe-download.mjs` — MUST
  spawn with `--models-dir`, or it falsely reports empty and mis-blames the
  downloader.)
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
- **`status` is an OBJECT `{value: 'loaded'|'unloaded'|'loading'|'sleeping'}`, NOT
  a bare string.** `listModels` maps `row.status.value` → `EngineModelState` via
  `mapModelState` (unknown → `'unloaded'`, the safe default). `'sleeping'` is
  produced by `--sleep-idle-seconds` (below). Regression-pinned in
  `engine-supervisor.test.ts`.
- **No `size` field** on `/models` rows — `sizeBytes` comes from the cache scan,
  merged in by id (the loading banner needs the model size).
- **Per-model state polling (2026-07-14):** the supervisor polls `GET /models`
  every ~1.5s while running and emits `models-changed` only on an (id→state)
  diff (llama-server has no push channel). `ipc-handlers` joins this with the
  session→model ref-count and pushes `native:model-state` per session → the
  ChatView unloaded/loading banner. Cheap localhost GET; timer is `.unref()`'d.
- `POST /models/unload` takes `{"model":"<id>"}` — used to free a model the
  moment its last session releases it (`NativeSessionHost` ref-count → 0, #1).
  `loadModel` warms a model via a 1-token `/v1/chat/completions` ([Reload Model]).

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

### Native tool-calling + real-ctx report (harness tool loop; `/props`; probe-tools.mjs)

Plan C runs Claude-Code-style tool calls straight through llama-server's OpenAI-
compatible endpoint. The coupling is `--jinja` + the `/v1/chat/completions` request
shape the harness sends, plus the `/props` read used to learn a loaded model's real
context window.

- **`--jinja` is what enables native tool-calling.** Already in the pinned spawn
  flag set (above), so no process-shape change was needed for Plan C. With it, a
  request carrying `tools: [...]` + `tool_choice: 'auto'` returns a
  `choices[0].message.tool_calls[]` whose `function.arguments` is a **JSON string**
  (parse it, don't read it as an object) matching the tool's `parameters` schema.
- **`parallel_tool_calls: false` pins serial-only tool use.** The harness executes
  one tool at a time (transcript + permission flow assume a single in-flight tool),
  so the request disables parallel calls rather than reconciling a fan-out.
- **Never-force invariant:** with `tool_choice: 'auto'` a plain-text prompt must come
  back with NO `tool_calls` — the model answers in `message.content`. A build that
  force-calls a tool on ordinary text would break normal chat; the probe asserts
  against this.
- **Real context window via `GET /props`.** The loaded model's actual `n_ctx` is the
  ground truth the known-model registry (advertised context) is checked against.
  **The field name drifts across builds** — read `default_generation_settings.n_ctx`
  first, then fall back to top-level `n_ctx`; if neither is present the build moved
  it again (re-check against the pinned tag). This is `-c` propagated to the loaded
  instance (see the `--models-dir` / `-c` notes above).
- **Verified by `test-engine/probe-tools.mjs`** — fires a tool-y prompt (asserts
  schema-valid JSON args), a plain prompt (asserts no forced call), and prints the
  `/props` `n_ctx`. Usage: `node test-engine/probe-tools.mjs http://127.0.0.1:<port>
  <model-id>` against an already-running engine. **Engine-bump gated:** re-run this
  probe whenever the pinned llama.cpp build changes (tool-call arg encoding and the
  `/props` field layout are both build-sensitive).

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

### GGUF cache layout + downloader naming contract (cache-scan.ts, Plan C model-downloader.ts)

Flat `*.gguf` files in `--models-dir` (== the configured `cacheDir`). Multi-part
split sets follow `<name>-00001-of-000NN.gguf`; the model is addressed through its
first part and cache-scan sums the parts' sizes into one entry.

- **Downloader flat-basename contract (Plan C):** `model-downloader.ts` writes each
  HF file into the cache dir under its BASENAME (repo subfolders collapsed) — that
  is exactly what `--models-dir` discovery + `cache-scan.ts`'s `ggufIdFromFileName`
  read, so the router-served id == the downloaded filename minus `.gguf`. NEVER
  rename downloaded files or change how split parts are named without re-running
  `probe-download.mjs`.
- **Multi-part router-id VERIFIED (Amendment H):** `probe-download.mjs` downloads a
  real ~0.4 GB unsloth GGUF, ALSO splits it with the sibling `llama-gguf-split`
  (same archive as `llama-server`), drops both flat in the cache, and asserts the
  router LISTS + SERVES both the single-file id AND the `-00001-of-00002` split id,
  with a real chat round-trip against the split model. This is the only cheap check
  of the large-tier (gpt-oss-120b / Qwen3.5-122B) multi-part path, which can't be
  downloaded on a 32 GB dev box. **PASS on b9992** (Windows x64 Vulkan,
  `Qwen3-0.6B-Q4_K_M` single + `Qwen3-0.6B-SPLIT-00001-of-00002`), 2026-07-14 —
  router discovered both ids from `--models-dir` and served the split model.
- **Router hot-reload of `--models-dir` after boot — worked around in code
  (2026-07-15); upstream behavior still NOT verified live.** The router discovers
  GGUFs at BOOT; whether a file downloaded AFTER boot appears in `GET /models` is
  unverified upstream (Amendment K2). `EngineSupervisor.listModels()` therefore
  UNIONS a fresh `scanGgufCache` into the running router's `GET /models` rows
  (router rows win — they carry live residency state; disk-only rows surface as
  'unloaded'), so a just-downloaded model is immediately visible in
  `catalogModels()` → the new-session picker's Local group, `liveModels()` → the
  memory guard, and the model poll — no engine restart needed for LISTING.
  Guard: engine-supervisor.test.ts "listModels UNIONS the disk scan". Still open
  for the live pass: whether the running router can actually SERVE (hot-load) a
  post-boot file when a completion requests it, or 400s until a restart — resolve
  on Destin's dev machine.

## Verification

`desktop/test-engine/` holds dev-run smoke probes (spawn the real engine, assert
health + `/models` parity + a streamed tool-less chat round-trip). Re-run all
three on every engine bump — analogous to `test-conpty/` on a CC bump. The
original three PASS on b9992 (Windows x64 CPU, Qwen3-0.6B-Q4_K_M.gguf), 2026-07-13.
`probe-download.mjs` (Plan C: flat-basename ↔ router-id for single AND multi-part)
PASS on b9992 (Windows x64 Vulkan), 2026-07-14 — also re-run on every engine bump.
`probe-tools.mjs` (Plan C: `--jinja` constrained tool-call round-trip + never-force +
real `/props` `n_ctx`) runs against an already-running engine — re-run on every engine
bump; verified live during acceptance on the Linux dev box.

## Parallel slots (specialists, plan 1a probe)

**Measured 2026-08-12** on the Linux dev box against a system-installed
`llama-server` (`version: 9957 (c4ae9a88f8)`, i.e. build `b9957` — NOT the app's
pinned `b9992`; this was the only binary available on this machine, so results
are directionally useful but should be re-checked against `b9992` before being
treated as final). Server launched manually on an isolated port (8199, separate
from the live app's engine on 9920) with the supervisor's exact router-mode arg
list (`engine-supervisor.ts:285-306`), `-c 8192` (shrunk from the real default
32768 only to keep iteration fast on this box), against `Qwen3.5-2B-Q8_0`
(the smallest model in `~/.cache/llama.cpp`). `desktop/test-engine/probe-parallel.mjs`
fires N simultaneous short chat completions (`max_tokens: 24`) for N in {1, 2, 4}
and reports total wall time, average per-request time, and a total-vs-N×single
classification.

**Run 1 — default args (no `--parallel`, i.e. `-np -1` = auto):**

| N | total_ms | avg_req_ms | min_ms | max_ms | classification |
|---|----------|------------|--------|--------|----------------|
| 1 | 642 | 641 | 641 | 641 | batched (baseline) |
| 2 | 599 | 598 | 597 | 599 | batched |
| 4 | 1200 | 1188 | 1178 | 1199 | partial |

Server startup log showed `n_slots = 4` even with no `--parallel` flag —
this build's `-np -1` "auto" already resolves to 4 slots on this hardware.

**Run 2 — explicit `--parallel 4` added to the same spawn args:**

| N | total_ms | avg_req_ms | min_ms | max_ms | classification |
|---|----------|------------|--------|--------|----------------|
| 1 | 558 | 558 | 558 | 558 | batched (baseline) |
| 2 | 495 | 486 | 477 | 495 | batched |
| 4 | 952 | 939 | 935 | 950 | partial |

`--parallel 4` added to the supervisor's arg set did **not** error — the
process started and served normally. Numbers are consistent with Run 1 within
noise, confirming the "auto" default and an explicit `--parallel 4` behave the
same on this build/hardware (4 slots either way).

**Decision:** `LOCAL_MAX_CONCURRENT_SPECIALISTS = 4` — at N=4, avg per-request
latency (~939–1188 ms) is ≤ 2× the single-request baseline (~558–642 ms) in
both runs (ratio ≈ 1.7–1.85×), the largest of the tested N values that clears
that bar. N=2 batches cleanly (avg per-request latency actually *dropped*
below the single-request baseline in both runs — within measurement noise, not
a real speedup). N=4 shows partial batching, not full serialization.

**Supervisor arg change:** because this build's default already resolves to 4
slots, adding `--parallel 4` explicitly to `engine-supervisor.ts`'s spawn args
is optional on this hardware/build but is still recommended for plan 1b — it
pins the slot count instead of relying on an "auto" heuristic that could
resolve differently on a smaller consumer machine (fewer cores/less RAM). That
supervisor code change belongs to plan 1b, not this probe.

**Caveat:** measured against a non-pinned build (`b9957` vs the app's pinned
`b9992`) and a reasoning model (`Qwen3.5-2B` emits `reasoning_content`,
truncated by the low `max_tokens`) rather than a plain chat model — re-run
`probe-parallel.mjs` against `b9992` with the app's actual small-model tier
before this decision is treated as load-bearing.

## KV prefix reuse (specialists, plan 1a probe)

**Measured 2026-08-12**, same server/model/build as above (default args, no
`--parallel`; single manually-launched instance on port 8199).
`desktop/test-engine/probe-prefix-cache.mjs` builds a ~2,000-token filler
system prefix, sends two sequential requests sharing it (different user
turns) for run (a), then two sequential requests with fully distinct
~2,000-token prefixes for run (b), reading `timings.prompt_ms` from each
completion payload (present on this build — no wall-clock fallback needed).

| run | request | prompt_n | prompt_ms |
|-----|---------|----------|-----------|
| (a) identical prefix | a1 (cold) | 2209 | 1407.8 |
| (a) identical prefix | a2 (same prefix, new user turn) | 17 | 177.6 |
| (b) distinct prefixes | b1 (prefix A again) | 19 | 180.8 |
| (b) distinct prefixes | b2 (prefix B, never seen) | 2207 | 1804.0 |

a2/b2 prefill ratio = 177.6 / 1804.0 = **9.8%** (well under the 50% reuse
threshold).

**Verdict: prefix reuse survives sequential child-style fan-out on build
b9957.** `prompt_n` on a repeated-prefix request drops from ~2,200 to ~17–19
tokens (only the new user turn is reprocessed), and prefill time drops
correspondingly from ~1.4–1.8s to ~0.18s. The server log for the parallel
probe (above) independently corroborates this: repeat requests were
`selected slot by LCP similarity` rather than by LRU, i.e. the router matched
the incoming prompt against a cached slot's longest common prefix.

Note run (b)'s b1 also hit the cache (reused prefix A's slot from run (a)'s
a2, since b1 resends prefix A) — this is expected given all four requests ran
sequentially against the same server instance and slot LRU/LCP selection
persists across the two "runs" as scripted (they are not isolated fresh
server starts). This does not weaken the verdict — b2 (the first-ever
occurrence of prefix B) is the true cold-prefix comparison point, and it cost
2207 prompt tokens vs a2's 17.
