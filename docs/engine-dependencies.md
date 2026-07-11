# Engine Coupling Registry (llama.cpp)

Tracks every YouCoded touchpoint to the bundled llama.cpp engine
(`llama-server`), mirroring the `cc-dependencies.md` discipline. Populated
starting Phase 1 of the platform roadmap (see youcoded-dev
`docs/superpowers/specs/2026-07-09-platform-vision-roadmap.md` and ADR 007).

## Pinned version

_None yet — Phase 1 pins the first engine build here. Bump together with a
full coupling re-check + smoke probes._

## Touchpoints (to be filled as built)

- **`llama-server` CLI flags** — router mode, `--host/--port/--no-webui/--jinja`. (engine-supervisor)
- **Health/readiness endpoint** — poll target for spawn supervision. (engine-supervisor)
- **`/models`, `/models/load`, `/models/unload`** — router-mode model management. (model-catalog, engine-supervisor)
- **`/v1/chat/completions`** — OpenAI-compat surface incl. `tools`, `json_schema`. (provider layer via @ai-sdk/openai-compatible)
- **GGUF cache directory layout** — router auto-discovery contract. (model manager)
- **`-hf user/repo:QUANT` download semantics.** (model manager)

## Verification

_Phase 1 adds smoke probes analogous to `test-conpty/` (spawn real engine,
assert health + tool-call round-trip). Re-run on every engine bump._
