//
// The ONE place tokens become dollars (spec §5). Lives in main because main is
// where the binding — and therefore the price — is known; the renderer only
// ever adds up figures it was handed.
//
// Rates are USD per 1,000,000 tokens (CatalogModel.pricing), hence every /1e6.

export type ModelPricing = { in: number; out: number; cacheRead?: number; cacheWrite?: number };

export interface PricedUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

/** True when a published rate card charges nothing for ANY of the four things
 *  a turn can consume — so the model is FREE, not "priced at zero".
 *
 *  WHY this exists at all: OpenRouter publishes its `:free` model variants with
 *  a price of the string "0", and the catalog mapper (model-catalog.ts) maps
 *  that faithfully to a real rate of 0. Without this check, a free model would
 *  report a priced session cost of exactly $0.00 — the false zero
 *  docs/error-message-standards.md forbids, and worse than an absent chip.
 *
 *  WHY all four rates and not just in/out: an absent cache rate falls back to
 *  the input rate below, so with in = 0 an absent cacheRead genuinely costs
 *  nothing — but a PUBLISHED non-zero cache rate does not. Checking all four
 *  makes this predicate exactly "cost is zero for every possible turn", which
 *  is what "free" has to mean if the two states are never to be confused.
 *
 *  A missing rate card is NOT free — it means "no published price", a
 *  different state with different wording in the status bar. */
export function isFreePricing(pricing: ModelPricing | null | undefined): boolean {
  if (!pricing) return false;
  return pricing.in === 0 && pricing.out === 0
    && (pricing.cacheRead ?? 0) === 0 && (pricing.cacheWrite ?? 0) === 0;
}

/** USD for one turn, or null when the model has no published price.
 *
 *  null, never 0: a zero would render as "$0.00", which claims the turn was
 *  free. An absent chip is the honest output (docs/error-message-standards.md).
 *  A genuinely free model (isFreePricing) also returns null here and is
 *  reported through the separate `free` flag instead.
 *
 *  WHY cached reads are subtracted from the prompt: providers report
 *  inputTokens as the WHOLE prompt and cacheReadTokens as the part served from
 *  cache. Charging both at the full input rate is exactly the over-reporting
 *  this modelling removes. When no cache rate is published, the cached portion
 *  stays at the full input rate — the honest fallback, since we don't know the
 *  discount. */
export function costForUsage(usage: PricedUsage, pricing: ModelPricing | null | undefined): number | null {
  if (!pricing) return null;
  if (isFreePricing(pricing)) return null;   // free to run — not a $0.00 bill
  const cachedRead = pricing.cacheRead != null ? Math.min(usage.cacheReadTokens, usage.inputTokens) : 0;
  const uncachedIn = Math.max(0, usage.inputTokens - cachedRead);
  const cost =
    (uncachedIn / 1e6) * pricing.in
    + (cachedRead / 1e6) * (pricing.cacheRead ?? pricing.in)
    + (usage.outputTokens / 1e6) * pricing.out
    + (pricing.cacheWrite != null ? (usage.cacheCreationTokens / 1e6) * pricing.cacheWrite : 0);
  return Math.max(0, cost);
}
