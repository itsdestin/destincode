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

// Task 12, item 3 (plan 1b, spec §3): a per-parent LIFETIME cap on how many
// specialists one conversation may ever spawn — distinct from the concurrency
// ceiling above (which only limits how many run AT ONCE and is released as
// children finish). This one never releases: it is a runaway-loop backstop
// for a model that keeps delegating without end, not a resource limit, so 30
// is generous headroom for legitimate fan-out while still catching a loop.
export const SPECIALIST_SPAWN_BUDGET_PER_SESSION = 30;

// Task 7 (plan 1b, spec §3): liveness is HEARTBEAT-based, never wall-clock —
// these are the two "no activity" thresholds runSpecialist's listener polls
// lastActivityAt against. Crossing one only ever sets `stale: true` on the
// ledger record (read by the Task 5 status block); nothing here aborts,
// interrupts, or fails a child. A slow local model doing a long prefill must
// never be flagged: the harness watchdog's text-less `assistant-thinking`
// heartbeats flow through the same transcript-event stream and count as
// activity even though session-store.ts drops them from disk.
//
// The in-tool threshold is longer because a real tool call (Bash, a slow
// local model's own tool round-trip) can legitimately run for minutes with no
// transcript event in between — treating that the same as idle silence
// between turns would flag healthy long-running tool use as stuck.
export const SPECIALIST_IDLE_STALE_MS = 120_000;
export const SPECIALIST_IN_TOOL_STALE_MS = 300_000;
