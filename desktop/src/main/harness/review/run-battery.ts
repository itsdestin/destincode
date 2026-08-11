// Drive one model through the battery inside a disposable fixture.
//
// WHY no Electron: HarnessSession takes an injected modelFactory, decide, and
// askUser, so the whole loop runs in plain Node. That keeps the runner clear of
// the live app entirely — no userData, no ~/.youcoded writes, no safeStorage.
import * as fs from 'fs';
import { HarnessSession, type ModelFactory } from '../harness-session';
import { ASSISTANT_PRESET } from '../../../shared/harness-manifest';
import { CORE_TOOLS } from '../tools';
import { seedFixtureWorkspace } from './fixture-workspace';
import { BATTERY_PROMPT } from './battery';
import type { TranscriptEvent } from '../../../shared/types';
import type { AskRequest, AskDecision } from '../permission-broker';
import type { SkillCatalog } from '../skills/skill-catalog';
import type { ToolServices } from '../tools/types';
import { ddgBackend } from '../search/backends/ddg';

export type BatteryOutcome = 'complete' | 'wrapped-up' | 'no-review' | 'error';

export interface BatteryMetrics {
  wallClockMs: number;
  toolCalls: number;
  asks: number;
  stepGates: number;
  /** COUNT of assistant-thinking events, not a token figure — StepUsage
   *  (harness-session.ts:109) has no reasoning field. Still the number that
   *  makes a provider-side reasoning shift visible: the same model on the same
   *  commit went 232 -> 1,691 between two runs 4.5 hours apart on 2026-08-10,
   *  and nothing in the old output showed it. */
  thinkingEvents: number;
  inputTokens: number;
  outputTokens: number;
  /** One per turn-complete, in order. A budget-triggered wrap-up has two (the
   *  testing turn's 'max_steps', then the wrap-up turn's own finish reason);
   *  a timeout-triggered one usually has one, since interrupt() ends the
   *  testing turn via 'user-interrupt' (no turn-complete), not a finish. */
  stopReasons: string[];
  /** Distinct tool names actually invoked, sorted. The evidence a review's
   *  claims are checked against (run-facts.ts). */
  toolsUsed: string[];
  /** (toolName, input) pairs seen more than REPEAT_LIMIT times — the evidence
   *  behind a 'restart' wrapUpReason. [] when no call recurred past the limit. */
  repeats: { key: string; count: number }[];
}

export interface BatteryRun {
  label: string;
  modelId: string;
  review: string;
  events: TranscriptEvent[];
  toolCalls: number;
  asks: number;
  // How many times the max_steps budget gate fired (allowed or denied). See
  // STEP_GATE_ALLOWANCE below for what "allowed" means. A gated run's review
  // is still worth reading, but a reviewer interpreting it should know the
  // model needed extra room — this was invisible until the run either
  // finished quietly or failed outright (the Opus 5 incident this field
  // exists to surface).
  stepGates: number;
  fixtureRoot: string;
  /** How the run ended. 'complete' — the testing turn finished on its own with
   *  a non-empty review. 'wrapped-up' — the step budget or the wall clock cut
   *  the testing turn short and a second, tools-denied turn produced the
   *  review instead (see wrapUpReason). 'no-review' — finished with empty
   *  final text. 'error' — the provider or session threw; see `error`. */
  outcome: BatteryOutcome;
  /** Which trigger sent the run to a wrap-up turn, if any. Undefined means the
   *  testing turn ended on its own. 'budget' and 'timeout' fire on the testing
   *  turn's own outcome (max_steps exhaustion, wall clock); 'restart' fires the
   *  moment a (toolName, input) pair recurs past REPEAT_LIMIT, non-consecutively
   *  — see REPEAT_LIMIT's WHY comment below for the 2026-08-10 incident it
   *  catches that doom_loop cannot. */
  wrapUpReason?: 'budget' | 'restart' | 'timeout';
  /** The REAL error message, never a substitute (error-message-standards.md). */
  error?: string;
  metrics: BatteryMetrics;
}

// Root-cause fix (2026-08-09): the first full-roster live run denied EVERY
// max_steps gate outright, on the reasoning (stated in a prior version of
// this file, and in the plan brief that requested that denial) that the
// ~40-item battery would stay "well under 25 steps." That prediction was
// empirically wrong. Real full-roster numbers: Kimi K3 56 tool calls,
// Deepseek v4 flash 0731 47, Grok 4.5 37, GPT 5.6 Luna 47 — all finished
// fine — and Claude Opus 5 80 tool calls, which hit its 50-step frontier
// budget (model-step-budget.ts), got denied at the FIRST gate, and lost its
// entire review after a paid run produced nothing (harness-session.ts:1100-
// 1102: a non-'allow' answer sets stopReason='max_steps' and breaks the turn
// loop outright — unlike doom_loop, which only fails the one repeated call
// and lets the run continue). Opus was simply the most thorough model, not a
// runaway one.
//
// WHY 1, not 4: the allowance used to compensate for a budget (25/50, chosen by
// model tier) that was far too small for a battery, so gates fired as a matter
// of routine and the allowance was really just a multiplier. BATTERY_STEP_BUDGET
// below sets 100 directly, above every healthy run ever measured (round 4: Kimi
// K3 56 tool calls, Deepseek 47, Grok 37, GPT 47, Opus 80), so reaching the gate
// at all is now real signal. One continuation is grace for an unusually thorough
// run; past that the testing turn ends and a wrap-up turn (below) asks for the
// review instead of losing it outright, which is what cost Opus 5 its entire
// review on 2026-08-09.
// Ceiling math: 2 windows * 100 = 200 steps, then a final wrap-up turn.
export const STEP_GATE_ALLOWANCE = 1;

// Sent as a SECOND turn on the same session when the testing phase is cut short.
// WHY a second turn and not a bigger budget: the failure is not "the model needed
// more room", it is "the model never got asked for the deliverable". Round 5's
// Qwen 3.5 122B (127 calls) and Qwen 3.8 Max (157 calls) both ended on max_steps
// with no final text — paid runs that produced nothing readable. Reusing the same
// session keeps the model's whole history, so it reviews what it actually did.
export const WRAP_UP_PROMPT =
  'Your testing budget is spent. Do not run any more tools — any tool call you ' +
  'make now will be denied. Write your review of the harness now, covering ' +
  'whatever you managed to test.';

// The wrap-up turn's own ceiling. Much smaller than the testing phase: it is one
// message, and a model that cannot produce it in two minutes is not going to.
export const WRAP_UP_TIMEOUT_MS = 120_000;

// How many byte-identical (toolName, input) pairs a run may issue before it is
// treated as having restarted the battery rather than making progress.
//
// WHY this is not doom_loop's job: doom_loop (harness-session.ts:1432) fires on
// CONSECUTIVE repeats, which catches a stuck tool. This catches the other shape
// — Qwen 3.8 Max issued `Glob **/*` fourteen times spread across 157 calls on
// 2026-08-10, restarting the battery each time its context compacted. Nothing
// was stuck; the run was just never going to finish.
//
// WHY 5: re-reading one file twice while testing (say, checking Read's freshness
// guard) is legitimate. Six byte-identical calls is not a re-check.
export const REPEAT_LIMIT = 5;

// Default wall-clock ceiling for the TESTING phase. Raised from 900_000 because
// at the 8.6s/step measured on 2026-08-10, 900s buys ~105 steps — which made the
// deadline, not BATTERY_STEP_BUDGET, the binding constraint. Now that a blown
// deadline triggers a wrap-up turn instead of killing the run, the raise costs
// little and leaves real testing room before wrap-up.
export const BATTERY_TIMEOUT_MS = 1_200_000;

// Fix (2026-08-10 incident): HarnessSession passes `harness.limits?.maxTokens`
// straight through to streamText's `maxOutputTokens` (harness-session.ts) with
// NO fallback when it's unset — and ASSISTANT_PRESET (the shared preset every
// real app session also uses) leaves `limits` undefined. With no explicit
// ceiling, the OpenRouter request omits `max_tokens` entirely, and OpenRouter
// falls back to reserving the MODEL's own advertised max output against the
// account balance up front — 65,536 for Claude Opus 5. That is not "out of
// credits": the account failed twice with "You requested up to 65536 tokens,
// but can only afford 63293" while Opus's last SUCCESSFUL battery run used
// only 8,379 output tokens in total, across the entire run. Real per-run
// totals measured from live transcripts (turn-complete's data.usage.output-
// Tokens, which HarnessSession accumulates across every step of the whole
// run — see harness-session.ts's turnUsage): Opus 8,379 (prior successful
// run), Qwen 3.8 Max 11,766, Deepseek v4 Flash 0731 9,530, GPT 5.6 Luna
// 4,098, Grok 4.5 3,662 — and even each run's own final free-form review
// message (the longest single step) never exceeded ~2,200 estimated tokens.
// 32,000 is chosen as a ceiling with real headroom above every measured
// number (≈2.7x the highest observed whole-run total) while staying under
// half of the 65,536 that broke Opus, so the upfront reservation is no
// longer wildly disproportionate to real spend.
//
// WHY here, not on ASSISTANT_PRESET: ASSISTANT_PRESET is shared configuration
// used by every real app session (see harness-manifest.ts), so raising or
// lowering it globally would change Destin's live app behavior — out of
// scope for a battery-runner defect. This constant, and the harness object
// below that layers it onto a COPY of ASSISTANT_PRESET, are runBattery-only;
// they never touch the shared preset object or its live-app consumers.
export const BATTERY_MAX_OUTPUT_TOKENS = 32_000;

// The battery's own step ceiling, replacing the per-model tier split in
// model-step-budget.ts (25 default / 50 frontier). WHY uniform: that split is
// tuned for interactive chat, where a long tool chain usually means the model
// is lost. The battery is the same size of job — walk ten tools through seven
// areas — whichever model runs it, so tiering it just means the cheap models
// get cut off mid-review. 100 is above every healthy run measured to date.
//
// WHY it works: harness-session.ts:1008 resolves the budget as
// `this.opts.harness.limits?.maxSteps ?? stepBudgetFor(this.binding.modelId)`,
// so setting maxSteps on BATTERY_HARNESS below is sufficient — stepBudgetFor
// is never consulted. Same layering already used for BATTERY_MAX_OUTPUT_TOKENS,
// and equally confined to the runner's own copy of ASSISTANT_PRESET.
export const BATTERY_STEP_BUDGET = 100;

// A battery-only harness: same shape as ASSISTANT_PRESET (tools, permission
// posture, prompt) but with explicit output and step ceilings layered on top via a
// fresh object — ASSISTANT_PRESET itself is a shared module-level const, so
// mutating it in place would leak the override into every other consumer
// (real app sessions included). Spreading `limits` too, not just replacing
// it, keeps this forward-compatible if ASSISTANT_PRESET ever gains a
// maxSteps override of its own.
export const BATTERY_HARNESS = {
  ...ASSISTANT_PRESET,
  limits: {
    ...ASSISTANT_PRESET.limits,
    maxTokens: BATTERY_MAX_OUTPUT_TOKENS,
    maxSteps: BATTERY_STEP_BUDGET,
  },
};

export interface RunBatteryOpts {
  modelFactory: ModelFactory;
  modelId: string;
  label: string;
  /** Wall-clock ceiling for one model's whole battery. */
  timeoutMs?: number;
  /** Keep the fixture on disk for debugging. Default false. */
  keepFixture?: boolean;
}

// No skills, no path-triggered rule injection: the fixture has neither, and
// injecting the real machine's skills would make runs machine-dependent (the
// same reasoning tests/helpers/harness-fakes.ts documents for
// EMPTY_SKILL_CATALOG — a review that reached ~/.claude would not be a review
// of the ten CORE_TOOLS, it would be a review of whoever's machine ran it).
// SkillCatalog.list() is synchronous (skill-catalog.ts) — the brief's
// `{ list: async () => [] }` returns a Promise where a plain array is
// expected, which happened to type-check only because of its `as any` cast.
const EMPTY_SKILL_CATALOG: SkillCatalog = {
  list: () => [],
  load: (id: string) => {
    throw new Error(`no skills installed (review fixture): ${id}`);
  },
};

// Defect 2 fix: runBattery previously never passed `toolServices` at all, so
// WebSearchTool's `if (!ctx.services?.search)` guard always tripped and every
// live run reported "Web search is not wired for this session" — a false
// finding, not a real harness limitation, and it left battery area 6 (Web)
// permanently untestable.
//
// WHY the keyless DDG backend and not the full SearchService
// (search-service.ts): SearchService wants a chain resolver + a key store,
// neither of which this disposable Node-only fixture has any business
// touching (constructing one would mean reading the app's saved
// provider keys — exactly the live-app boundary this runner exists to stay
// outside of, per the file's top-of-file WHY comment). The runner's only
// credential is OPENROUTER_API_KEY, so the backend must need none — ddg is
// the one entry in the chain (search/backends/) that qualifies. `ToolServices`
// (tools/types.ts) is structural, so a minimal adapter satisfying
// `search(query, signal): Promise<{results, source}>` is enough; ddgBackend's
// real signature is `search(query, { key, signal, fetchImpl? })` returning
// `SearchResult[]` directly, so the adapter is a plain shape translation, not
// a workaround — `key: null` because ddg needs none, `fetchImpl` left
// undefined so it falls through to ddgBackend's own default (the real global
// `fetch`) in production, and is the one seam tests inject to avoid a live
// DuckDuckGo request.
//
// Errors are NOT caught here. A DDG failure (rate-limit, network, markup
// drift — see ddg.ts) throws SearchBackendError, which is not a
// SearchUnavailableError, so WebSearchTool's own catch re-throws it and
// defineTool's outer catch (registry.ts) turns it into
// "WebSearch failed: <ddg's real message>" — DDG's own honest failure text,
// never a guessed-at substitute (error-message-standards.md).
export function makeReviewSearchServices(fetchImpl?: typeof fetch): ToolServices {
  return {
    search: {
      async search(query: string, signal: AbortSignal) {
        const results = await ddgBackend.search(query, { key: null, signal, fetchImpl });
        return { results, source: ddgBackend.id };
      },
    },
  };
}

export async function runBattery(opts: RunBatteryOpts): Promise<BatteryRun> {
  const fixtureRoot = seedFixtureWorkspace();
  const events: TranscriptEvent[] = [];
  let toolCalls = 0;
  let asks = 0;
  let stepGates = 0;
  // Salvage metrics (round 5 fix): collected alongside the existing counters
  // above so a run that errors or times out still has something to write —
  // see the try/catch below and the outcome/metrics on the return value.
  const startedAt = Date.now();
  let thinkingEvents = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  const stopReasons: string[] = [];
  const toolsUsed = new Set<string>();

  // Set for the duration of the wrap-up turn (declared above the
  // HarnessSession so both decide() and askUser below can close over it).
  // While true, every tool call is denied and every max_steps gate is
  // denied, so the model cannot resume testing — it answers in prose or not
  // at all. WHY a second turn instead of a bigger budget: see WRAP_UP_PROMPT's
  // WHY comment above.
  let wrappingUp = false;
  let wrapUpReason: BatteryRun['wrapUpReason'];
  // Keyed on tool name + exact input. Non-consecutive by design — see REPEAT_LIMIT.
  const repeatCounts = new Map<string, number>();

  const session = new HarnessSession(
    {
      sessionId: `review-${Date.now()}`,
      cwd: fixtureRoot,
      harness: BATTERY_HARNESS,
      binding: { providerId: 'openrouter', modelId: opts.modelId },
      tools: CORE_TOOLS,
      // Auto-approve everything decide() is consulted about — EXCEPT during the
      // wrap-up turn, where every tool call is refused so the model must answer.
      // NOTE: PermissionDecision (shared/permission-types.ts:17) carries only
      // `action` and `denyListed` — there is no message field, so the model sees
      // the generic tool-denial result. WRAP_UP_PROMPT is what explains why.
      // (The fixture jail does NOT rest on this — see askUser below.) WHY this
      // does NOT by itself hold the fixture jail: the tool-layer path guard
      // (harness-session.ts checkPathGuard, called from runOneTool step 3) sits
      // BELOW decide and, for any path-subject tool (Read/Write/Edit) pointed
      // outside the session cwd, forces `{ action: 'ask' }` BEFORE decide() is
      // even called (harness-session.ts:1469-1471 — `externalAsk ? {action:'ask'} :
      // decide()`). So decide() being fully permissive (outside wrap-up) is
      // irrelevant to those calls; askUser below is what actually has to hold
      // the line.
      // Plan correction: this field IS spelled `action` (PermissionDecision,
      // shared/permission-types.ts:17-22) — unlike askUser below, which is not.
      decide: async () => ({ action: wrappingUp ? 'deny' : 'allow', denyListed: false }),
      // Deterministic answerer for the ONE ask kind this fixture is meant to
      // reach: a genuine AskUserQuestion tool call. WHY that matters —
      // AskUserQuestion was the one tool no reviewer reached (Kimi K3 finding
      // #6), because a human had to be present to answer it. A fixed answer
      // makes it reachable and keeps runs reproducible.
      //
      // WHY every OTHER ask kind is denied — with ONE bounded exception below —
      // and not allowed: HarnessSession routes three unrelated ask kinds
      // through this SAME callback, and none of them carry a `questions`
      // field —
      //   - harness-session.ts:1478 — the forced 'ask' described above (Write/
      //     Read/Edit pointed outside the fixture root, e.g. Write("/home/x")).
      //     Allowing this unconditionally is a real local-file write/read
      //     against the machine running the CLI, not the fixture — the exact
      //     hole a Critical finding caught (the fixture jail did not hold).
      //     Still ALWAYS denied. Unchanged by this fix. Has its own test.
      //   - harness-session.ts:1432 — the doom_loop guard's ask. Still ALWAYS
      //     denied: harness-session.ts:1437 turns a non-allow into a
      //     model-facing error result for just the one repeated call, and the
      //     run continues — denying here is harmless and correct.
      //   - harness-session.ts:1100 — the max_steps guard's ask. See
      //     STEP_GATE_ALLOWANCE above the function: unlike doom_loop, a
      //     non-'allow' answer here ends the WHOLE turn (stopReason=
      //     'max_steps', harness-session.ts:1102), which is what cost a paid
      //     Opus 5 run its entire review on 2026-08-09. Now bounded-allowed
      //     instead of always-denied.
      // A prior version of this callback answered ALL of these with `allow`
      // (its `questions` loop ran zero times on the ones above, then fell
      // through to an unconditional allow) — silently disabling both spend
      // guards and letting Write/Read escape the fixture. Denying
      // external-directory and doom_loop is not just safer, it is CORRECT: a
      // properly scoped battery run should never produce an external-
      // directory ask or a doom loop, so a denial turns a regression into a
      // loud error result in the transcript instead of quietly executing
      // outside the fixture or spinning on a stuck model. max_steps is
      // different — a long battery legitimately NEEDS more than one budget
      // window — hence the bounded allowance instead of an outright deny.
      // NOT `{ behavior: 'canceled' }` for any of these: harness-session.ts:
      // 1479 treats 'canceled' as a user interrupt that aborts the whole
      // turn — these are policy decisions, not aborts.
      // `asks` counts every ask that reaches this callback, answered or
      // denied — it is "how many times something needed a human," which is
      // exactly what a denied doom-loop/external-path ask, OR an
      // auto-allowed max-steps continuation, still is: a real spend/policy
      // decision was made on the model's behalf, just not by a human this
      // time. `stepGates` (below) is the narrower, max_steps-only count the
      // CLI surfaces per-model — `asks` alone can't tell a reviewer "this
      // model needed extra room" from "this model asked a real question."
      askUser: async (req: AskRequest): Promise<AskDecision> => {
        asks++;
        if (req.toolName === 'max_steps') {
          stepGates++;
          // During wrap-up there is no more testing to fund: deny outright.
          if (wrappingUp) return { behavior: 'deny' };
          // Bounded allowance (see STEP_GATE_ALLOWANCE's WHY comment above
          // the function for the value and its justification). Past the cap,
          // deny — the turn ends with stopReason 'max_steps', which is what
          // sends the run to the wrap-up turn below instead of losing the
          // review outright (the correct outcome for a genuine runaway).
          return stepGates <= STEP_GATE_ALLOWANCE
            ? { behavior: 'allow' }
            : { behavior: 'deny' };
        }
        const questions = req.toolName === 'AskUserQuestion'
          ? (req.toolInput?.questions as
              | Array<{ question: string; options?: { label: string }[] }>
              | undefined)
          : undefined;
        if (!Array.isArray(questions)) return { behavior: 'deny' };
        const answers: Record<string, string> = {};
        for (const q of questions) answers[q.question] = q.options?.[0]?.label ?? 'yes';
        return { behavior: 'allow', updatedInput: { questions, answers } };
      },
      skillCatalog: EMPTY_SKILL_CATALOG,
      // Defect 2 fix: without this, WebSearchTool's execute() always hits its
      // `!ctx.services?.search` guard (harness-session.ts:1498 only spreads
      // `services` when `toolServices` is set) — see makeReviewSearchServices'
      // WHY comment above for the rest of the reasoning.
      toolServices: makeReviewSearchServices(),
      // triggers absent → no path-triggered injection, same as every other
      // pre-M3 caller (HarnessSessionOpts.triggers doc comment).
    },
    opts.modelFactory,
  );

  session.on('transcript-event', (e: TranscriptEvent) => {
    events.push(e);
    // Fix pass 1, Finding 2: HarnessSession emits 'tool-use' for a step BEFORE
    // execution and BEFORE decide() is consulted, so a call denied during
    // wrap-up would otherwise still land here. That matters because
    // BatteryMetrics.toolsUsed is documented as "the evidence a review's
    // claims are checked against" (run-facts.ts consumes it that way — it
    // flags a review that names a tool absent from toolsUsed) — a denied
    // wrap-up attempt injecting a tool name into toolsUsed would silently
    // defeat that check for real. A wrap-up turn is a WHOLE turn of denied
    // calls, so exclude it entirely rather than leaving the leak incidental;
    // toolCalls is gated the same way so the two stay paired. (The same leak
    // exists, unfixed, for calls denied during the TESTING turn — e.g. a
    // Write pointed outside the fixture — pre-existing and out of scope here.)
    if (e.type === 'tool-use' && !wrappingUp) {
      toolCalls++;
      // toolName is the field name on TranscriptEvent.data (shared/types.ts:148),
      // not `name` — the tool-use payload mirrors CC's transcript shape.
      if (e.data.toolName) toolsUsed.add(e.data.toolName);
      // Restart detection (2026-08-10 incident): keyed on tool name + exact
      // input so it catches the SAME call recurring anywhere in the run, not
      // just back-to-back — doom_loop (harness-session.ts:1432) already owns
      // the consecutive case. Lives inside this same `!wrappingUp` guard so a
      // denied wrap-up-turn call (which still emits tool-use) never counts
      // toward the threshold or toward metrics.repeats.
      const key = `${e.data.toolName ?? '?'} ${JSON.stringify(e.data.toolInput ?? {})}`;
      const seen = (repeatCounts.get(key) ?? 0) + 1;
      repeatCounts.set(key, seen);
      // Trip once, on the crossing. `wrapUpReason` guards against re-interrupting
      // a run that another trigger (budget/timeout) already sent to wrap-up.
      if (seen > REPEAT_LIMIT && !wrapUpReason) {
        wrapUpReason = 'restart';
        session.interrupt();
      }
    }
    if (e.type === 'assistant-thinking') thinkingEvents++;
    if (e.type === 'turn-complete') {
      if (e.data.stopReason) stopReasons.push(e.data.stopReason);
      inputTokens += e.data.usage?.inputTokens ?? 0;
      outputTokens += e.data.usage?.outputTokens ?? 0;
    }
  });

  // Fix pass 1, Finding 3: the whole post-setup body is now one try/finally so
  // teardown (session.destroy() + fixture rmSync, at the bottom) is guaranteed
  // again — it used to be two bare statements after the wrap-up block, and
  // every path between the testing turn and those lines happened to be total,
  // but nothing enforced that. A future throw anywhere in this stretch (e.g.
  // in the review extraction) would otherwise leak a tmpdir fixture and a
  // live session holding an abort controller and listeners. Nothing inside
  // changes: the review extraction and the return value still see exactly
  // what they saw before — `finally` runs after the return expression is
  // built but before the function actually returns to the caller.
  try {
    const timeoutMs = opts.timeoutMs ?? BATTERY_TIMEOUT_MS;
    // Deviation from the brief's variable name only: `error` (not `err`) is the
    // outer binding read by the outcome/return logic below; the caught value is
    // still carried through as-is, never replaced with a guessed cause.
    let error: string | undefined;

    // The deadline INTERRUPTS rather than rejecting. interrupt()
    // (harness-session.ts:1598) ends the in-flight turn cleanly and lets send()
    // resolve with everything gathered — the old Promise.race abandoned a live
    // promise and discarded the whole run, which is how round 5 lost four
    // models. `.unref()` keeps the process from hanging on this timer; it fires
    // at most once (the testing turn either finishes and clears it below, or
    // this callback runs and there is nothing left to clear it early).
    const deadline = setTimeout(() => {
      wrapUpReason ??= 'timeout';
      session.interrupt();
    }, timeoutMs);
    deadline.unref();

    // WHY: captured immediately before send() so the session-error scan below
    // can be scoped to THIS turn only. The wrap-up turn below is a second
    // send() on this same session, which appends more events to this same
    // array — an unscoped scan would find a 'session-error' left over from a
    // failed first turn and mislabel a wrap-up turn that actually succeeded
    // (or vice versa).
    const eventsBeforeSend = events.length;
    try {
      await session.send(BATTERY_PROMPT);
    } catch (err) {
      // Salvage, don't discard. A provider error still leaves a transcript
      // worth writing — round 5 threw four of them away and left the failures
      // undiagnosable. The REAL message is carried through, never a guess.
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(deadline);
    }

    // Deviation from the brief's snippet, found by running its own test: a
    // provider error that survives HarnessSession's internal retries does NOT
    // reject send() at all — beginTurn's own catch (harness-session.ts:1176-1188)
    // swallows it and emits a 'session-error' transcript event instead, then
    // returns normally. So the try/catch above only ever fires for a genuinely
    // thrown error; a mid-run model error would otherwise fall through as a
    // false 'no-review' with the real failure silently dropped, defeating the
    // whole point of this task. Checked only when send() itself didn't already
    // report an error, so a genuine throw keeps its own message.
    if (!error) {
      // WHY: scan only the events THIS send() produced (events.slice, not the
      // full array) — see eventsBeforeSend's WHY comment above.
      const sessionError = events
        .slice(eventsBeforeSend)
        .find((e) => e.type === 'session-error');
      // Defensive fallback: `data.text` is typed as possibly undefined. If a
      // 'session-error' event is ever emitted without text, fall back to a
      // factual placeholder rather than silently losing the error (which would
      // mislabel the run 'complete' or 'no-review' despite a real failure).
      // The fallback states only that a message was missing — it does not
      // guess at why the error occurred.
      if (sessionError) error = sessionError.data.text ?? 'session error (no message provided)';
    }

    // A denied budget gate ends the turn with stopReason 'max_steps'
    // (harness-session.ts:1102). WHY read the stopReason rather than set a flag
    // in askUser: at the callback a denied gate and a turn that was about to
    // finish anyway are indistinguishable — the stopReason is the only place
    // the difference is recorded. `!wrapUpReason` guards against overwriting a
    // 'timeout' the deadline callback above already set; `!error` skips this
    // when the turn threw instead of finishing (an error takes priority — see
    // the outcome expression below).
    if (!wrapUpReason && !error && stopReasons.at(-1) === 'max_steps') wrapUpReason = 'budget';

    // Everything the testing turn emitted. The wrap-up review is sliced from
    // here onward so trailing narration from the interrupted turn cannot leak
    // into it (see lastToolResultIndex's WHY comment below).
    let sliceFrom = 0;

    if (wrapUpReason) {
      wrappingUp = true;
      sliceFrom = events.length;
      // Own marker + own deadline, same reasoning as the testing turn's above:
      // this is a SECOND send() on the same session, appending to the same
      // `events` array, so its error scan must stay scoped to just this turn.
      const wrapEventsBeforeSend = events.length;
      const wrapDeadline = setTimeout(() => session.interrupt(), WRAP_UP_TIMEOUT_MS);
      wrapDeadline.unref();
      try {
        await session.send(WRAP_UP_PROMPT);
      } catch (err) {
        // A failed wrap-up is not fatal: the testing transcript is still worth
        // writing, and outcome stays 'wrapped-up' with an empty review.
        error ??= err instanceof Error ? err.message : String(err);
      } finally {
        clearTimeout(wrapDeadline);
      }
      // Same non-rejecting-send() gap as the testing turn: a wrap-up-turn
      // model error surfaces as a 'session-error' event, not a thrown
      // exception. Scoped to wrapEventsBeforeSend, not eventsBeforeSend, so a
      // testing-turn error that already resolved above is never re-attributed
      // to a wrap-up turn that actually succeeded.
      if (!error) {
        const wrapSessionError = events
          .slice(wrapEventsBeforeSend)
          .find((e) => e.type === 'session-error');
        if (wrapSessionError) error = wrapSessionError.data.text ?? 'session error (no message provided)';
      }
    }

    // Defect 1 fix: `assistant-text` events are streaming DELTAS emitted
    // throughout the WHOLE run, not one-per-message — the old comment here
    // ("the model's final assistant text") was simply false about what the code
    // below it did. It joined EVERY assistant-text event, so a live run's
    // turn-by-turn narration ("I'll start by getting oriented...", "Now let me
    // try...") got glued onto the front of the actual review with no separator
    // (confirmed on the Kimi K3 run: 2,501 assistant-text events, 36% of the
    // joined text was pre-review commentary).
    //
    // The model's real final message is whatever assistant-text it emits AFTER
    // its last tool call finishes — verified against that same transcript:
    // taking only the text after the last tool-result event yields exactly the
    // review's true start ("I ran the full battery...") through its true end,
    // nothing more. `data.text` is already typed `string | undefined`
    // (shared/types.ts) — the brief's `(e.data as any)?.text` cast was
    // unnecessary.
    //
    // Edge case: a model that answers without ever calling a tool has no
    // tool-result to anchor on. `lastToolResultIndex` is then -1, and `i > -1`
    // is true for every index, so the filter falls back to "every assistant-text
    // event" — which in a no-tool-call run IS the whole (and only) message.
    //
    // Only the wrap-up turn's events when one ran (sliceFrom > 0); the whole
    // run otherwise.
    const reviewWindow = events.slice(sliceFrom);
    // Fix pass 1, Finding 1: the "after the last tool result" anchor exists to
    // strip narration BETWEEN REAL tool calls — but inside the wrap-up window
    // no tool call is ever real (decide() denies every one above), so there is
    // no such narration to strip, and the anchor becomes a way to LOSE the
    // deliverable instead: a model that writes its review and then attempts
    // one more (denied) tool call pushes a tool-result to a later index than
    // the review text, and the old unconditional anchor discarded it. That is
    // exactly the tool-happy failure population wrap-up exists to rescue (127
    // and 157 calls in the round-5 incident). So in the wrap-up window
    // (sliceFrom > 0) join every assistant-text event regardless of position;
    // the single-turn window (sliceFrom === 0) keeps the real anchor, which is
    // still correct there and is pinned by the "takes only the wrap-up turn
    // text, not narration from the interrupted turn" test above.
    const lastToolResultIndex = sliceFrom > 0 ? -1 : reviewWindow.reduce(
      (last, e, i) => (e.type === 'tool-result' ? i : last),
      -1,
    );
    const review = reviewWindow
      .filter((e, i) => e.type === 'assistant-text' && i > lastToolResultIndex)
      .map((e) => e.data.text ?? '')
      .join('')
      .trim();

    // wrapUpReason takes priority: a wrap-up turn that itself errors still
    // reports 'wrapped-up' (with an empty review, per the brief's WHY comment
    // above the wrap-up try/catch) — the run was cut short and asked for its
    // review, which is the fact a caller most needs to see, over the
    // secondary fact that the wrap-up attempt also failed. Otherwise an error
    // takes priority over a review the model may have partially produced
    // before failing.
    const outcome: BatteryOutcome =
      wrapUpReason ? 'wrapped-up'
      : error ? 'error'
      : review ? 'complete'
      : 'no-review';

    return {
      label: opts.label, modelId: opts.modelId, review, events,
      toolCalls, asks, stepGates, fixtureRoot,
      outcome, wrapUpReason, error,
      metrics: {
        wallClockMs: Date.now() - startedAt,
        toolCalls, asks, stepGates, thinkingEvents, inputTokens, outputTokens,
        stopReasons,
        toolsUsed: [...toolsUsed].sort(),
        // Only calls that actually crossed REPEAT_LIMIT — a run with zero
        // restart-shaped repeats reports [], not every key ever seen once.
        repeats: [...repeatCounts.entries()]
          .filter(([, count]) => count > REPEAT_LIMIT)
          .map(([key, count]) => ({ key, count }))
          .sort((a, b) => b.count - a.count),
      },
    };
  } finally {
    // Guaranteed teardown (Finding 3). Runs after the wrap-up turn (if any) has
    // already completed above — destroying the session or removing the fixture
    // any earlier would make the wrap-up turn's own send() fail outright (no
    // session left to send on, no cwd left for its tools).
    session.destroy();
    if (!opts.keepFixture) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
}
