// What a matrix of eval cells will cost, in dollars, BEFORE anything is spawned.
//
// WHY this module exists and why it is pure: the owner of this repo is not a
// developer and has been careful about cost — a previous whole-roster review
// run was measured at $10.38. Nothing may be spent without him first seeing an
// expanded grid and a dollar figure. A dollar figure that quietly treats an
// unknown model as free is worse than no figure at all, because it is the exact
// shape of a number someone would act on. So every gap in the inputs is NAMED
// in the return value rather than defaulted to zero, and the whole calculation
// is filesystem-free / network-free / clock-free so it can be unit-tested.

/** Dollars per MILLION tokens, the unit every model catalog quotes. */
export interface Price {
  inputPerM: number;
  outputPerM: number;
}

/** The only fields of a `Cell` (matrix.ts) an estimate needs. Structural on
 *  purpose: the estimator must not drag matrix.ts's whole shape into its tests,
 *  and a caller with a real Cell satisfies this without a cast. */
export interface EstimatableCell {
  id: string;
  model: string; // a ROSTER LABEL (matrix.ts's `models` are labels, not model ids)
}

// ---------------------------------------------------------------------------
// MEASURED TOKEN COUNTS — the two runs these come from, and why both.
//
// THESE ARE BATTERY-SIZED RUNS. Every number below is one model walking the
// whole seven-area harness-review battery (battery.ts's BATTERY_PROMPT): 40-63
// tool calls, ~20 minutes. A SHORT CASE COSTS FAR LESS — a "read this file and
// explain it" case is a handful of calls, so an estimate built from these
// figures is an upper bound for anything smaller, not a prediction of it. That
// is the right direction to be wrong in for a spend decision, and it is why
// they are not scaled down by some invented per-case factor.
//
// Source 1 — the figures already recorded in run-case.ts (see the comment block
// at its `assertHistoryBudget`, "Real per-run totals measured from live
// transcripts"), from the 2026-08-10 round. OUTPUT ONLY; that block never
// recorded input:
//     Claude Opus 5 8,379 · Qwen 3.8 Max 11,766 · Deepseek v4 flash 0731 9,530
//     GPT 5.6 Luna 4,098 · Grok 4.5 3,662
//
// Source 2 — the saved transcripts of the 2026-08-11 whole-roster round, read
// out of `docs/active/investigations/harness-review-runs/2026-08-11/*.json`
// (`run.metrics.inputTokens` / `.outputTokens`, which HarnessSession accumulates
// across every step of a run). This round covers ALL EIGHT roster models and is
// the only one that recorded INPUT, which is the side that dominates the bill:
// an agentic loop re-sends its whole history every step, so input runs 20-200x
// output. Those transcript files are gitignored, so the numbers are transcribed
// here rather than read at run time — that is the drift risk, and re-measuring
// means re-reading that directory after the next roster round.
//
// WHY the OUTPUT table takes the LARGER of the two rounds where they disagree:
// the two rounds measured the same battery against the same models and got
// different answers (Opus 8,379 then 14,200), because a model's path through an
// agentic task is not deterministic. An estimate that under-predicts is the one
// that costs someone money they did not agree to, so where the evidence
// disagrees this takes the higher number.
// ---------------------------------------------------------------------------

/** Measured whole-run OUTPUT tokens, per roster label. See the block above for
 *  provenance; values are max(2026-08-10 figure where one exists, 2026-08-11). */
export const MEASURED_OUTPUT_TOKENS: Record<string, number> = {
  'Claude Opus 5': 14_200, //  2026-08-10:  8,379 · 2026-08-11: 14,200
  'Qwen 3.8 Max': 11_766, //   2026-08-10: 11,766 · 2026-08-11: 11,490
  'Deepseek v4 flash 0731': 11_645, // 2026-08-10: 9,530 · 2026-08-11: 11,645
  'GPT 5.6 Luna': 4_375, //    2026-08-10:  4,098 · 2026-08-11:  4,375
  'Grok 4.5': 3_790, //        2026-08-10:  3,662 · 2026-08-11:  3,790
  'Qwen 3.5 122B A10B': 3_773, //      2026-08-11 only
  'Qwen 3.6 35B A3B': 6_906, //        2026-08-11 only (run ended 'wrapped-up')
  'Qwen 3.6 27B': 2_861, //            2026-08-11 only (7 calls, 'wrapped-up')
};

/** Measured whole-run INPUT tokens, per roster label — 2026-08-11 round only,
 *  the only round whose transcripts recorded them.
 *
 *  WHY input is tracked separately and not derived from output by a ratio: the
 *  ratio is not stable. It runs from 10x (Qwen 3.6 27B, which gave up after 7
 *  calls) to 206x (Qwen 3.6 35B A3B, which looped), so any single multiplier
 *  would be an invented number dressed up as a measurement. */
export const MEASURED_INPUT_TOKENS: Record<string, number> = {
  'Claude Opus 5': 620_813,
  'Deepseek v4 flash 0731': 565_321,
  'GPT 5.6 Luna': 255_319,
  'Grok 4.5': 125_690,
  'Qwen 3.5 122B A10B': 257_658,
  'Qwen 3.6 27B': 29_987,
  'Qwen 3.6 35B A3B': 1_419_716, // a looping run — the reason --max-spend exists
  'Qwen 3.8 Max': 304_615,
};

/** Whole-roster spend actually billed for one round, measured 2026-08-11 from
 *  OpenRouter's own `/api/v1/key` usage counter and recorded in
 *  `.claude/rules/harness-review-runner.md` ("$10.38 for rounds 6-8, ~$3.46 a
 *  roster"). Exported as a CALIBRATION ANCHOR, not as an input to the maths: it
 *  is the one figure here that came from the biller rather than from token
 *  counting, so an estimate for eight battery cells that lands nowhere near it
 *  means the token table or the catalog prices are wrong.
 *
 *  CALIBRATED 2026-08-12 against live catalog prices: this module estimates
 *  $4.82 for the eight-cell roster the biller charged $3.46 for — 39% HIGH,
 *  which is the direction an estimate should err in for a spend decision. The
 *  likely gap is prompt caching (an agentic loop re-sends its history every
 *  step, and OpenRouter lists Opus cache reads at $0.50/M against $5/M for
 *  fresh input — a 10x discount this estimate deliberately does not assume),
 *  plus the anchor itself being an average over rounds 6-8 rather than one
 *  measured round. */
export const MEASURED_ROSTER_SPEND_USD = 3.46;

/** Token counts used for a model with no measurement at all — the worst row of
 *  each measured table.
 *
 *  WHY the worst and not the average: the alternative to a conservative number
 *  here is a cheerful one, and this figure's only job is to stop someone
 *  agreeing to spend more than they meant to. Callers are TOLD which models got
 *  it (`unmeasured` in the result), so an implausibly large total is traceable
 *  to the assumption rather than mysterious. */
export const FALLBACK_OUTPUT_TOKENS = Math.max(...Object.values(MEASURED_OUTPUT_TOKENS));
export const FALLBACK_INPUT_TOKENS = Math.max(...Object.values(MEASURED_INPUT_TOKENS));

export interface CellEstimate {
  cellId: string;
  model: string;
  /** Dollars, or NULL when the model has no price entry.
   *
   *  WHY nullable rather than 0: a zero here is indistinguishable from a genuinely
   *  free model, and it would silently vanish into a sum. `null` forces every
   *  caller — including a future one — to decide what to do about a cell it
   *  cannot price, which is the entire point of this module. */
  usd: number | null;
}

export interface MatrixEstimate {
  perCell: CellEstimate[];
  /** Sum of the cells that COULD be priced. Read it together with `unpriced`:
   *  when that list is non-empty this is a partial total, never the bill. */
  totalUsd: number;
  /** Roster labels with no entry in `prices`, deduplicated and sorted. */
  unpriced: string[];
  /** Roster labels with no entry in the measured-token tables, which were
   *  estimated from FALLBACK_*_TOKENS instead. Deduplicated and sorted. */
  unmeasured: string[];
}

/**
 * Price a whole matrix.
 *
 * `prices` is keyed by ROSTER LABEL (the same string `cell.model` carries), not
 * by OpenRouter model id — the caller does the id→label mapping, because the
 * roster is the only thing that knows the correspondence.
 *
 * A model missing from `prices` is NAMED in `unpriced` and its cells come back
 * with `usd: null`; it is never counted as free. A price of exactly 0 is a real
 * answer (OpenRouter genuinely lists free models) and is NOT treated as missing
 * — the distinction is "is there an entry", not "is the number truthy".
 */
export function estimateCells(
  cells: EstimatableCell[],
  prices: Record<string, Price>,
): MatrixEstimate {
  const unpriced = new Set<string>();
  const unmeasured = new Set<string>();
  const perCell: CellEstimate[] = [];
  let totalUsd = 0;

  for (const cell of cells) {
    // Fail loudly on a mis-shaped cell rather than pricing a row called
    // "undefined": this function's output is what a human says yes to.
    if (!cell || typeof cell.id !== 'string' || !cell.id) {
      throw new Error('estimateCells: every cell needs a non-empty string "id" (matrix.ts\'s Cell.id).');
    }
    if (typeof cell.model !== 'string' || !cell.model) {
      throw new Error(`estimateCells: cell "${cell.id}" has no "model" (a roster label).`);
    }

    const outputTokens = MEASURED_OUTPUT_TOKENS[cell.model];
    const inputTokens = MEASURED_INPUT_TOKENS[cell.model];
    if (outputTokens === undefined || inputTokens === undefined) unmeasured.add(cell.model);

    const price = Object.prototype.hasOwnProperty.call(prices, cell.model) ? prices[cell.model] : undefined;
    if (!price) {
      unpriced.add(cell.model);
      perCell.push({ cellId: cell.id, model: cell.model, usd: null });
      continue;
    }

    const usd =
      ((inputTokens ?? FALLBACK_INPUT_TOKENS) / 1_000_000) * price.inputPerM
      + ((outputTokens ?? FALLBACK_OUTPUT_TOKENS) / 1_000_000) * price.outputPerM;
    perCell.push({ cellId: cell.id, model: cell.model, usd });
    totalUsd += usd;
  }

  return {
    perCell,
    totalUsd,
    unpriced: [...unpriced].sort(),
    unmeasured: [...unmeasured].sort(),
  };
}

/**
 * Turn an OpenRouter `/api/v1/models` response body into `Price` entries keyed
 * by MODEL ID.
 *
 * WHY prices are fetched from the live catalog rather than hardcoded here: I do
 * not know what these models cost, and a hardcoded table would be invented
 * numbers with a plausible-looking "fetched on" date attached — the precise
 * failure this module exists to prevent. The catalog endpoint is public (no key
 * needed), so a `--dry-run` estimate still works with no credential anywhere.
 * The cost of fetching is that a run depends on one network call; when it
 * fails, the caller gets an empty record and EVERY model lands in `unpriced`,
 * which is the honest outcome rather than a silent zero.
 *
 * WHY only `prompt`/`completion` and not the other catalog rates: `pricing` also
 * carries `input_cache_read`, `input_cache_write` and per-model `overrides`
 * (Grok 4.5 doubles above a 200k-token prompt). None are modelled here — this
 * harness sends no cached prefixes, and the measured per-run input totals are
 * SUMS across ~50 steps rather than one giant prompt, so no single request is
 * near the override threshold. If that stops being true the estimate reads LOW,
 * which is why --max-spend exists as well as this.
 *
 * Malformed or non-numeric entries are SKIPPED rather than coerced, so they
 * surface as `unpriced` (named) instead of as a wrong number.
 */
/** A catalog field that may honestly be turned into a number. Deliberately
 *  narrow: anything that is not literally a number or a non-empty string is a
 *  field this code does not understand, and "does not understand" must become
 *  an unpriced (named) model rather than a coerced zero. */
function isNumeric(value: unknown): value is string | number {
  if (typeof value === 'number') return true;
  return typeof value === 'string' && value.trim() !== '';
}

export function parsePriceCatalog(body: unknown): Record<string, Price> {
  const out: Record<string, Price> = {};
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    const model = entry as { id?: unknown; pricing?: { prompt?: unknown; completion?: unknown } };
    if (typeof model?.id !== 'string' || !model.id) continue;
    // OpenRouter quotes USD PER TOKEN, as strings ("0.000005"). Per-million is
    // what humans read, so convert once, here.
    //
    // WHY the raw values are type-checked BEFORE Number(): `Number(null)` and
    // `Number('')` are both 0 — finite, non-negative, and indistinguishable from
    // a genuinely free model. Caught by a test: a catalog entry with
    // `"prompt": null` was being published as $0/M rather than skipped, which is
    // the exact silent-zero this module exists to prevent.
    const rawIn = model.pricing?.prompt;
    const rawOut = model.pricing?.completion;
    if (!isNumeric(rawIn) || !isNumeric(rawOut)) continue;
    const inputPerM = Number(rawIn) * 1_000_000;
    const outputPerM = Number(rawOut) * 1_000_000;
    if (!Number.isFinite(inputPerM) || !Number.isFinite(outputPerM)) continue;
    if (inputPerM < 0 || outputPerM < 0) continue;
    out[model.id] = { inputPerM, outputPerM };
  }
  return out;
}

/** Dollars, rendered so a small figure never reads as $0.00.
 *  WHY: a 24-cell grid can contain cells worth $0.004, and "$0.00" next to a
 *  row is a claim that the row is free. */
export function formatUsd(usd: number): string {
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
