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
      // Auto-approve everything the configured layers would ask about. The
      // TOOL-LAYER guards (secret paths, external_directory) sit BELOW this and
      // still apply, so the fixture jail holds even on a fully permissive decide.
      // Plan correction: this field IS spelled `action` (PermissionDecision,
      // shared/permission-types.ts:17-22) — unlike askUser below, which is not.
      decide: async () => ({ action: 'allow', denyListed: false }),
      // Deterministic answerer: always take the first option. WHY this matters —
      // AskUserQuestion was the one tool no reviewer reached (Kimi K3 finding
      // #6), because a human had to be present to answer it. A fixed answer
      // makes it reachable and keeps runs reproducible.
      //
      // Plan correction: the brief read `req?.input?.questions` and returned
      // `{ action: 'allow', ... }`. Neither matches the real AskRequest/
      // AskDecision shapes (permission-broker.ts:14-30): the request's parsed
      // tool input rides under `toolInput`, not `input`, and the decision's
      // approve/deny field is `behavior`, not `action` — decide() above uses
      // `action` and askUser uses `behavior`; that asymmetry is real, not a typo.
      askUser: async (req: AskRequest): Promise<AskDecision> => {
        asks++;
        const questions = (req.toolInput?.questions as
          | Array<{ question: string; options?: { label: string }[] }>
          | undefined) ?? [];
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
