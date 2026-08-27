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

// ---------------------------------------------------------------------------
// Checking our arithmetic against the provider's own bill (plan Task 27).
//
// Everything above turns tokens into dollars from a published rate card.
// Nothing checked that answer against the only authority that matters — what
// the provider actually charged. OpenRouter reports its own per-request figure
// in the usage block of every response, so we can now compare continuously.
//
// The whole design rests on ONE distinction, the same one drawn above between
// `null` and absent: a provider that reports NOTHING must never read as zero,
// and never as agreement. Only OpenRouter-shaped providers report a cost at
// all — a local model, an Anthropic key and a plain OpenAI-compatible endpoint
// all report nothing, which is by far the common case.
// ---------------------------------------------------------------------------

/** Provider-metadata key the extractor writes under. Matches the provider name
 *  passed to createOpenAICompatible, which is where the AI SDK namespaces
 *  provider-specific metadata. */
const OPENROUTER_METADATA_KEY = 'openrouter';

/** Reads `usage.cost` off one parsed response body or SSE chunk.
 *  undefined — never 0 — for anything that is not a finite number, because
 *  "the field was not there" and "the provider charged nothing" are different
 *  facts and a `:free` model genuinely reports 0. */
function readCost(parsed: unknown): number | undefined {
  const cost = (parsed as any)?.usage?.cost;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
}

/** The `metadataExtractor` handed to createOpenAICompatible for OpenRouter.
 *
 *  WHY a metadata extractor and not a stream reader: `usage.cost` is a RAW
 *  field on OpenRouter's wire response. The AI SDK's own stream parts model
 *  token counts only, so by the time a chunk reaches our harness the cost is
 *  already gone. This hook is the SDK's supported way to reach the raw JSON —
 *  its `processChunk` runs on every parsed chunk, including OpenRouter's final
 *  usage-only chunk (whose `choices` array is empty).
 *
 *  Verified against @ai-sdk/openai-compatible@3.0.14: processChunk is called
 *  for every successfully-parsed chunk before any choices handling, and
 *  buildMetadata()'s return value is spread into the finish part's
 *  providerMetadata — which streamText resolves as `result.providerMetadata`. */
export const openRouterCostExtractor = {
  async extractMetadata({ parsedBody }: { parsedBody: unknown }) {
    const cost = readCost(parsedBody);
    return cost === undefined ? undefined : { [OPENROUTER_METADATA_KEY]: { costUsd: cost } };
  },
  createStreamExtractor() {
    let cost: number | undefined;
    return {
      processChunk(parsedChunk: unknown) {
        const c = readCost(parsedChunk);
        // Last one wins, but only a real reading overwrites: a later chunk
        // WITHOUT the field must not erase the figure an earlier one carried.
        if (c !== undefined) cost = c;
      },
      buildMetadata() {
        // undefined, not { costUsd: 0 } — see the section header.
        return cost === undefined ? undefined : { [OPENROUTER_METADATA_KEY]: { costUsd: cost } };
      },
    };
  },
};

/** The provider's own USD figure for one request, or undefined when it did not
 *  report one (every non-OpenRouter provider, and OpenRouter itself if it ever
 *  omits the field). Never coerces a missing figure to 0. */
export function providerCostFromMetadata(
  meta: Record<string, Record<string, unknown>> | undefined | null,
): number | undefined {
  const cost = meta?.[OPENROUTER_METADATA_KEY]?.costUsd;
  return typeof cost === 'number' && Number.isFinite(cost) ? cost : undefined;
}

/** Below this the provider's own rounding is a large fraction of the figure, so
 *  the ratio below says more about rounding than about our arithmetic. A tenth
 *  of a cent. */
export const COST_COMPARE_FLOOR_USD = 0.001;

/** How far apart the two figures may drift before it is worth a diagnostic line.
 *
 *  CHOSEN, NOT MEASURED. Two things can make an honest gap: per-model price
 *  overrides (some models charge more above a very large prompt) are not
 *  modelled here, and providers round. The design spec expects a few percent
 *  from those; 5% sits above that band, so crossing it means something
 *  structural rather than rounding. Nobody has yet compared these two numbers
 *  on a real billed turn — when someone does, this is the constant to revisit. */
export const COST_DISAGREEMENT_THRESHOLD = 0.05;

/** How far our figure sits from the provider's, as a fraction of the
 *  provider's — or `null` when there is nothing honest to compare.
 *
 *  null covers three genuinely different situations, and NONE of them is
 *  agreement: the provider reported nothing (every non-OpenRouter provider),
 *  we have no figure of our own (no published rate, or a free model), or the
 *  bill is below the rounding floor. A caller that treats null as "matched"
 *  has the bug this function exists to prevent.
 *
 *  Denominator is the PROVIDER's figure because it is the authority; ours is
 *  the number on trial. Symmetric in direction — over-reporting is as wrong as
 *  under-reporting. */
export function costDisagreement(
  ours: number | null | undefined,
  theirs: number | undefined,
): number | null {
  if (theirs === undefined || ours == null) return null;
  if (theirs < COST_COMPARE_FLOOR_USD) return null;
  return Math.abs(theirs - ours) / theirs;
}
