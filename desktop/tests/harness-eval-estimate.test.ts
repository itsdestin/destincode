import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  estimateCells,
  parsePriceCatalog,
  formatUsd,
  judgeCostLines,
  MEASURED_OUTPUT_TOKENS,
  MEASURED_INPUT_TOKENS,
  MEASURED_CASE_TOKENS,
  FALLBACK_INPUT_TOKENS,
  FALLBACK_OUTPUT_TOKENS,
  TRUNCATED_SAMPLES,
  type Price,
} from '../src/main/harness/eval/estimate';

const DESKTOP = path.resolve(__dirname, '..');

/** A cell in the shape `estimateCells` actually consumes — `id`, `caseId`, and
 *  `model`, the fields matrix.ts's Cell really has. (The plan sketch called the
 *  first one `cellId`; that is the OUTPUT field name, and using it as an input
 *  would have silently priced a row whose id was `undefined`.) `caseId`
 *  defaults to a case with no entry in MEASURED_CASE_TOKENS, so every existing
 *  test that doesn't care about the case tier keeps exercising the battery/
 *  fallback tiers exactly as before. */
const cell = (id: string, model: string, caseId = 'generic-unmeasured-case') => ({ id, caseId, model });

describe('estimateCells', () => {
  const M1: Price = { inputPerM: 1, outputPerM: 10 };

  it('multiplies measured tokens by price and totals the matrix', () => {
    const cells = [cell('c1', 'Grok 4.5'), cell('c2', 'Grok 4.5')];
    const out = estimateCells(cells, { 'Grok 4.5': M1 });
    expect(out.perCell).toHaveLength(2);
    expect(out.totalUsd).toBeCloseTo((out.perCell[0].usd as number) * 2, 10);
    // The arithmetic, spelled out, so a future refactor that swaps input and
    // output prices fails here instead of quietly halving the estimate.
    const expected =
      (MEASURED_INPUT_TOKENS['Grok 4.5'] / 1e6) * 1
      + (MEASURED_OUTPUT_TOKENS['Grok 4.5'] / 1e6) * 10;
    expect(out.perCell[0].usd).toBeCloseTo(expected, 12);
  });

  it('reports unpriced models instead of silently costing them zero', () => {
    const out = estimateCells([cell('c1', 'MYSTERY')], {});
    expect(out.unpriced).toEqual(['MYSTERY']);
    // The two halves that make this a real guarantee rather than a label:
    // the cell is not priced at zero, and the total does not pretend to cover it.
    expect(out.perCell[0].usd).toBeNull();
    expect(out.totalUsd).toBe(0);
  });

  it('does not let an unpriced cell disappear into a priced total', () => {
    const out = estimateCells([cell('c1', 'Grok 4.5'), cell('c2', 'MYSTERY')], { 'Grok 4.5': M1 });
    expect(out.unpriced).toEqual(['MYSTERY']);
    expect(out.totalUsd).toBeCloseTo(out.perCell[0].usd as number, 12);
    expect(out.perCell[1].usd).toBeNull();
  });

  it('treats a price of 0 as a real answer, not as a missing entry', () => {
    // OpenRouter genuinely lists free models. "Is there an entry" and "is the
    // number truthy" are different questions, and conflating them would report
    // a free model as unpriced — a false alarm that trains people to ignore the
    // list that exists to stop them overspending.
    const out = estimateCells([cell('c1', 'Grok 4.5')], { 'Grok 4.5': { inputPerM: 0, outputPerM: 0 } });
    expect(out.unpriced).toEqual([]);
    expect(out.perCell[0].usd).toBe(0);
  });

  it('names a model with no measured token count and prices it conservatively', () => {
    const out = estimateCells([cell('c1', 'MYSTERY')], { MYSTERY: M1 });
    expect(out.unmeasured).toEqual(['MYSTERY']);
    const expected = (FALLBACK_INPUT_TOKENS / 1e6) * 1 + (FALLBACK_OUTPUT_TOKENS / 1e6) * 10;
    expect(out.perCell[0].usd).toBeCloseTo(expected, 12);
    // Conservative means the fallback is the WORST measured row, not an average
    // — an estimate that reads low is the one that costs money nobody agreed to.
    expect(FALLBACK_INPUT_TOKENS).toBe(Math.max(...Object.values(MEASURED_INPUT_TOKENS)));
    expect(FALLBACK_OUTPUT_TOKENS).toBe(Math.max(...Object.values(MEASURED_OUTPUT_TOKENS)));
  });

  it('does not list a measured model as unmeasured', () => {
    const out = estimateCells([cell('c1', 'Claude Opus 5')], { 'Claude Opus 5': M1 });
    expect(out.unmeasured).toEqual([]);
  });

  it('deduplicates and sorts both problem lists', () => {
    const dupes = [cell('c1', 'ZED'), cell('c2', 'ABE'), cell('c3', 'ZED')];
    expect(estimateCells(dupes, {}).unpriced).toEqual(['ABE', 'ZED']);
    // Priced, so the models reach the `unmeasured` branch at all — see the next
    // test for why an unpriced model is deliberately NOT also listed there.
    expect(estimateCells(dupes, { ZED: M1, ABE: M1 }).unmeasured).toEqual(['ABE', 'ZED']);
  });

  it('does not report an unpriced model as ALSO unmeasured — the two lists contradict', () => {
    // Fix pass 1 (2026-08-12 review, MINOR): a model that is both unpriced and
    // unmeasured used to appear in both lists, and the CLI prints prose under
    // each: "priced from the worst measured run, so those rows read HIGH" and
    // "no price for these — NOT in the total above". Only the second is true of
    // such a row; it was never priced from anything. `unmeasured` now means
    // "priced, but from an assumption".
    const out = estimateCells([cell('c1', 'MYSTERY')], {});
    expect(out.unpriced).toEqual(['MYSTERY']);
    expect(out.unmeasured).toEqual([]);
    expect(out.perCell[0].usd).toBeNull();
  });

  it('refuses a mis-shaped cell rather than pricing a row called undefined', () => {
    expect(() => estimateCells([{ model: 'Grok 4.5' } as never], {})).toThrow(/needs a non-empty string "id"/);
    expect(() => estimateCells([{ id: 'c1', caseId: 'x' } as never], {})).toThrow(/cell "c1" has no "model"/);
    // caseId is the new field (2026-08-13): a cell missing it would silently key
    // into MEASURED_CASE_TOKENS[undefined], which is just `undefined` — a quiet
    // fall-through to the battery tier rather than a loud error.
    expect(() => estimateCells([{ id: 'c1', model: 'Grok 4.5' } as never], {})).toThrow(/cell "c1" has no "caseId"/);
  });

  it('is empty-safe', () => {
    expect(estimateCells([], {})).toEqual({ perCell: [], totalUsd: 0, unpriced: [], unmeasured: [], batteryPriced: [] });
  });
});

// --- the case-token tier: the fix for the 8x-high estimate (2026-08-13) -----

describe('estimateCells, MEASURED_CASE_TOKENS tier', () => {
  const M1: Price = { inputPerM: 1, outputPerM: 10 };

  it('prices a cell whose case+model IS in the table from it, not from the battery table', () => {
    // The discriminating assertion: if the lookup order were ever flipped (or a
    // dead branch left the battery table reachable first), this would still pass
    // as long as SOME number came out — so it must compare against what the
    // WRONG number would have been and prove they differ.
    const sample = MEASURED_CASE_TOKENS['config-investigation']['Claude Opus 5'];
    const out = estimateCells([cell('c1', 'Claude Opus 5', 'config-investigation')], { 'Claude Opus 5': M1 });
    const fromCaseTable = (sample.inputTokens / 1e6) * 1 + (sample.outputTokens / 1e6) * 10;
    const fromBatteryTable =
      (MEASURED_INPUT_TOKENS['Claude Opus 5'] / 1e6) * 1 + (MEASURED_OUTPUT_TOKENS['Claude Opus 5'] / 1e6) * 10;
    expect(out.perCell[0].usd).toBeCloseTo(fromCaseTable, 12);
    expect(out.perCell[0].usd).not.toBeCloseTo(fromBatteryTable, 2);
    // Priced from an exact measurement of this task — neither caveat list fires.
    expect(out.unmeasured).toEqual([]);
    expect(out.batteryPriced).toEqual([]);
  });

  it('falls through to the battery table, and is REPORTED as battery-priced, when the case is known but the model is not', () => {
    // 'config-investigation' is in MEASURED_CASE_TOKENS; 'Grok 4.5' is not one of
    // its two measured models. That must fall to tier 2 (the battery table), NOT
    // tier 3 (the fallback) — Grok 4.5 has its own battery measurement.
    expect(MEASURED_CASE_TOKENS['config-investigation']['Grok 4.5']).toBeUndefined();
    const out = estimateCells([cell('c1', 'Grok 4.5', 'config-investigation')], { 'Grok 4.5': M1 });
    const expected = (MEASURED_INPUT_TOKENS['Grok 4.5'] / 1e6) * 1 + (MEASURED_OUTPUT_TOKENS['Grok 4.5'] / 1e6) * 10;
    expect(out.perCell[0].usd).toBeCloseTo(expected, 12);
    expect(out.batteryPriced).toEqual(['config-investigation / Grok 4.5']);
    // Battery-priced is a DIFFERENT claim than "no measurement at all" — a model
    // with its own battery row is not "unmeasured", it is measured for the wrong task.
    expect(out.unmeasured).toEqual([]);
  });

  it('falls through correctly, and is reported, for a case with no entry in the table at all', () => {
    expect(MEASURED_CASE_TOKENS['totally-unknown-case']).toBeUndefined();
    const out = estimateCells([cell('c1', 'Grok 4.5', 'totally-unknown-case')], { 'Grok 4.5': M1 });
    const expected = (MEASURED_INPUT_TOKENS['Grok 4.5'] / 1e6) * 1 + (MEASURED_OUTPUT_TOKENS['Grok 4.5'] / 1e6) * 10;
    expect(out.perCell[0].usd).toBeCloseTo(expected, 12);
    expect(out.batteryPriced).toEqual(['totally-unknown-case / Grok 4.5']);
  });

  it('does NOT flag the harness-battery case as battery-priced — the battery table IS a measurement of it', () => {
    // harness-battery has no entry in MEASURED_CASE_TOKENS (it does not need
    // one: the whole-battery tables already measure exactly this case), so it
    // falls to tier 2 like any other unlisted case. The one thing that must NOT
    // happen is `batteryPriced` calling that an over-estimate — it isn't one.
    expect(MEASURED_CASE_TOKENS['harness-battery']).toBeUndefined();
    const out = estimateCells([cell('c1', 'Claude Opus 5', 'harness-battery')], { 'Claude Opus 5': M1 });
    const expected =
      (MEASURED_INPUT_TOKENS['Claude Opus 5'] / 1e6) * 1 + (MEASURED_OUTPUT_TOKENS['Claude Opus 5'] / 1e6) * 10;
    expect(out.perCell[0].usd).toBeCloseTo(expected, 12);
    expect(out.batteryPriced).toEqual([]);
    expect(out.unmeasured).toEqual([]);
  });

  it('takes the MAX of the samples per the doctrine, not the mean recorded in the comment', () => {
    // Qwen 3.8 Max / config-investigation is the case with the widest recorded
    // spread: max 342,207 input against a mean of 189,087 on the same case. If
    // this table were ever accidentally filled with means instead of maxes, this
    // is the row that would catch it.
    const sample = MEASURED_CASE_TOKENS['config-investigation']['Qwen 3.8 Max'];
    expect(sample.inputTokens).toBe(342_207);
    expect(sample.inputTokens).toBeGreaterThan(189_087); // the mean — max must exceed it
  });
});

describe('the measured token tables', () => {
  it('accounts for every label in the shipped roster — measured, or explicitly truncated', () => {
    // WHY read the real roster file: the tables are keyed by roster LABEL, and a
    // label typo ("Deepseek v4 Flash 0731" vs the roster's lowercase "flash")
    // silently degrades that model to the conservative fallback instead of
    // erroring. Nothing else would catch it.
    //
    // Fix pass 1 (2026-08-12 review, IMPORTANT 1): a label may now be accounted
    // for in TRUNCATED_SAMPLES instead of in the tables. That is NOT a loosening
    // — a new or renamed roster label still appears in none of the three and
    // still fails here; the only thing allowed is a label whose exclusion was
    // written down on purpose.
    const roster = JSON.parse(
      fs.readFileSync(path.join(DESKTOP, 'test-engine/review-roster.json'), 'utf8'),
    ) as { label: string }[];
    const labels = roster.map((r) => r.label);
    expect(labels.length).toBeGreaterThan(0);
    const accounted = (l: string) =>
      (MEASURED_OUTPUT_TOKENS[l] !== undefined && MEASURED_INPUT_TOKENS[l] !== undefined)
      || TRUNCATED_SAMPLES[l] !== undefined;
    expect(labels.filter((l) => !accounted(l))).toEqual([]);
    // A label is in ONE place or the other, never both — otherwise a sample the
    // module says it refuses to price would still be pricing cells.
    expect(Object.keys(TRUNCATED_SAMPLES).filter((l) => MEASURED_OUTPUT_TOKENS[l] !== undefined)).toEqual([]);
    expect(Object.keys(TRUNCATED_SAMPLES).filter((l) => MEASURED_INPUT_TOKENS[l] !== undefined)).toEqual([]);
  });

  it('prices a TRUNCATED sample from the conservative fallback and names it, rather than from its own run', () => {
    // The finding: Qwen 3.6 27B's numbers came from a run that gave up after 7
    // tool calls. Its 29,987 input tokens are ~20x below Opus's 620,813 for the
    // same battery, and that gap is early termination, not cheapness — so a
    // matrix weighted toward it estimated LOW, the one direction this module
    // exists to prevent.
    const [label, sample] = Object.entries(TRUNCATED_SAMPLES)[0];
    const M: Price = { inputPerM: 1, outputPerM: 10 };
    const out = estimateCells([cell('c1', label)], { [label]: M });
    const truncated = (sample.inputTokens / 1e6) * 1 + (sample.outputTokens / 1e6) * 10;
    const fallback = (FALLBACK_INPUT_TOKENS / 1e6) * 1 + (FALLBACK_OUTPUT_TOKENS / 1e6) * 10;
    expect(out.perCell[0].usd).toBeCloseTo(fallback, 12);
    // And the direction that matters: the figure it would have used is LOWER.
    expect(truncated).toBeLessThan(fallback);
    // Named, so an operator can see the row is an assumption.
    expect(out.unmeasured).toEqual([label]);
    // The reason is recorded, not just the exclusion.
    expect(sample.why).toMatch(/\S/);
  });

  it('keeps input well above output, which is what makes input the dominant cost', () => {
    // The reason this module prices both sides instead of output alone: an
    // agentic loop re-sends its whole history every step. If a future edit ever
    // makes these comparable, the estimate's shape needs rethinking, not patching.
    for (const [label, input] of Object.entries(MEASURED_INPUT_TOKENS)) {
      expect(input).toBeGreaterThan(MEASURED_OUTPUT_TOKENS[label]);
    }
  });
});

describe('parsePriceCatalog', () => {
  it('converts OpenRouter per-token strings to dollars per million', () => {
    // A real response shape, copied from a live GET /api/v1/models on 2026-08-12.
    const body = {
      data: [
        { id: 'anthropic/claude-opus-5', pricing: { prompt: '0.000005', completion: '0.000025' } },
        { id: 'x-ai/grok-4.5', pricing: { prompt: '0.000002', completion: '0.000006' } },
      ],
    };
    expect(parsePriceCatalog(body)).toEqual({
      'anthropic/claude-opus-5': { inputPerM: 5, outputPerM: 25 },
      'x-ai/grok-4.5': { inputPerM: 2, outputPerM: 6 },
    });
  });

  it('skips an entry it cannot read instead of coercing it to a number', () => {
    // A skipped entry becomes an `unpriced` model downstream — named. A coerced
    // one (Number(undefined) is NaN, Number(null) is 0) becomes a wrong figure.
    const body = {
      data: [
        { id: 'a/missing-pricing' },
        { id: 'b/null-prompt', pricing: { prompt: null, completion: '0.000001' } },
        { id: 'c/text-prompt', pricing: { prompt: 'free', completion: '0.000001' } },
        { id: 'd/negative', pricing: { prompt: '-0.000001', completion: '0.000001' } },
        { pricing: { prompt: '0.000001', completion: '0.000001' } }, // no id
        { id: 'e/ok', pricing: { prompt: '0.000001', completion: '0.000002' } },
      ],
    };
    expect(Object.keys(parsePriceCatalog(body))).toEqual(['e/ok']);
  });

  it('returns an empty record for a body that is not a catalog, rather than throwing', () => {
    // The caller turns "no prices" into "every model is unpriced", which is the
    // honest outcome of a failed fetch. A throw here would take out --dry-run.
    for (const body of [null, undefined, {}, { data: 'nope' }, [], 'text']) {
      expect(parsePriceCatalog(body)).toEqual({});
    }
  });
});

describe('formatUsd', () => {
  it('never renders a non-zero cost as $0.00', () => {
    // A 24-cell grid can hold cells worth fractions of a cent, and "$0.00" on a
    // row is a claim that the row is free.
    expect(formatUsd(0.004)).toBe('$0.0040');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(1.5)).toBe('$1.50');
    expect(formatUsd(12.345)).toBe('$12.35');
  });
});

// --- the judge, which the per-cell figure does not price ---------------------

describe('judgeCostLines', () => {
  // Fix pass 1 (2026-08-12 review, IMPORTANT 1). `estimateCells` prices one
  // model run per cell; grading adds a SECOND paid call per graded cell that
  // appeared nowhere in the printed figure — the figure the operator answers
  // "Spend up to $X? [y/N]" against, and the only bound a run without
  // --max-spend has. These pin what the disclosure says, and that it never
  // invents a dollar amount for a call nobody has measured.
  const P: Price = { inputPerM: 0.5, outputPerM: 2 };

  it('names the judge, the call count, and that none of it is in the total', () => {
    const lines = judgeCostLines({ modelId: 'x-ai/grok-4.5', maxCalls: 12, price: P }).join('\n');
    expect(lines).toContain('NOT IN THE TOTAL');
    expect(lines).toContain('x-ai/grok-4.5');
    expect(lines).toContain('up to 12 more calls');
    // The one figure that IS known: the judge's own catalog rate.
    expect(lines).toContain('$0.50/M input');
    expect(lines).toContain('$2.00/M output');
  });

  it('invents no dollar figure for the judge, because no judge call was ever measured', () => {
    // THE DISCRIMINATING ASSERTION. A helpful-looking "≈ $0.41 of judging" would
    // be arithmetic over a token count nobody has: the measured tables in this
    // module come from whole-battery model runs and say nothing about a grading
    // call. So the cost is named and bounded in CALLS, never in dollars.
    const lines = judgeCostLines({ modelId: 'x-ai/grok-4.5', maxCalls: 12, price: P }).join('\n');
    expect(lines).toMatch(/token count is unknown/i);
    expect(lines).toMatch(/no dollar figure for it is invented/i);
    // No total-shaped dollar amount anywhere — only the two per-million rates.
    expect(lines.replace(/\$\d+\.\d+\/M/g, '')).not.toMatch(/\$\d/);
  });

  it('says the rate is unknown too when the catalog has no entry for the judge', () => {
    const lines = judgeCostLines({ modelId: 'vendor/unlisted', maxCalls: 3, price: null }).join('\n');
    expect(lines).toContain('The catalog has no price for vendor/unlisted');
    expect(lines).not.toMatch(/\$\d/);
  });

  it('says plainly when a plan grades nothing, so the reader knows the figure is whole', () => {
    const lines = judgeCostLines({ modelId: null, maxCalls: 12, price: P }).join('\n');
    expect(lines).toMatch(/names no judge/i);
    expect(lines).not.toContain('NOT IN THE TOTAL');
  });
});
