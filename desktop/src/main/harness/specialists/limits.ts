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

// Task 8 (plan 1b, spec: child asks route to the parent): how long a routed
// ask (max_steps / doom_loop / a deny-listed permission ask carried through
// from child-permissions.ts) waits on the PARENT's screen before the child's
// blocked call is unblocked with the scripted redirect. 5 minutes is enough
// for a user who is at their machine to notice and answer, without leaving a
// background specialist stalled indefinitely on a card nobody may ever see.
// Not "how long until we give up" — the ask stays pending and answerable
// past this deadline; this is only how long the CHILD waits before it is
// told to route around the block and keep working.
export const SPECIALIST_ASK_HOLD_MS = 300_000;

// Task 2 (plan 1c, spec §3): the cap on a file-defined specialist's
// `description` in the definition the Task tool interpolates into its
// instructions every turn. WHY: every offered description is text repeated
// on every turn, and a repo's `.claude/agents/*.md` file controls it — an
// unbounded description would let one file bloat every turn's prompt. The
// full text is kept for Settings (definition-files.ts's `fullDescription`).
export const MAX_DESCRIPTION_CHARS = 300;
