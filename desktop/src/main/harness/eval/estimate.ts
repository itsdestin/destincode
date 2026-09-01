// What a matrix of eval cells will cost, in dollars, BEFORE anything is spawned.
//
// WHY this module exists and why it is pure: the owner of this repo is not a
// developer and has been careful about cost — three whole-roster review rounds
// (6-8) were billed $10.38 between them, about $3.46 a round. (Fix pass 1,
// 2026-08-12 review, MINOR: this line used to read "a previous whole-roster
// review run was measured at $10.38", which overstated one round's cost by 3x
// — the source figure covers three rounds.) Nothing may be spent without him
// first seeing an expanded grid and a dollar figure. A figure that quietly treats an
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
 *  and a caller with a real Cell satisfies this without a cast.
 *
 *  `caseId` was added (2026-08-13) so a cell can be priced from a measurement of
 *  the exact TASK it runs, not just the model — see MEASURED_CASE_TOKENS below
 *  for why that distinction is an 8x swing, not a rounding error. */
export interface EstimatableCell {
  id: string;
  caseId: string; // matrix.ts's Cell.caseId — which eval case this cell runs
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
//
// AND, BY THE SAME RULE (fix pass 1, 2026-08-12 review, IMPORTANT 1): a run that
// GAVE UP EARLY is not a measurement of what the battery costs — it is a
// measurement of how long that model lasted. Those samples are kept below in
// TRUNCATED_SAMPLES, out of the tables, so their labels fall to the conservative
// fallback and are NAMED in `unmeasured`. Leaving them in the tables made the
// estimate read LOW for exactly the plans that lean on them, which is the one
// direction this module exists to prevent.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MEASURED CASE TOKENS — the fix for the 8x-high estimate (2026-08-13).
//
// Everything above this line prices a cell as "whatever this MODEL costs on
// the whole battery" — 40-63 tool calls, ~20 minutes. The evaluator now also
// runs short PROSE cases (config-investigation, options-proposal, port-bump):
// 9-19 tool calls, a few minutes. Pricing one of those from the battery table
// is not a conservative estimate, it is a WRONG TASK: measured 2026-08-13, six
// cells of the calibration plan (config-investigation, both models, three
// instruction arms) priced at $12.42 from the battery table and actually
// billed $1.52 — the estimate was ~8x high. An estimate that is 8x high is not
// a safe default; it is a real harm, because it teaches the operator that a
// pocket-change eval costs more than it does and stops him from running it.
//
// So this table holds MEASURED TOKENS FOR THE ACTUAL CASE, keyed by caseId and
// then by roster label, read from `run.metrics` in the 22 saved transcripts of
// the 2026-08-13 short-case runs. Per the doctrine at the top of this file —
// "where evidence disagrees, take the LARGER, because under-predicting spends
// money the operator did not agree to" — each cell below is the MAX across its
// samples, not the mean. The mean is recorded in the trailing comment on each
// line so a reader can see the spread; it is not used in the maths.
//
// THE SPREAD IS REAL AND LARGE: Qwen 3.8 Max on config-investigation ran as
// high as 342,207 input tokens against a 189,087 mean on the SAME case — a
// single agentic run's cost is not a stable number, it wanders with the path
// the model happens to take. Taking the max is a deliberate choice to price
// the expensive tail, not an accident of which sample got typed in first.
//
// Samples (n = number of transcripts averaged/maxed per row):
//   config-investigation / Claude Opus 5 : n=3  input max 57,320   (mean 51,247)   output max 3,961  (mean 3,685)
//   config-investigation / Qwen 3.8 Max  : n=3  input max 342,207  (mean 189,087)  output max 4,415  (mean 3,239)
//   options-proposal     / Claude Opus 5 : n=5  input max 124,425  (mean 106,729)  output max 7,386  (mean 5,447)
//   options-proposal     / Qwen 3.8 Max  : n=5  input max 319,077  (mean 111,592)  output max 6,099  (mean 3,914)
//   port-bump            / Claude Opus 5 : n=3  input max 70,908   (mean 64,578)   output max 3,032  (mean 2,280)
//   port-bump            / Qwen 3.8 Max  : n=3  input max 62,640   (mean 58,885)   output max 1,751  (mean 1,472)
//
// A case/model pair with no entry here (a case not yet measured, or a roster
// model not in these runs) falls through to the battery table below — which is
// a DIFFERENT KIND OF GUESS, a short-task cell priced from a whole-battery
// number, the exact over-estimate this table exists to fix. `estimateCells`
// reports that fall-through separately (`batteryPriced`) so a caller can never
// mistake a battery-priced row for a measurement of the case it is actually
// pricing. The one exception is the `harness-battery` case itself: that case
// IS the battery, so the battery table is a correct measurement of it, not an
// over-estimate — `estimateCells` does not flag it.
// ---------------------------------------------------------------------------

/** Measured token counts for a specific (case, model) pair — see the block
 *  above for provenance, the max-over-mean rule, and why the spread matters.
 *  Checked BEFORE the whole-battery tables below. */
export const MEASURED_CASE_TOKENS: Record<string, Record<string, { inputTokens: number; outputTokens: number }>> = {
  'config-investigation': {
    'Claude Opus 5': { inputTokens: 57_320, outputTokens: 3_961 }, // n=3  mean input 51,247  mean output 3,685
    'Qwen 3.8 Max': { inputTokens: 342_207, outputTokens: 4_415 }, // n=3  mean input 189,087  mean output 3,239 — wide spread, see note above
  },
  'options-proposal': {
    'Claude Opus 5': { inputTokens: 124_425, outputTokens: 7_386 }, // n=5  mean input 106,729  mean output 5,447
    'Qwen 3.8 Max': { inputTokens: 319_077, outputTokens: 6_099 }, // n=5  mean input 111,592  mean output 3,914
  },
  'port-bump': {
    'Claude Opus 5': { inputTokens: 70_908, outputTokens: 3_032 }, // n=3  mean input 64,578  mean output 2,280
    'Qwen 3.8 Max': { inputTokens: 62_640, outputTokens: 1_751 }, // n=3  mean input 58,885  mean output 1,472
  },
};

/** Measured whole-run OUTPUT tokens, per roster label. See the block above for
 *  provenance; values are max(2026-08-10 figure where one exists, 2026-08-11).
 *  Labels in TRUNCATED_SAMPLES are deliberately absent. */
export const MEASURED_OUTPUT_TOKENS: Record<string, number> = {
  'Claude Opus 5': 14_200, //  2026-08-10:  8,379 · 2026-08-11: 14,200
  'Qwen 3.8 Max': 11_766, //   2026-08-10: 11,766 · 2026-08-11: 11,490
  'Deepseek v4 flash 0731': 11_645, // 2026-08-10: 9,530 · 2026-08-11: 11,645
  'GPT 5.6 Luna': 4_375, //    2026-08-10:  4,098 · 2026-08-11:  4,375
  'Grok 4.5': 3_790, //        2026-08-10:  3,662 · 2026-08-11:  3,790
  'Qwen 3.5 122B A10B': 3_773, //      2026-08-11 only
  'Qwen 3.6 35B A3B': 6_906, //        2026-08-11 only (looped, then wrapped up)
};

/** Measured whole-run INPUT tokens, per roster label — 2026-08-11 round only,
 *  the only round whose transcripts recorded them.
 *
 *  WHY input is tracked separately and not derived from output by a ratio: the
 *  ratio is not stable. It runs from 10x (Qwen 3.6 27B, which gave up after 7
 *  calls — see TRUNCATED_SAMPLES) to 206x (Qwen 3.6 35B A3B, which looped), so
 *  any single multiplier would be an invented number dressed up as a
 *  measurement. Labels in TRUNCATED_SAMPLES are deliberately absent here too. */
export const MEASURED_INPUT_TOKENS: Record<string, number> = {
  'Claude Opus 5': 620_813,
  'Deepseek v4 flash 0731': 565_321,
  'GPT 5.6 Luna': 255_319,
  'Grok 4.5': 125_690,
  'Qwen 3.5 122B A10B': 257_658,
  'Qwen 3.6 35B A3B': 1_419_716, // a looping run — the reason --max-spend exists
  'Qwen 3.8 Max': 304_615,
};

/**
 * Roster labels whose only sample came from a run that STOPPED EARLY, recorded
 * here and deliberately NOT used to price anything.
 *
 * WHY they are excluded rather than used (fix pass 1, 2026-08-12 review,
 * IMPORTANT 1): Qwen 3.6 27B's 29,987 input tokens sit ~20x below Opus's
 * 620,813 for the same battery, and that gap is a property of the run ending
 * after 7 tool calls, not of the model being cheap. Pricing a cell from it means
 * a matrix weighted toward that model estimates LOW — the failure this module
 * exists to prevent — and it contradicts the rule two blocks up, which takes the
 * LARGER of two rounds precisely because one sample of a non-deterministic path
 * does not establish a cost.
 *
 * The effect of being listed here: `estimateCells` finds no entry in either
 * measured table, prices the cell from FALLBACK_*_TOKENS (the worst measured
 * row), and NAMES the label in `unmeasured` so the operator is told the row is
 * an assumption rather than a measurement. The numbers are kept so a future
 * round can compare against them instead of re-deriving them from gitignored
 * transcripts.
 */
export const TRUNCATED_SAMPLES: Record<string, { inputTokens: number; outputTokens: number; why: string }> = {
  'Qwen 3.6 27B': {
    inputTokens: 29_987,
    outputTokens: 2_861,
    why: "2026-08-11: gave up after 7 tool calls and ended 'wrapped-up'. A measurement of how long it lasted, not of what the battery costs.",
  },
};

// The hand-copied calibration anchor that used to live here
// (MEASURED_ROSTER_SPEND_USD = 3.46, the mean of three rounds billed $10.38
// between them, 2026-08-11) is RETIRED (ROADMAP L161). It could not say which
// way this estimate errs, because the rounds were never recorded separately.
// The evaluator now reads OpenRouter's own per-request cost off the wire
// (openrouter-factory.ts → metrics.providerCostUsd, printed on every cell's
// "Run facts" line), so a roster round reports the biller's figure per model,
// per round — compare THAT against the rows this module prints.

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
  /** `"<caseId> / <model>"` pairs priced from the whole-BATTERY tables
   *  (MEASURED_OUTPUT_TOKENS / MEASURED_INPUT_TOKENS) because MEASURED_CASE_TOKENS
   *  had no entry for that exact case+model. That is a short task priced from a
   *  40-63-tool-call run — the ~8x over-estimate MEASURED_CASE_TOKENS exists to
   *  fix — so these rows are NOT a measurement of the case they price and must
   *  never be presented as one. The `harness-battery` case is excluded: for that
   *  case the battery table IS a measurement, not an over-estimate.
   *  Deduplicated and sorted. */
  batteryPriced: string[];
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
 *
 * Token counts are looked up in THREE tiers, most specific first: (1)
 * MEASURED_CASE_TOKENS[caseId][model] — a real measurement of this exact task
 * on this exact model; (2) MEASURED_OUTPUT_TOKENS/MEASURED_INPUT_TOKENS — a
 * whole-BATTERY measurement of the model, which is a correct price only for
 * the `harness-battery` case and an over-estimate for every shorter case,
 * flagged in `batteryPriced` so it is never mistaken for tier 1; (3)
 * FALLBACK_*_TOKENS — no measurement at all, flagged in `unmeasured`.
 */
export function estimateCells(
  cells: EstimatableCell[],
  prices: Record<string, Price>,
): MatrixEstimate {
  const unpriced = new Set<string>();
  const unmeasured = new Set<string>();
  const batteryPriced = new Set<string>();
  const perCell: CellEstimate[] = [];
  let totalUsd = 0;

  for (const cell of cells) {
    // Fail loudly on a mis-shaped cell rather than pricing a row called
    // "undefined": this function's output is what a human says yes to.
    if (!cell || typeof cell.id !== 'string' || !cell.id) {
      throw new Error('estimateCells: every cell needs a non-empty string "id" (matrix.ts\'s Cell.id).');
    }
    if (typeof cell.caseId !== 'string' || !cell.caseId) {
      throw new Error(`estimateCells: cell "${cell.id}" has no "caseId" (matrix.ts's Cell.caseId).`);
    }
    if (typeof cell.model !== 'string' || !cell.model) {
      throw new Error(`estimateCells: cell "${cell.id}" has no "model" (a roster label).`);
    }

    // Tier 1: a measurement of THIS EXACT case on THIS EXACT model. Preferred
    // over everything below because it is the only tier that measured the task
    // actually being priced, not a proxy for it.
    const caseSample = MEASURED_CASE_TOKENS[cell.caseId]?.[cell.model];
    // Tier 2: the whole-battery tables. Correct for the `harness-battery` case
    // (that case IS the battery), an over-estimate for every other case (a short
    // task priced from a 40-63-tool-call run) — flagged below via `batteryPriced`.
    const batteryOutputTokens = MEASURED_OUTPUT_TOKENS[cell.model];
    const batteryInputTokens = MEASURED_INPUT_TOKENS[cell.model];

    // Fix pass 1 (2026-08-12 review, MINOR): the `unmeasured` add used to happen
    // HERE, before the price check below. A model that is both unpriced and
    // unmeasured then appeared in BOTH printed lists, whose prose contradicts:
    // "priced from the worst measured run, so those rows read HIGH" next to
    // "no price for these — they are NOT in the total". Only one can be true of a
    // given row, and it is the unpriced one, because that row was never priced at
    // all. So `unmeasured` now means "priced, but from an assumption".
    const price = Object.prototype.hasOwnProperty.call(prices, cell.model) ? prices[cell.model] : undefined;
    if (!price) {
      unpriced.add(cell.model);
      perCell.push({ cellId: cell.id, model: cell.model, usd: null });
      continue;
    }

    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    if (caseSample) {
      inputTokens = caseSample.inputTokens;
      outputTokens = caseSample.outputTokens;
    } else if (batteryInputTokens !== undefined && batteryOutputTokens !== undefined) {
      inputTokens = batteryInputTokens;
      outputTokens = batteryOutputTokens;
      // Not an over-estimate for the battery case itself — see MEASURED_CASE_TOKENS's
      // header comment for why that one caseId is excluded from the flag.
      if (cell.caseId !== 'harness-battery') batteryPriced.add(`${cell.caseId} / ${cell.model}`);
    } else {
      unmeasured.add(cell.model);
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
    batteryPriced: [...batteryPriced].sort(),
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
 * (Grok 4.5 doubles above a 200k-token prompt). Neither is modelled here.
 *
 * Fix pass 1 (2026-08-12 review, IMPORTANT 2): this paragraph used to assert
 * "this harness sends no cached prefixes", while the (since retired) roster
 * spend anchor's comment simultaneously explained the whole estimate-vs-billed
 * gap AS prompt caching. Both cannot be true, and NEITHER was measured — so both assertions
 * are gone rather than one of them being picked. What is actually known: cache
 * rates are not modelled, so if these runs DO hit a provider cache the estimate
 * reads high, and if they do not it is unaffected. The override threshold is
 * likewise not modelled; measured per-run input totals are SUMS across ~50 steps
 * rather than one giant prompt, so no single request was near it. If that stops
 * being true the estimate reads LOW, which is why --max-spend exists as well as
 * this.
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

/**
 * What GRADING adds to the bill, in the only terms this module can stand behind.
 *
 * WHY this exists (fix pass 1, 2026-08-12 review, IMPORTANT 1): `estimateCells`
 * prices cells — one model run each — and the judge is a SECOND paid API call
 * per graded cell that appeared nowhere in the figure or in the words printed
 * with it. The operator then answered `Spend up to $X? [y/N]` against a number
 * that was knowably low, which on a plan with no `--max-spend` is the only bound
 * there is. This module's whole premise is not lying about money.
 */
export interface JudgeCost {
  /** The plan's judge (an OpenRouter model id), or null when it grades nothing. */
  modelId: string | null;
  /** Upper bound on judge CALLS: one per cell, and only cells that produce a
   *  run are graded, so the real number can only be lower. */
  maxCalls: number;
  /** The catalog price for that model id, or null when the catalog had no entry
   *  for it (a fetch failure, or a judge that is not an OpenRouter model). */
  price: Price | null;
}

/**
 * The judge lines that print WITH the total, one string per line.
 *
 * WHY no dollar figure is produced here, and why that is the honest answer
 * rather than a lazy one: pricing a judge call needs its TOKEN COUNT, and no
 * judge call has ever been measured. The two measured tables above come from
 * whole-battery model runs and say nothing about a grading call, whose prompt is
 * one answer plus one rubric. Any number here would be arithmetic over an
 * invented token count wearing the same authority as the measured rows — the
 * exact failure the header of this file describes. So the cost is NAMED,
 * BOUNDED in calls, and given the judge's real per-token price where the catalog
 * has one, which is the same treatment `unpriced` models already get: a cost the
 * reader is told about and told is not in the total, never a silent zero.
 */
export function judgeCostLines(cost: JudgeCost): string[] {
  if (!cost.modelId) {
    return ['Judging: this plan names no judge, so no grading calls are made and none are missing from the figure above.'];
  }
  const lines = [
    '! NOT IN THE TOTAL — the judge. The figure above prices MODEL RUNS ONLY.',
    `  This plan grades with ${cost.modelId}: one further API call per cell that produces a run,`,
    `  so up to ${cost.maxCalls} more call${cost.maxCalls === 1 ? '' : 's'} on top of the ${cost.maxCalls} run${cost.maxCalls === 1 ? '' : 's'} priced above.`,
  ];
  lines.push(cost.price
    ? `  That model costs $${cost.price.inputPerM.toFixed(2)}/M input and $${cost.price.outputPerM.toFixed(2)}/M output,`
      + ' but no judge call has ever been'
    : `  The catalog has no price for ${cost.modelId}, so its rate is unknown as well as its size, and no judge call has ever been`);
  lines.push(
    '  measured — so its token count is unknown and no dollar figure for it is invented here.',
    '  --max-spend DOES cover it (it reads what OpenRouter actually billed), so use that if the number matters.',
  );
  return lines;
}

/** Dollars, rendered so a small figure never reads as $0.00.
 *  WHY: a 24-cell grid can contain cells worth $0.004, and "$0.00" next to a
 *  row is a claim that the row is free. */
export function formatUsd(usd: number): string {
  if (usd !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
