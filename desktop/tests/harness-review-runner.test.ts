import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect, vi } from 'vitest';
import { makeOpenRouterFactory } from '../src/main/harness/review/openrouter-factory';
import { appendReview } from '../src/main/harness/review/append-review';
import { runBattery, STEP_GATE_ALLOWANCE, BATTERY_MAX_OUTPUT_TOKENS, BATTERY_STEP_BUDGET, BATTERY_HARNESS } from '../src/main/harness/review/run-battery';
import { collectRunFacts, claimedTools, renderRunFacts, MIN_TOOL_CALLS } from '../src/main/harness/review/run-facts';
import { scriptModel, type ScriptStep } from './helpers/harness-fakes';
import { FRONTIER_STEP_BUDGET } from '../src/main/harness/model-step-budget';

describe('makeOpenRouterFactory', () => {
  it('refuses to build without a key, naming the env var to set', () => {
    expect(() => makeOpenRouterFactory('', 'x/y')).toThrow(/OPENROUTER_API_KEY/);
  });

  it('returns a factory that resolves a model without touching Electron', async () => {
    // The whole point: no app.whenReady(), no safeStorage, no userData. If this
    // ever needs Electron, the runner stops being a plain Node script.
    const factory = makeOpenRouterFactory('sk-test', 'moonshotai/kimi-k3');
    const model = await factory({ providerId: 'openrouter', modelId: 'moonshotai/kimi-k3' });
    expect(model).toBeTruthy();
  });
});

// Regression test for the 2026-08-10 incident: OpenRouter reserves the FULL
// requested max_tokens against the account balance up front, regardless of
// actual usage. Leaving harness-session's maxOutputTokens unset (the
// ASSISTANT_PRESET default) lets the provider fall back to the MODEL's own
// max output — 65,536 for Claude Opus 5 — and the account failed twice with
// "requested up to 65536 tokens, but can only afford 63293" even though
// Opus's last successful battery run used only 8,379 output tokens total.
// runBattery must send an explicit, proportionate ceiling instead of
// inheriting that undefined-maximum behavior. Real HarnessSession.opts.harness
// (ai/test's MockLanguageModelV4 records every doStream call's options in
// doStreamCalls, which is how this proves the SENT value, not an inferred one).
describe('runBattery output ceiling (2026-08-10 incident)', () => {
  it('caps maxOutputTokens instead of leaving it unset (which lets OpenRouter reserve the model max)', async () => {
    const model = scriptModel([{ text: 'Final review.' }]);
    const run = await runBattery({
      modelFactory: async () => model as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 5_000,
    });

    expect(run.review).toBe('Final review.');
    expect(model.doStreamCalls.length).toBeGreaterThan(0);
    for (const call of model.doStreamCalls) {
      expect(call.maxOutputTokens).toBe(BATTERY_MAX_OUTPUT_TOKENS);
    }
    // The measured ceiling must stay well under a model's typical hosted max
    // (65,536 was the number that broke Opus) so the upfront reservation is
    // never absurd relative to real usage.
    expect(BATTERY_MAX_OUTPUT_TOKENS).toBeLessThan(65_536);
  });
});

describe('battery step budget', () => {
  it('sets its own maxSteps instead of inheriting the app chat-tier budget', () => {
    expect(BATTERY_HARNESS.limits?.maxSteps).toBe(BATTERY_STEP_BUDGET);
  });

  it('is uniform — a frontier model gets the same budget as any other', () => {
    // WHY assert this rather than just reading the constant: harness-session.ts:1008
    // is `harness.limits?.maxSteps ?? stepBudgetFor(modelId)`. As long as maxSteps
    // is set, stepBudgetFor never runs, so the 25/50 tier split cannot leak in.
    // If someone later deletes the maxSteps line, this is the test that notices.
    expect(BATTERY_STEP_BUDGET).not.toBe(FRONTIER_STEP_BUDGET);
    expect(BATTERY_HARNESS.limits?.maxSteps).toBe(BATTERY_STEP_BUDGET);
  });

  it('allows exactly one budget continuation before the gate means something', () => {
    expect(STEP_GATE_ALLOWANCE).toBe(1);
  });
});

const DOC = `# Native Agent Harness Reviews

Intro text.

---

## Review: Existing Model — 2026-08-01

Body of an existing review.

---

## Prompt for other agents

Prompt block here.
`;

// Fix (2026-08-10 incident): appendReview used to take a day-granularity
// `dateISO` (e.g. '2026-08-06'). The battery ran three times in one day and
// produced byte-identical-looking headings for the same model — the doc
// couldn't say which review came from which run. The third argument is now a
// full ISO timestamp; tests below use a fixed instant so heading assertions
// stay deterministic.
const RUN_AT = '2026-08-06T09:15:00.000Z';

// Regression fixture for the 2026-08-10 incident: 14 tool calls (13 Read, one
// Glob, one Bash), a review describing Edit/replace_all tests that never
// happened, appended as a genuine review with nothing checking it against the
// transcript. These tests drive run-facts.ts, the module that now does.
const BASE_METRICS = {
  wallClockMs: 230_000, toolCalls: 58, asks: 2, stepGates: 0, thinkingEvents: 232,
  inputTokens: 100_000, outputTokens: 8_379, stopReasons: ['end_turn'],
  toolsUsed: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'], repeats: [],
};
const baseRun = (over: Partial<any> = {}) => ({
  label: 'Fake', modelId: 'fake/model', review: 'A review.', events: [],
  toolCalls: 58, asks: 2, stepGates: 0, fixtureRoot: '/tmp/x',
  outcome: 'complete' as const, metrics: BASE_METRICS, ...over,
});

describe('claimedTools', () => {
  it('finds tool names named in the review', () => {
    expect(claimedTools('I tested Edit and Grep, then Read the file.'))
      .toEqual(['Edit', 'Grep', 'Read']);
  });

  it('matches whole words only, so prose is not mistaken for a tool name', () => {
    // "Reading", "edited", "globbing" must NOT count as Read / Edit / Glob.
    expect(claimedTools('Reading the file, I edited it while globbing.')).toEqual([]);
  });
});

describe('collectRunFacts', () => {
  it('flags a tool the review claims but the transcript never shows', () => {
    // The exact Qwen 3.6 35B A3B shape: 14 calls, none of them Edit, review
    // describing Edit tests in detail.
    const facts = collectRunFacts(baseRun({
      review: 'Edit refused a duplicate string, and replace_all worked as documented.',
      toolCalls: 14,
      metrics: { ...BASE_METRICS, toolCalls: 14, toolsUsed: ['Bash', 'Glob', 'Read'] },
    }));
    expect(facts.unbackedClaims).toEqual(['Edit']);
  });

  it('does not flag a tool the review claims AND the transcript shows', () => {
    const facts = collectRunFacts(baseRun({ review: 'Edit and Read both behaved.' }));
    expect(facts.unbackedClaims).toEqual([]);
  });

  it('flags a run below the tool-call floor', () => {
    // Qwen 3.6 27B made two calls. Whatever follows two calls is not a review
    // of ten tools.
    const facts = collectRunFacts(baseRun({
      toolCalls: 2, metrics: { ...BASE_METRICS, toolCalls: 2, toolsUsed: ['Read'] },
    }));
    expect(facts.belowFloor).toBe(true);
    expect(MIN_TOOL_CALLS).toBe(10);
  });
});

describe('renderRunFacts', () => {
  it('states what the run actually did', () => {
    const out = renderRunFacts(collectRunFacts(baseRun()));
    expect(out).toContain('58 tool calls');
    expect(out).toContain('232 thinking');
    expect(out).toContain('Bash, Edit, Glob, Grep, Read, Write');
  });

  it('leads with a warning blockquote when a claim is unbacked', () => {
    const out = renderRunFacts(collectRunFacts(baseRun({
      review: 'Edit refused a duplicate string.',
      metrics: { ...BASE_METRICS, toolsUsed: ['Read'] },
    })));
    expect(out.startsWith('> ')).toBe(true);
    expect(out).toContain('Edit');
    // Flags, does not judge — the wording must not assert the review is false.
    expect(out.toLowerCase()).not.toContain('fabricat');
  });

  it('has no warning blockquote for a clean run', () => {
    expect(renderRunFacts(collectRunFacts(baseRun())).startsWith('> ')).toBe(false);
  });
});

describe('appendReview', () => {
  it('inserts the new section above the prompt block, not at the end of the file', () => {
    // Subject here is insertion position, not the facts block, so runFacts is
    // left blank per the brief's guidance for these tests.
    const out = appendReview(
      DOC,
      { label: 'New Model', modelId: 'v/new', review: 'My review.', buildSha: 'abc1234', runFacts: '' },
      RUN_AT,
    );
    expect(out.indexOf('## Review: New Model')).toBeLessThan(out.indexOf('## Prompt for other agents'));
  });

  it('leaves every existing review byte-identical', () => {
    const out = appendReview(
      DOC,
      { label: 'New Model', modelId: 'v/new', review: 'My review.', buildSha: 'abc1234', runFacts: '' },
      RUN_AT,
    );
    expect(out).toContain('## Review: Existing Model — 2026-08-01\n\nBody of an existing review.');

    // A substring-presence check only proves that text exists SOMEWHERE in the
    // output — it would still pass if the new section duplicated the existing
    // one, reordered content, or corrupted the intro/separators outside that one
    // substring. Prove byte-identity for real: the output must equal the
    // original document with exactly one contiguous block inserted at exactly
    // one point (right above the prompt heading). Splitting the original at that
    // point and comparing both halves against the corresponding slices of `out`
    // establishes nothing outside the inserted block changed, in either direction.
    const insertAt = DOC.indexOf('## Prompt for other agents');
    expect(out.slice(0, insertAt)).toBe(DOC.slice(0, insertAt));
    expect(out.slice(out.indexOf('## Prompt for other agents'))).toBe(DOC.slice(insertAt));
  });

  it('signs the section with the model label, id, and heading timestamp', () => {
    const out = appendReview(
      DOC,
      { label: 'New Model', modelId: 'v/new', review: 'My review.', buildSha: 'abc1234', runFacts: '' },
      RUN_AT,
    );
    // Minute-precision time is now part of the heading — see the fix comment
    // on `stamp` in append-review.ts for why day-granularity alone caused the
    // 2026-08-10 duplicate-heading incident.
    expect(out).toContain('## Review: New Model — 2026-08-06 09:15');
    expect(out).toContain('v/new');
    // Build identity is verbose (a git SHA), so it lives on the metadata line
    // rather than the heading — still greppable, just not at heading level.
    expect(out).toContain('abc1234');
  });

  it('refuses to write an empty review rather than adding a hollow section', () => {
    expect(() =>
      appendReview(DOC, { label: 'X', modelId: 'v/x', review: '   ', buildSha: 'abc1234', runFacts: '' }, RUN_AT),
    ).toThrow(/empty/i);
  });

  it('appends at the end when the doc has no prompt block', () => {
    const out = appendReview('# Doc\n', { label: 'X', modelId: 'v/x', review: 'r', buildSha: 'abc1234', runFacts: '' }, RUN_AT);
    expect(out).toContain('## Review: X — 2026-08-06 09:15');
  });

  it('two runs of the same model on the same day get distinguishable headings, not identical ones', () => {
    // Root cause reproduction: the battery ran three times in one day and the
    // heading only carried a DATE, so Grok 4.5 / GPT 5.6 Luna / Deepseek v4
    // flash 0731 each produced two byte-identical-looking "## Review: <label>
    // — <date>" headings with nothing distinguishing which run was which.
    // Appending twice for the same model on the same calendar day but at
    // different times (as two real runs on the same day would) must now
    // produce two DIFFERENT headings, checkable via `grep '^## Review:'`
    // without opening either body.
    const firstRunDoc = appendReview(
      DOC,
      { label: 'Grok 4.5', modelId: 'x-ai/grok-4.5', review: 'First run review.', buildSha: 'aaa1111', runFacts: '' },
      '2026-08-10T09:00:00.000Z',
    );
    const bothRunsDoc = appendReview(
      firstRunDoc,
      { label: 'Grok 4.5', modelId: 'x-ai/grok-4.5', review: 'Second run review.', buildSha: 'bbb2222', runFacts: '' },
      '2026-08-10T15:30:00.000Z',
    );

    const headings = [...bothRunsDoc.matchAll(/^## Review: Grok 4\.5 — .+$/gm)].map((m) => m[0]);
    expect(headings).toHaveLength(2);
    expect(headings[0]).not.toBe(headings[1]);
    expect(headings).toContain('## Review: Grok 4.5 — 2026-08-10 09:00');
    expect(headings).toContain('## Review: Grok 4.5 — 2026-08-10 15:30');
  });

  it('inserts at the real heading, not one quoted inside a fenced code block or review prose', () => {
    // The battery is self-referential: every model reviews this harness, so an
    // existing review's body can legitimately contain the literal string
    // "## Prompt for other agents" — inside a code fence quoting the doc's own
    // convention, or in prose discussing it. `indexOf` would match that
    // occurrence FIRST (it appears earlier in the doc) and splice the new
    // section into the middle of that review instead of above the real
    // heading at the end.
    const docWithQuotedHeading = `# Native Agent Harness Reviews

Intro text.

---

## Review: Existing Model — 2026-08-01

This model even quoted the doc's own heading back at me:

\`\`\`
## Prompt for other agents
\`\`\`

which is not the real thing.

---

## Prompt for other agents

Prompt block here.
`;
    const out = appendReview(
      docWithQuotedHeading,
      { label: 'New Model', modelId: 'v/new', review: 'My review.', buildSha: 'abc1234', runFacts: '' },
      RUN_AT,
    );
    // The new section must land above the REAL heading (the last one in the
    // doc), not the quoted one inside the fence (the first occurrence).
    const newSectionIndex = out.indexOf('## Review: New Model');
    const fencedHeadingIndex = out.indexOf('```\n## Prompt for other agents');
    expect(newSectionIndex).toBeGreaterThan(fencedHeadingIndex);
    expect(newSectionIndex).toBeLessThan(out.lastIndexOf('## Prompt for other agents'));
    // Sanity: the quoted heading inside the existing review is untouched and
    // still appears exactly where it did before.
    expect(out).toContain('```\n## Prompt for other agents\n```');
  });

  it('carries the run-facts block under the heading, above the review body', () => {
    const out = appendReview(DOC, {
      label: 'Fake', modelId: 'fake/model', review: 'Body text.',
      buildSha: 'abc123', runFacts: '**Run facts:** complete · 58 tool calls',
    }, RUN_AT);

    const headingAt = out.indexOf('## Review: Fake');
    const factsAt = out.indexOf('**Run facts:**');
    const bodyAt = out.indexOf('Body text.');
    expect(headingAt).toBeLessThan(factsAt);
    expect(factsAt).toBeLessThan(bodyAt);
  });
});

// Destin's ruling (overrides the plan brief): the brief's three runBattery
// tests each had an assertion that could never fail (e.g.
// `expect(run.asks).toBeGreaterThanOrEqual(0)`, true of every possible
// implementation including a broken one). Same test names/intent, but each
// assertion below is wired to something that would actually break if the
// driver regressed.
describe('runBattery', () => {
  it('auto-approves tool use so the battery never blocks on a permission prompt', async () => {
    // Script a REAL tool call (Read of the fixture's own README.md) followed by
    // the model's final text. If decide()/askUser were wired wrong, this call
    // would stall on an unanswered permission ask and the 5s timeout below
    // would fire, failing the test — unlike the brief's vacuous assertion.
    const run = await runBattery({
      modelFactory: async () =>
        scriptModel([
          { toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }] },
          { text: 'The README describes a Fixture Project.' },
        ]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 5_000,
    });

    expect(run.toolCalls).toBe(1);
    const toolResult = run.events.find((e) => e.type === 'tool-result' && e.data.toolName === 'Read');
    expect(toolResult).toBeDefined();
    expect(toolResult!.data.isError).toBeFalsy();
    // Proves the tool actually ran against the real fixture tree, not a stub.
    expect(toolResult!.data.toolResult).toContain('Fixture Project');
    expect(run.review).toBe('The README describes a Fixture Project.');
  });

  it('answers AskUserQuestion deterministically instead of hanging', async () => {
    // No reviewer ever exercised AskUserQuestion (Kimi K3 finding #6) because a
    // human had to answer it. The real proof isn't that the run finished — it's
    // that the fixed answerer picked the FIRST option every time, which is what
    // makes runs reproducible across models. Read the tool-result text the
    // driver's answer actually produced (formatAnswers' "Q: ...\nA: ..." shape)
    // rather than asserting only `asks > 0`.
    const run = await runBattery({
      modelFactory: async () =>
        scriptModel([
          {
            toolCalls: [
              {
                name: 'AskUserQuestion',
                input: {
                  questions: [
                    {
                      question: 'Which color?',
                      header: 'Color',
                      options: [{ label: 'Red' }, { label: 'Blue' }],
                      multiSelect: false,
                    },
                  ],
                },
              },
            ],
          },
          { text: 'Picked a color and moved on.' },
        ]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 5_000,
    });

    expect(run.asks).toBe(1);
    const askResult = run.events.find((e) => e.type === 'tool-result' && e.data.toolName === 'AskUserQuestion');
    expect(askResult).toBeDefined();
    expect(askResult!.data.toolResult).toContain('A: Red');
    expect(askResult!.data.toolResult).not.toContain('A: Blue');
  });

  it('denies a Write outside the fixture instead of rubber-stamping it (Critical fix)', async () => {
    // HarnessSession funnels FOUR ask kinds through the single askUser callback
    // (harness-session.ts:1478 external-path forced ask, :1432 doom_loop,
    // :1100 max_steps, :1449 real AskUserQuestion). A prior version of
    // run-battery's askUser answered all of them with `allow` because its
    // `questions` loop silently ran zero times on anything that wasn't a real
    // AskUserQuestion. That let a scripted Write escape the fixture and write
    // to a real path on the machine running the CLI — this test is the one
    // that would have caught it.
    //
    // The target lives under os.tmpdir() but is NOT inside the fixture root
    // (a separate mkdtemp'd sibling directory), so the assertion "the file was
    // never created" can't be satisfied by accident just because the fixture
    // itself happens to live in tmpdir.
    const outsideDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'yc-harness-review-test-outside-'));
    const outsideFile = path.join(outsideDir, 'pwned.txt');
    try {
      const run = await runBattery({
        modelFactory: async () =>
          scriptModel([
            { toolCalls: [{ name: 'Write', input: { file_path: outsideFile, content: 'pwned' } }] },
            { text: 'Tried to write outside the fixture.' },
          ]) as any,
        modelId: 'fake/model',
        label: 'Fake',
        timeoutMs: 5_000,
      });

      // (a) The write never actually happened on disk.
      expect(fs.existsSync(outsideFile)).toBe(false);

      // The tool call still ran through the loop (doom-loop/decide/guard), it
      // just got a deny result instead of executing — a coherent tool-result
      // the model can read, not a stall or a crash.
      const writeResult = run.events.find((e) => e.type === 'tool-result' && e.data.toolName === 'Write');
      expect(writeResult).toBeDefined();
      expect(writeResult!.data.isError).toBe(true);

      // (b) `asks` counts this: run-battery's askUser increments `asks` for
      // EVERY ask that reaches it, answered or denied, because the field means
      // "how many times something needed a human" — a denied external-path
      // ask is still one of those. See the WHY comment on askUser in
      // run-battery.ts for the reasoning.
      expect(run.asks).toBe(1);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('cleans up the fixture directory when the run finishes, after actually creating it', async () => {
    let seenDuringRun: string[] = [];
    const run = await runBattery({
      modelFactory: async () => {
        // modelFactory only runs mid-send(), strictly after the fixture is
        // seeded — snapshotting os.tmpdir() here proves the directory really
        // existed WHILE the run was in flight. Without this, "gone afterward"
        // would be satisfied equally by a driver that never created it at all.
        seenDuringRun = fs
          .readdirSync(fs.realpathSync(os.tmpdir()))
          .filter((d) => d.startsWith('yc-harness-review-'));
        return scriptModel([{ text: 'All checks passed.' }]) as any;
      },
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 5_000,
    });

    expect(seenDuringRun.some((d) => run.fixtureRoot.endsWith(d))).toBe(true);
    expect(fs.existsSync(run.fixtureRoot)).toBe(false);
    expect(run.review).toBe('All checks passed.');
  });

  it('keeps the fixture directory when keepFixture is true', async () => {
    const run = await runBattery({
      modelFactory: async () => scriptModel([{ text: 'kept' }]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 5_000,
      keepFixture: true,
    });
    try {
      expect(fs.existsSync(run.fixtureRoot)).toBe(true);
    } finally {
      // The option under test leaves the fixture on disk on purpose — clean it
      // up ourselves so the test suite leaves no residue in /tmp.
      fs.rmSync(run.fixtureRoot, { recursive: true, force: true });
    }
  });

  it('returns label, modelId, a trimmed review, and a fixtureRoot inside the OS tmpdir', async () => {
    const run = await runBattery({
      modelFactory: async () => scriptModel([{ text: '  Final review text.  ' }]) as any,
      modelId: 'fake/model-x',
      label: 'Fake X',
      timeoutMs: 5_000,
    });
    expect(run.label).toBe('Fake X');
    expect(run.modelId).toBe('fake/model-x');
    expect(run.review).toBe('Final review text.');
    expect(run.fixtureRoot.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
    expect(run.fixtureRoot).toContain('yc-harness-review-');
  });

  it('review is the FINAL assistant message, not every assistant-text delta in the run (Defect 1)', async () => {
    // The live Kimi K3 run emitted 2,501 assistant-text events across the whole
    // battery — streaming deltas for every turn's narration, not just the last
    // one. The old code joined ALL of them, so the appended review began with
    // run commentary ("I'll start by getting oriented...") glued directly onto
    // the real review with no separator. Script a model that narrates BEFORE a
    // tool call, then writes a distinct final message after — the review must
    // contain only the latter.
    const run = await runBattery({
      modelFactory: async () =>
        scriptModel([
          {
            text: 'Pre-tool narration that must not leak into the review.',
            toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }],
          },
          { text: 'This is the actual final review.' },
        ]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 5_000,
    });

    expect(run.review).toBe('This is the actual final review.');
    expect(run.review).not.toContain('Pre-tool narration');
  });

  it('review is still the whole answer when the model never calls a tool (Defect 1 edge case)', async () => {
    // There is no tool-result to anchor on when a model just answers — every
    // assistant-text event in the run IS the final message, so the "after the
    // last tool-result" rule must not collapse to an empty string here.
    const run = await runBattery({
      modelFactory: async () => scriptModel([{ text: 'No tools needed, here is my review.' }]) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 5_000,
    });

    expect(run.review).toBe('No tools needed, here is my review.');
  });

  it('wires WebSearch to the keyless DDG backend instead of leaving it unconfigured (Defect 2)', async () => {
    // The live run got "Web search is not wired for this session; this is a
    // configuration error" because runBattery never passed toolServices.
    // Stub global fetch with the captured DDG fixture (tests/search-backends.test.ts
    // uses the same file) so this proves real end-to-end wiring — model calls
    // WebSearch, the tool reaches ctx.services.search, the adapter calls the
    // real ddgBackend parser — without making an actual network request.
    const fixtureHtml = fs.readFileSync(path.join(__dirname, 'fixtures', 'search', 'ddg-response.html'), 'utf8');
    const fetchSpy = vi.fn(async () => new Response(fixtureHtml));
    vi.stubGlobal('fetch', fetchSpy);
    try {
      const run = await runBattery({
        modelFactory: async () =>
          scriptModel([
            { toolCalls: [{ name: 'WebSearch', input: { query: 'node lts version' } }] },
            { text: 'Search worked.' },
          ]) as any,
        modelId: 'fake/model',
        label: 'Fake',
        timeoutMs: 5_000,
      });

      const searchResult = run.events.find((e) => e.type === 'tool-result' && e.data.toolName === 'WebSearch');
      expect(searchResult).toBeDefined();
      expect(searchResult!.data.isError).toBeFalsy();
      expect(searchResult!.data.toolResult).not.toContain('not wired');
      expect(searchResult!.data.toolResult).toContain('via ddg');
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // Root cause (2026-08-09 live run): run-battery's askUser used to deny
  // EVERY max_steps ask outright. harness-session.ts:1100-1102 turns a
  // non-'allow' answer to that specific ask into stopReason='max_steps' and
  // ENDS THE TURN — unlike doom_loop, which only fails the one repeated call.
  // A real full-roster run needed 37-80 tool calls per model; 'fake/model'
  // (no frontier-regex match, model-step-budget.ts) gets the 25-step default
  // budget, so driving the gate for real means scripting more than 25
  // consecutive tool-call steps — done here with a generated script rather
  // than typed out by hand. Prefers the real path (per the task brief) over
  // faking the askUser decision directly, since it also proves toolCalls/
  // asks/stepGates all still line up correctly across a real gate crossing.
  // Alternates `offset` so no 3 consecutive calls share an identical signature
  // (harness-session.ts:1424's doom-loop sig is `toolName:JSON.stringify(args)`,
  // threshold 3 for the openrouter/cloud profile — capability-profile.ts). A
  // constant-input Read call WOULD legitimately trip that guard on call 3 and
  // then again on every call after (denial never resets the window, only
  // 'allow' does — harness-session.ts:1438), inflating `asks` with doom_loop
  // hits unrelated to what this test is proving about max_steps.
  function toolCallSteps(count: number): ScriptStep[] {
    return Array.from({ length: count }, (_, i) => ({
      toolCalls: [{ name: 'Read', input: { file_path: 'README.md', offset: (i % 2) + 1 } }],
    }));
  }

  it('survives the max_steps gate up to STEP_GATE_ALLOWANCE and still produces a review', async () => {
    // One full step-budget window per allowed gate hit, THEN a final text step
    // that only runs if every one of those gate hits was actually allowed.
    // Against the pre-fix code (deny everything) this fails at the very first
    // gate — the run ends with stopReason='max_steps' before the text step is
    // ever reached, so `review` comes back empty instead of the real string.
    const steps: ScriptStep[] = [
      ...toolCallSteps(STEP_GATE_ALLOWANCE * BATTERY_STEP_BUDGET),
      { text: 'Final review after surviving every step gate.' },
    ];
    const run = await runBattery({
      modelFactory: async () => scriptModel(steps) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 30_000,
    });

    expect(run.review).toBe('Final review after surviving every step gate.');
    // Proves the run actually crossed the 100-step budget boundary STEP_GATE_ALLOWANCE
    // times, not just once — a run that stalled at the first gate could never
    // reach this many tool calls.
    expect(run.toolCalls).toBe(STEP_GATE_ALLOWANCE * BATTERY_STEP_BUDGET);
    expect(run.stepGates).toBe(STEP_GATE_ALLOWANCE);
    // Design choice (see the WHY comment on run-battery.ts's askUser): a
    // bounded max_steps allowance still counts as an `asks` — it's a real
    // spend/policy decision made on the model's behalf, same as a denied
    // doom_loop or external-path ask. All gate hits here were the ONLY
    // asks in the run (no AskUserQuestion, no external-path Write), so `asks`
    // must equal `stepGates` exactly.
    expect(run.asks).toBe(STEP_GATE_ALLOWANCE);
  });

  it('denies the max_steps gate once STEP_GATE_ALLOWANCE is exhausted, ending the turn', async () => {
    // One MORE window than the allowance — the (STEP_GATE_ALLOWANCE + 1)th
    // gate hit must be denied, which ends the turn (harness-session.ts:1102)
    // before any further text is ever produced. No trailing text step is
    // scripted, because the run must never reach one.
    const steps: ScriptStep[] = toolCallSteps((STEP_GATE_ALLOWANCE + 1) * BATTERY_STEP_BUDGET);
    const run = await runBattery({
      modelFactory: async () => scriptModel(steps) as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 30_000,
    });

    // The genuine-runaway outcome is preserved: a gate hit past the cap still
    // ends the turn with no review, exactly like the pre-fix "deny everything"
    // behavior did for the FIRST hit.
    expect(run.review).toBe('');
    expect(run.toolCalls).toBe((STEP_GATE_ALLOWANCE + 1) * BATTERY_STEP_BUDGET);
    expect(run.stepGates).toBe(STEP_GATE_ALLOWANCE + 1);
    expect(run.asks).toBe(STEP_GATE_ALLOWANCE + 1);
  });
});

describe('runBattery salvage', () => {
  it('returns the run with the real error instead of throwing, when the model errors mid-run', async () => {
    // WHY this matters: round 5 lost four models entirely. runBattery threw, the
    // CLI caught, and no transcript was written - so the failures were not even
    // diagnosable after the fact.
    const model = scriptModel([
      { toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }] },
      { throwError: 'provider exploded' },
    ]);
    const run = await runBattery({
      modelFactory: async () => model as any,
      modelId: 'fake/model',
      label: 'Fake',
      timeoutMs: 30_000,
    });

    expect(run.outcome).toBe('error');
    expect(run.error).toContain('provider exploded');
    // The whole point: the events survive the failure.
    expect(run.events.length).toBeGreaterThan(0);
    expect(run.metrics.toolCalls).toBe(1);
  });

  it('reports no-review when the run finishes with empty final text', async () => {
    const model = scriptModel([{ toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }] }]);
    const run = await runBattery({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: 30_000,
    });
    expect(run.outcome).toBe('no-review');
    expect(run.review).toBe('');
  });

  it('reports complete and records metrics when the model finishes normally', async () => {
    const model = scriptModel([
      { toolCalls: [{ name: 'Glob', input: { pattern: '**/*' } }] },
      { toolCalls: [{ name: 'Read', input: { file_path: 'README.md' } }] },
      { text: 'The review.' },
    ]);
    const run = await runBattery({
      modelFactory: async () => model as any,
      modelId: 'fake/model', label: 'Fake', timeoutMs: 30_000,
    });

    expect(run.outcome).toBe('complete');
    expect(run.review).toBe('The review.');
    expect(run.metrics.toolCalls).toBe(2);
    expect(run.metrics.toolsUsed).toEqual(['Glob', 'Read']);   // distinct, sorted
    expect(run.metrics.stopReasons).toContain('end_turn');
    expect(run.metrics.wallClockMs).toBeGreaterThan(0);
    expect(run.metrics.outputTokens).toBeGreaterThan(0);
  });
});
