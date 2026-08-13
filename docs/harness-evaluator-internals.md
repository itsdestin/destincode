# Harness evaluator — internals

Depth doc for `.claude/rules/harness-evaluator.md` (workspace repo). Read this when you are
changing `src/main/harness/eval/**` or the two CLIs themselves; the rule carries what you
need to merely *use* the evaluator.

Code: `desktop/src/main/harness/eval/` · CLI: `desktop/test-engine/harness-eval.mjs` +
`harness-eval-worker.mjs` · Legacy CLI: `desktop/test-engine/review-harness.mjs` · Tests:
`desktop/tests/harness-eval-*.test.ts`, `desktop/tests/harness-review-runner.test.ts`,
`desktop/tests/harness-review-fixture.test.ts`

## The process split, and why it exists

The orchestrator (`harness-eval.mjs`) expands a plan into cells and spawns
`harness-eval-worker.mjs` **once per cell**. One process per cell is not tidiness: a cell
names a `dist/` to run the harness from, and two builds of `HarnessSession` cannot coexist
in one Node process.

The consequence that is easy to get wrong: **only the worker loads the cell's `dist`.** The
orchestrator loads the *graders* — `matrix.js`, `cases/index.js`, `assertions.js`,
`judge.js`, `report.js` — from its own build, always. Otherwise "compare my branch against
master" quietly compares two graders as well as two harnesses, and the result means
nothing. `paths.ts` exists to make that impossible to mix up: `graderRoot()` ignores its
argument entirely (hence the `_cell` parameter name) and `harnessRoot(cell)` returns the
cell's dist.
<!-- verify: {"path": "youcoded/desktop/src/main/harness/eval/paths.ts", "contains": "graderRoot ignores its argument entirely"} -->

Worker config travels over **stdin as one JSON object** — never argv, never environment.
See "The credential" below for why.

## Two `HarnessSession` quirks the runner leans on

**`send()` never rejects on a mid-run provider error.** `HarnessSession` emits a
`'session-error'` transcript event and *resolves* the promise. So the runner detects
provider failure by scanning the event stream, not by catching. That scan must be scoped
per-`send()` call — the wrap-up turn is a second `send()`, and an unscoped scan makes a run
that recovered and produced a report `outcome: 'error'`.
<!-- verify: {"path": "youcoded/desktop/src/main/harness/eval/run-case.ts", "contains": "session-error"} -->

**`tool-use` fires before `decide()`.** The event is emitted when the model *requests* a
tool, not when the call is permitted, so `metrics.toolsUsed` records **attempted** calls.
Two consequences: the fabrication check in `run-facts.ts` compares claims against attempts
(fine — a model that never attempted a tool certainly never used it), and the wrap-up turn
must be excluded from the tally, or a whole turn of denied calls pollutes the exact field
that check treats as ground truth.

Neither has a pinning test. Both are candidates.

## The wrap-up turn

Three triggers, each a **fact** rather than a heuristic: step-budget exhaustion, the wall
clock, and `stopped-early` (the turn ended on its own with no text after the last tool
result). Each sends a second turn carrying `WRAP_UP_PROMPT` with every tool call denied —
including a genuine `AskUserQuestion`, which is `interactive: true` and so bypasses
`decide()`; `askUser` denies it during wrap-up so the prompt's claim holds.

Do not add a fourth trigger that infers distress. One was tried (counting repeated
identical calls) and deleted 2026-08-11 after truncating 13 paid runs, every trip exactly
one over threshold, because the battery's own tasks require repeats.

## Extracting the answer from the transcript

**The answer is the text after the last tool result, not every `assistant-text` delta.**
Deltas stream for the whole run; joining them glues narration onto the answer — Kimi K3's
first appended review was 36% running commentary.

The wrap-up window has one exception: if the tool-result-anchored slice is empty, fall back
to the whole window. That covers the model answering and then making one last (denied)
call, which would otherwise leave the anchor past the answer text.

The order matters and has bitten once. Dropping the anchor for the *whole* wrap-up window
rescues "answer, then attempt one more tool" but breaks "narrate, attempt a tool, then
answer" — the narration comes back as the answer. Anchored slice first, unanchored only as
fallback.
<!-- verify: {"path": "youcoded/desktop/src/main/harness/eval/run-case.ts", "contains": "pickReview"} -->

## The credential

`delete process.env.OPENROUTER_API_KEY` does **not** hide the key from the models being
run. `delete` compiles to `unsetenv`, which edits the in-heap environ array; it never
rewrites the `mm->env_start..env_end` region the kernel exposes at `/proc/<pid>/environ`,
which every same-uid descendant can read — and the Bash tool the model drives is exactly
such a descendant. Measured 2026-08-12: the child's own `env` reads clean (`inherited-env:
0`) while `/proc/$PPID/environ` reads `1`. The obvious probes all pass, which is why it
survived four rounds of review.

`harness-eval.mjs` closes it three ways: it **refuses to start** if `OPENROUTER_API_KEY` is
in its own environment, it reads the key from `--key-file`, and it hands worker config to
the child over stdin with an allowlisted environment. `redactKey()` covers captured stderr.
Guard: `harness-eval-key-leak.test.ts` — note its **negative control**, which must report
LEAKED; a leak detector that cannot fail is not a detector.
<!-- verify: {"path": "youcoded/desktop/test-engine/harness-eval.mjs", "contains": "OPENROUTER_API_KEY"} -->

**`review-harness.mjs` still has the original bug.** It is otherwise superseded — it now
imports its runner logic from `dist/main/harness/eval/`. Retiring it is an open decision
(ROADMAP → Bugs).

## Grading

Two independent halves, and neither may quietly stand in for the other.

`assertions.ts` reads the event stream and returns **three** states per check —
`passed` / `failed` / `never-ran`. A check whose precondition never fired measured nothing;
rendering that as a pass is the failure mode this design exists to prevent. The first
version keyed "never ran" on an empty event list, which is unreachable in production
(`beginTurn` emits `user-message` synchronously), so a provider 402 was scored as a model
failure.

`judge.ts` scores prose against a case's rubric. **Every grade must quote the answer
verbatim**, and a grade whose quote is not literally present is discarded rather than
trusted. Contradiction warnings (a judge praising a tool the transcript never shows) key on
`called-tool:` check ids, not on the judge's free text — an earlier version scanned the
prose and so read "the model never used Edit" as proof that it did.

`JUDGE_SCALE_MAX` is one system-wide constant baked into the judge prompt, score validation
and two report sites. Changing the scale means changing all four together.

## Purity boundaries

`report.ts`, `estimate.ts`, `matrix.ts` and `appendReview` are pure — no filesystem, no
network, no clock. That is what makes "never disturbs another model's review" and "renders
`never ran` differently from `passed`" testable at all; the CLI does all reading and
writing, and passes in the clock. Guard: `harness-review-runner.test.ts` → "leaves every
existing review byte-identical".

Corollary for the CLI: **every exit path that has results must write both the report and
the summary.** An earlier version wrote them only on the paths that returned normally, so
the whole class of failures that rejected out of `runMatrix` left no record of cells that
had already been paid for.

## What the estimate is worth

`estimate.ts` runs before anything is spent and the run is capped by `--max-spend`, which is
re-checked against OpenRouter's own billing between cells. But its token tables were derived
from whole-battery runs (40–63 tool calls) and the prose cases run 9–19, so it currently
reads **~8× high** — measured 2026-08-13: six cells priced at **$12.42**, billed **$1.52**.
Real rate **~$0.25 a cell** including its judge call, against $2.07 a cell estimated.
Input dominates output roughly 44:1, because the whole conversation is resent every step.

Feeding the measured rate back into the tables is an open follow-up.
