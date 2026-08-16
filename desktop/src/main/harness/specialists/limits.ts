// Per-parent specialist concurrency ceiling (plan 1a, Task 6, spec §5 Global
// Constraints scope decision: PER-PARENT, never host-global — one session's
// fan-out must not be capped by an unrelated session's children). This is
// Task 1's recorded local-engine parallel-capacity measurement as a static v1a
// value; a real per-model number arrives via the profile in plan 1b.
//
// Lives in its own file (not native-session-host.ts, where it's enforced, nor
// tools/task.ts, where it's rendered into the at-capacity refusal copy)
// because both of those files need it and importing native-session-host.ts
// from tools/task.ts would cycle: native-session-host -> harness-session ->
// tools/task -> native-session-host.
export const HOSTED_MAX_CONCURRENT_SPECIALISTS = 4;
