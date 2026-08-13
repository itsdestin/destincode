// The judge (Task 10) — everything here is driven by a FAKE judge model.
// No network, no key, no spend: a MockLanguageModelV4 whose doGenerate returns
// a canned string is the entire "provider" for this suite.
//
// The load-bearing test in this file is the quote enforcement group. The whole
// design rests on "a grade without a verbatim quote is discarded", so those
// tests carry a positive control (a real quote survives) — without it, a
// judgeRun that returned `grades: []` unconditionally would pass every drop
// test and prove nothing.
import { describe, it, expect } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import {
  judgeRun, MIN_QUOTE_CHARS, JUDGE_SCALE_MAX,
  type Grade, type JudgeResult,
} from '../src/main/harness/eval/judge';
import type { CaseRun, CheckResult, RubricItem } from '../src/main/harness/eval/case-types';
import type { TranscriptEvent } from '../src/shared/types';

// --- fixtures ---------------------------------------------------------------

// The run's written answer. Every "real quote" below is copied out of THIS
// string, so a reader can check the tests the same way the tool asks Destin to
// check a grade.
const ANSWER = [
  'I read the config loader before changing anything, because the failure only',
  'shows up when two loaders race.',
  '',
  'The trade-off is between a lock and a retry: a lock is simpler to reason about',
  'but serializes every startup, while a retry keeps startup parallel and pays for',
  'it with a worst case nobody can bound.',
  '',
  'I went with the lock, and I would revisit that if startup time became the',
  'complaint people actually had.',
].join('\n');

function toolUse(name: string, input: Record<string, unknown>): TranscriptEvent {
  return { type: 'tool-use', sessionId: 's', uuid: `u${Math.random()}`, timestamp: 0, data: { toolName: name, toolInput: input } };
}

function makeRun(over: Partial<CaseRun> = {}): CaseRun {
  return {
    label: 'test', modelId: 'vendor/model-under-test', review: ANSWER,
    events: [toolUse('Read', { file_path: 'config.ts' }), toolUse('Grep', { pattern: 'loadConfig' })],
    toolCalls: 2, asks: 0, stepGates: 0, fixtureRoot: '/tmp/fixture', outcome: 'complete',
    metrics: {
      wallClockMs: 1000, toolCalls: 2, asks: 0, stepGates: 0, thinkingEvents: 0,
      inputTokens: 10, outputTokens: 10, stopReasons: ['stop'], toolsUsed: ['Grep', 'Read'], repeats: [],
    },
    ...over,
  };
}

const RUBRIC: RubricItem[] = [
  { id: 'tradeoffs', ask: 'Does the answer lay out the trade-offs?' },
  { id: 'searched', ask: 'Did it look at the code before answering?' },
];

// --- the fake judge model ---------------------------------------------------

const USAGE = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

/** A judge whose single generate call returns `payload` — an object/array is
 *  JSON-encoded, a string is returned raw (that is how the malformed-JSON and
 *  empty-answer cases are driven). `seen` collects the prompts it was sent. */
function fakeJudge(payload: unknown, modelId = 'vendor/judge-model', seen?: any[]) {
  return {
    modelId,
    factory: async () => new MockLanguageModelV4({
      doGenerate: async (req: any) => {
        seen?.push(req.prompt);
        return {
          content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload) }],
          finishReason: { unified: 'stop' as const, raw: 'stop' }, usage: USAGE, warnings: [],
        };
      },
    }) as any,
  };
}

/** A judge whose factory rejects — the "provider is down / 402" path. */
function throwingJudge(err: unknown = new Error('OpenRouter 402: insufficient credits')) {
  return { modelId: 'vendor/judge-model', factory: async () => { throw err; } };
}

const g = (over: Partial<Grade> & Record<string, unknown> = {}) =>
  ({ id: 'tradeoffs', score: 4, quote: 'The trade-off is between a lock and a retry', ...over });

// --- quote enforcement (the load-bearing group) ------------------------------

describe('judgeRun quote enforcement', () => {
  // POSITIVE CONTROL. If this ever fails, the drop tests below stop meaning
  // anything, because "returns nothing, always" would satisfy all of them.
  it('keeps a grade whose quote is verbatim in the answer', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g()]), []);
    expect(r.unavailable).toBeUndefined();
    expect(r.grades).toHaveLength(1);
    expect(r.grades[0]).toMatchObject({ id: 'tradeoffs', score: 4 });
    expect(ANSWER).toContain(r.grades[0].quote);
  });

  it('drops a grade that carries no quote', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: '' })]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/quote/i);
  });

  it('drops a grade whose quote is not in the answer', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: 'it never said any of this at all' })]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/not found|verbatim/i);
  });

  it('drops a paraphrase that only shares words with the answer', async () => {
    // Same vocabulary, different sentence: the check is substring, not overlap.
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: 'a retry is between the trade-off and a lock' })]), []);
    expect(r.grades).toHaveLength(0);
  });

  it('drops a quote too short to be checkable', async () => {
    const short = 'a lock'; // < MIN_QUOTE_CHARS, and genuinely present in the answer
    expect(short.length).toBeLessThan(MIN_QUOTE_CHARS);
    expect(ANSWER).toContain(short);
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: short })]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/short/i);
  });

  it('accepts a quote reflowed across the answer’s line break and with smart quotes', async () => {
    // The answer wraps mid-sentence; a model re-quoting it collapses the newline
    // to a space and often "smartens" the apostrophes. Neither is a fabrication.
    const reflowed = 'I read the config loader before changing anything, because the failure only shows up';
    expect(ANSWER).not.toContain(reflowed);   // proves the raw string really is reflowed
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ quote: reflowed })]), []);
    expect(r.grades).toHaveLength(1);
    // The stored quote is the SOURCE substring, so Ctrl-F in the answer finds it.
    expect(ANSWER).toContain(r.grades[0].quote);
  });

  it('accepts an elided quote only when both halves appear, in order', async () => {
    const ok = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      g({ quote: 'The trade-off is between a lock and a retry ... serializes every startup' }),
    ]), []);
    expect(ok.grades).toHaveLength(1);

    // Same two halves, reversed: the answer never says them in this order.
    const backwards = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      g({ quote: 'serializes every startup ... The trade-off is between a lock and a retry' }),
    ]), []);
    expect(backwards.grades).toHaveLength(0);
  });

  it('drops a grade for a rubric item that does not exist', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g({ id: 'invented-item' })]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/invented-item/);
  });

  it('drops a grade whose score is not a number in range', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      g({ id: 'tradeoffs', score: 'excellent' }),
      g({ id: 'searched', score: JUDGE_SCALE_MAX + 3, quote: 'I read the config loader before changing anything' }),
    ]), []);
    expect(r.grades).toHaveLength(0);
    expect(r.warnings.join()).toMatch(/score/i);
  });

  it('warns about a rubric item the judge skipped', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([g()]), []);
    expect(r.warnings.join()).toMatch(/searched/);
  });
});

// --- contradicting a mechanical check ---------------------------------------

describe('judgeRun vs the mechanical checks', () => {
  const passedGrep: CheckResult[] = [{ id: 'calledTool:Grep', state: 'passed', detail: 'Grep' }];

  it('warns when the judge contradicts a passing check instead of averaging it in', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 0, quote: '...', reason: 'It never searched the code.' },
    ]), passedGrep);
    expect(r.warnings.join()).toMatch(/contradict/i);
    expect(r.warnings.join()).toMatch(/calledTool:Grep/);
  });

  it('leaves the score alone when it warns', async () => {
    // A contradicted grade that IS quoted still keeps its score verbatim — the
    // warning is printed next to it, never blended into it.
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 0, quote: 'I read the config loader before changing anything', reason: 'It never ran Grep.' },
    ]), passedGrep);
    expect(r.grades).toEqual([expect.objectContaining({ id: 'searched', score: 0 })]);
    expect(r.warnings.join()).toMatch(/contradict/i);
  });

  it('does not warn when no check backs the denial', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 0, quote: 'I read the config loader before changing anything', reason: 'It never searched the code.' },
    ]), [{ id: 'calledTool:Grep', state: 'failed', detail: 'Grep' }]);
    expect(r.warnings.join()).not.toMatch(/contradict/i);
  });

  it('does not warn on a positive statement that merely names a tool', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge([
      { id: 'searched', score: 5, quote: 'I read the config loader before changing anything', reason: 'It ran Grep before answering.' },
    ]), passedGrep);
    expect(r.warnings.join()).not.toMatch(/contradict/i);
  });

  it('does not read the run’s own words as a judge claim', async () => {
    // The quote is the RUN talking, not the judge. A run that honestly says it
    // never searched must not be scored as the JUDGE contradicting a check.
    const run = makeRun({ review: `${ANSWER}\n\nI never searched the code, I answered from memory.` });
    const r = await judgeRun(run, RUBRIC, fakeJudge([
      { id: 'searched', score: 1, quote: 'I never searched the code, I answered from memory.' },
    ]), passedGrep);
    expect(r.grades).toHaveLength(1);
    expect(r.warnings.join()).not.toMatch(/contradict/i);
  });
});

// --- failure handling: grading must never cost a paid run its results --------

describe('judgeRun failure handling', () => {
  const expectNoGrades = (r: JudgeResult) => {
    expect(r.grades).toEqual([]);
    expect(r.unavailable).toBeTruthy();
  };

  it('a broken judge never costs the run its other results', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, throwingJudge(), []);
    expectNoGrades(r);
  });

  it('carries the provider’s real message, not a guess', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, throwingJudge(new Error('OpenRouter 402: insufficient credits')), []);
    expect(r.unavailable).toContain('OpenRouter 402: insufficient credits');
  });

  it('never renders a non-Error rejection as [object Object]', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, throwingJudge({ error: { code: 402, message: 'Insufficient credits' } }), []);
    expect(r.unavailable).not.toContain('[object Object]');
    expect(r.unavailable).toContain('Insufficient credits');
  });

  it('survives malformed JSON and says what came back', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge('Sure! Here are my grades: tradeoffs = great'), []);
    expectNoGrades(r);
    expect(r.unavailable).toMatch(/JSON/i);
    expect(r.unavailable).toContain('Sure! Here are my grades');
  });

  it('survives an empty answer', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge(''), []);
    expectNoGrades(r);
    expect(r.unavailable).toMatch(/no text|empty/i);
  });

  it('survives valid JSON of the wrong shape', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, fakeJudge({ verdict: 'good' }), []);
    expectNoGrades(r);
  });

  it('reads grades out of a {grades:[...]} wrapper and a fenced block', async () => {
    const wrapped = await judgeRun(makeRun(), RUBRIC, fakeJudge({ grades: [g()] }), []);
    expect(wrapped.grades).toHaveLength(1);
    const fenced = await judgeRun(makeRun(), RUBRIC, fakeJudge('```json\n' + JSON.stringify([g()]) + '\n```'), []);
    expect(fenced.grades).toHaveLength(1);
  });

  it('is a clean no-op when there is no judge', async () => {
    const r = await judgeRun(makeRun(), RUBRIC, null, []);
    expect(r).toEqual({ grades: [], warnings: [] });
  });

  it('is a clean no-op when the case has no rubric', async () => {
    const r = await judgeRun(makeRun(), [], fakeJudge([g()]), []);
    expect(r).toEqual({ grades: [], warnings: [] });
  });
});

// --- self-grading ------------------------------------------------------------

describe('judgeRun self-grading', () => {
  it('flags self-grading when the judge is also under test', async () => {
    const r = await judgeRun(
      makeRun({ modelId: 'anthropic/claude-opus-5' }), RUBRIC,
      fakeJudge([g()], 'anthropic/claude-opus-5'), [],
    );
    expect(r.warnings.join()).toMatch(/self-grad/i);
  });

  it('flags it without discarding the grades', async () => {
    const r = await judgeRun(
      makeRun({ modelId: 'anthropic/claude-opus-5' }), RUBRIC,
      fakeJudge([g()], 'anthropic/claude-opus-5'), [],
    );
    expect(r.grades).toHaveLength(1);
  });

  it('does not flag a different judge model', async () => {
    const r = await judgeRun(makeRun({ modelId: 'anthropic/claude-opus-5' }), RUBRIC, fakeJudge([g()]), []);
    expect(r.warnings.join()).not.toMatch(/self-grad/i);
  });
});

// --- what the judge is actually shown ---------------------------------------

describe('the judge prompt', () => {
  const promptText = (seen: any[]) => JSON.stringify(seen);

  it('shows the answer, the rubric asks, and the tool calls', async () => {
    const seen: any[] = [];
    await judgeRun(makeRun(), RUBRIC, fakeJudge([g()], 'vendor/judge-model', seen), []);
    const p = promptText(seen);
    expect(p).toContain('Does the answer lay out the trade-offs?');
    expect(p).toContain('I went with the lock');
    expect(p).toContain('Grep');
  });

  it('does not tell the judge which model wrote the answer', async () => {
    const seen: any[] = [];
    await judgeRun(makeRun({ modelId: 'anthropic/claude-opus-5' }), RUBRIC, fakeJudge([g()], 'vendor/judge-model', seen), []);
    expect(promptText(seen)).not.toContain('claude-opus-5');
  });
});
