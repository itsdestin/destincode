# ARCHIVED — do not merge

This branch is the complete OpenCode-as-provider MVP (May 2026). It was
superseded by the platform roadmap (youcoded-dev
`docs/superpowers/specs/2026-07-09-platform-vision-roadmap.md`): the native
harness replaces the OpenCode daemon, and llama.cpp-direct replaces Ollama
(ADRs 006/007 in the youcoded-dev workspace). Kept as REFERENCE MATERIAL:

- `desktop/src/main/opencode-session-adapter.ts` — event-translation patterns
  (streaming deltas, tool state machine, resume hydration, uuid dedup) that
  inform the Phase 2 native harness
- `desktop/src/main/opencode-service.ts` + tests — subprocess supervision
  pattern reused by the Phase 1 EngineSupervisor
- `desktop/src/main/ollama-detector.ts` — basis for the Phase 1 optional
  Ollama endpoint detector
- `desktop/test-ollama/probe-model.mjs` — capability-probe harness idea

The salvageable UI/seam work was re-applied to master via feat/provider-seam
(PR #115): runtime selector, runtime-aware gating, collapsible reasoning UI,
SessionProvider seam.
