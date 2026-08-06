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

export interface BatteryRun {
  label: string;
  modelId: string;
  review: string;
  events: TranscriptEvent[];
  toolCalls: number;
  asks: number;
  fixtureRoot: string;
}

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

export async function runBattery(opts: RunBatteryOpts): Promise<BatteryRun> {
  const fixtureRoot = seedFixtureWorkspace();
  const events: TranscriptEvent[] = [];
  let toolCalls = 0;
  let asks = 0;

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
      // WHY every OTHER ask kind is denied, not allowed: HarnessSession routes
      // three unrelated ask kinds through this SAME callback, and none of them
      // carry a `questions` field —
      //   - harness-session.ts:1478 — the forced 'ask' described above (Write/
      //     Read/Edit pointed outside the fixture root, e.g. Write("/home/x")).
      //     Allowing this unconditionally is a real local-file write/read
      //     against the machine running the CLI, not the fixture — the exact
      //     hole a Critical finding caught (the fixture jail did not hold).
      //   - harness-session.ts:1432 — the doom_loop guard's ask.
      //   - harness-session.ts:1100 — the max_steps guard's ask.
      // A prior version of this callback answered ALL of these with `allow`
      // (its `questions` loop ran zero times on the ones above, then fell
      // through to an unconditional allow) — silently disabling both spend
      // guards and letting Write/Read escape the fixture. Denying instead is
      // not just safer, it is CORRECT: a properly scoped battery run should
      // never produce an external-directory ask, a doom loop, or a max-steps
      // overrun, so a denial turns a regression into a loud error result in
      // the transcript (harness-session.ts:1481 turns a non-allow into a
      // model-facing error string — the model still gets a coherent reply,
      // the run isn't aborted) instead of quietly executing outside the
      // fixture or burning OpenRouter spend on a stuck model.
      // NOT `{ behavior: 'canceled' }`: harness-session.ts:1479 treats
      // 'canceled' as a user interrupt that aborts the whole turn — this is a
      // policy denial, not an abort.
      // `asks` counts every ask that reaches this callback, answered or
      // denied — it is "how many times something needed a human," which is
      // exactly what a denied doom-loop/max-steps/external-path ask still is.
      askUser: async (req: AskRequest): Promise<AskDecision> => {
        asks++;
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

  // The review is the model's final assistant text. `data.text` is already
  // typed `string | undefined` (shared/types.ts) — the brief's `(e.data as
  // any)?.text` cast was unnecessary.
  const review = events
    .filter((e) => e.type === 'assistant-text')
    .map((e) => e.data.text ?? '')
    .join('')
    .trim();

  return { label: opts.label, modelId: opts.modelId, review, events, toolCalls, asks, fixtureRoot };
}
