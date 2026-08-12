import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  estimateCells,
  parsePriceCatalog,
  formatUsd,
  MEASURED_OUTPUT_TOKENS,
  MEASURED_INPUT_TOKENS,
  FALLBACK_INPUT_TOKENS,
  FALLBACK_OUTPUT_TOKENS,
  MEASURED_ROSTER_SPEND_USD,
  type Price,
} from '../src/main/harness/eval/estimate';

const DESKTOP = path.resolve(__dirname, '..');

/** A cell in the shape `estimateCells` actually consumes — `id`, the field
 *  matrix.ts's Cell really has. (The plan sketch called it `cellId`; that is
 *  the OUTPUT field name, and using it as an input would have silently priced
 *  a row whose id was `undefined`.) */
const cell = (id: string, model: string) => ({ id, model });

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
    const out = estimateCells(
      [cell('c1', 'ZED'), cell('c2', 'ABE'), cell('c3', 'ZED')],
      {},
    );
    expect(out.unpriced).toEqual(['ABE', 'ZED']);
    expect(out.unmeasured).toEqual(['ABE', 'ZED']);
  });

  it('refuses a mis-shaped cell rather than pricing a row called undefined', () => {
    expect(() => estimateCells([{ model: 'Grok 4.5' } as never], {})).toThrow(/needs a non-empty string "id"/);
    expect(() => estimateCells([{ id: 'c1' } as never], {})).toThrow(/cell "c1" has no "model"/);
  });

  it('is empty-safe', () => {
    expect(estimateCells([], {})).toEqual({ perCell: [], totalUsd: 0, unpriced: [], unmeasured: [] });
  });
});

describe('the measured token tables', () => {
  it('covers every label in the shipped roster, so no real plan estimates from the fallback', () => {
    // WHY read the real roster file: the tables are keyed by roster LABEL, and a
    // label typo ("Deepseek v4 Flash 0731" vs the roster's lowercase "flash")
    // silently degrades that model to the conservative fallback instead of
    // erroring. Nothing else would catch it.
    const roster = JSON.parse(
      fs.readFileSync(path.join(DESKTOP, 'test-engine/review-roster.json'), 'utf8'),
    ) as { label: string }[];
    const labels = roster.map((r) => r.label);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.filter((l) => MEASURED_OUTPUT_TOKENS[l] === undefined)).toEqual([]);
    expect(labels.filter((l) => MEASURED_INPUT_TOKENS[l] === undefined)).toEqual([]);
  });

  it('keeps input well above output, which is what makes input the dominant cost', () => {
    // The reason this module prices both sides instead of output alone: an
    // agentic loop re-sends its whole history every step. If a future edit ever
    // makes these comparable, the estimate's shape needs rethinking, not patching.
    for (const [label, input] of Object.entries(MEASURED_INPUT_TOKENS)) {
      expect(input).toBeGreaterThan(MEASURED_OUTPUT_TOKENS[label]);
    }
  });

  it('records the billed calibration anchor as a positive figure', () => {
    // Not used in the maths — it is the one number that came from OpenRouter's
    // own biller rather than from token counting, and the CLI prints it so an
    // estimate that lands nowhere near it is visibly suspect.
    expect(MEASURED_ROSTER_SPEND_USD).toBeGreaterThan(0);
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
