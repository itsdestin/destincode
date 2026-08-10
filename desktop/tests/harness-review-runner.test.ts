import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { makeOpenRouterFactory } from '../src/main/harness/review/openrouter-factory';
import { appendReview } from '../src/main/harness/review/append-review';
import { runBattery } from '../src/main/harness/review/run-battery';
import { scriptModel } from './helpers/harness-fakes';

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

const DOC = `# Native Agent Harness Reviews

Intro text.

---

## Review: Existing Model — 2026-08-01

Body of an existing review.

---

## Prompt for other agents

Prompt block here.
`;

describe('appendReview', () => {
  it('inserts the new section above the prompt block, not at the end of the file', () => {
    const out = appendReview(DOC, { label: 'New Model', modelId: 'v/new', review: 'My review.' }, '2026-08-06');
    expect(out.indexOf('## Review: New Model')).toBeLessThan(out.indexOf('## Prompt for other agents'));
  });

  it('leaves every existing review byte-identical', () => {
    const out = appendReview(DOC, { label: 'New Model', modelId: 'v/new', review: 'My review.' }, '2026-08-06');
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

  it('signs the section with the model label and id', () => {
    const out = appendReview(DOC, { label: 'New Model', modelId: 'v/new', review: 'My review.' }, '2026-08-06');
    expect(out).toContain('## Review: New Model — 2026-08-06');
    expect(out).toContain('v/new');
  });

  it('refuses to write an empty review rather than adding a hollow section', () => {
    expect(() => appendReview(DOC, { label: 'X', modelId: 'v/x', review: '   ' }, '2026-08-06')).toThrow(/empty/i);
  });

  it('appends at the end when the doc has no prompt block', () => {
    const out = appendReview('# Doc\n', { label: 'X', modelId: 'v/x', review: 'r' }, '2026-08-06');
    expect(out).toContain('## Review: X — 2026-08-06');
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
      { label: 'New Model', modelId: 'v/new', review: 'My review.' },
      '2026-08-06',
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
});
