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
// WHY 4, not unbounded or 1: the gate exists to catch a genuinely stuck
// model, and an unbounded allow would defeat that (the exact failure mode
// the gate was added to prevent). 4 continuations gives a frontier model
// (50-step budget) up to 5 * 50 = 250 steps and a default model (25-step
// budget) up to 5 * 25 = 125 steps before the run is cut off — several times
// the worst observed real number (80 tool calls; steps can be fewer than
// tool calls since one step may carry several parallel calls, per the task
// brief) — while still guaranteeing termination well inside `timeoutMs`
// (default 900_000ms, still the hard wall-clock ceiling underneath all of
// this: it races the ENTIRE session.send() call, so no number of granted
// continuations can defeat it — confirmed by reading run-battery's
// Promise.race below, unchanged by this fix).
export const STEP_GATE_ALLOWANCE = 4;

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

  const session = new HarnessSession(
    {
      sessionId: `review-${Date.now()}`,
      cwd: fixtureRoot,
      harness: ASSISTANT_PRESET,
      binding: { providerId: 'openrouter', modelId: opts.modelId },
      tools: CORE_TOOLS,
      // Auto-approve everything decide() is consulted about. WHY this does NOT
      // by itself hold the fixture jail: the tool-layer path guard
      // (harness-session.ts checkPathGuard, called from runOneTool step 3) sits
      // BELOW decide and, for any path-subject tool (Read/Write/Edit) pointed
      // outside the session cwd, forces `{ action: 'ask' }` BEFORE decide() is
      // even called (harness-session.ts:1469-1471 — `externalAsk ? {action:'ask'} :
      // decide()`). So decide() being fully permissive is irrelevant to those
      // calls; askUser below is what actually has to hold the line.
      // Plan correction: this field IS spelled `action` (PermissionDecision,
      // shared/permission-types.ts:17-22) — unlike askUser below, which is not.
      decide: async () => ({ action: 'allow', denyListed: false }),
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
          // Bounded allowance (see STEP_GATE_ALLOWANCE's WHY comment above
          // the function for the value and its justification). Past the cap,
          // deny — the turn ends exactly as it does today, which is the
          // correct outcome for a genuine runaway.
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
    if (e.type === 'tool-use') toolCalls++;
  });

  const timeoutMs = opts.timeoutMs ?? 900_000;
  // Deviation from the brief: capture the timer handle and clearTimeout it in
  // the finally block below. The brief only `.unref()`s it, which keeps the
  // PROCESS from hanging but still leaves the timer armed for up to
  // `timeoutMs` after a normal (non-timeout) finish — harmless in the real CLI
  // but a needless dangling timer across every fast test in this file.
  let timer!: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Battery timed out after ${timeoutMs}ms`)), timeoutMs);
    timer.unref();
  });

  try {
    await Promise.race([session.send(BATTERY_PROMPT), timeout]);
  } finally {
    clearTimeout(timer);
    // Cleanup runs on the failure path too — a rejected send() (provider error,
    // or the timeout above) still tears down the session and fixture; the real
    // error propagates unchanged once this finally block completes.
    session.destroy();
    if (!opts.keepFixture) fs.rmSync(fixtureRoot, { recursive: true, force: true });
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
  const lastToolResultIndex = events.reduce(
    (last, e, i) => (e.type === 'tool-result' ? i : last),
    -1,
  );
  const review = events
    .filter((e, i) => e.type === 'assistant-text' && i > lastToolResultIndex)
    .map((e) => e.data.text ?? '')
    .join('')
    .trim();

  return { label: opts.label, modelId: opts.modelId, review, events, toolCalls, asks, stepGates, fixtureRoot };
}
