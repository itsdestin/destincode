// How much of a prompt was served from cache rather than re-read.
//
// Lives in its own module (not inside StatusBar.tsx) because TWO surfaces show
// this number — the status bar's "Reuse:" chip and the Usage card's cache row —
// and they used to compute it two different ways, so they disagreed about the
// same session. One formula, one home.

/** The three counts every runtime reports, however it labels them. Structural on
 *  purpose: the Claude Code statusline's SessionStats and the native harness's
 *  NativeStatusChips both satisfy it without either importing the other. */
export interface PromptCacheCounts {
  inputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** What the cache-reuse chip renders, all resolved from ONE source. */
export interface CacheReuse {
  /** Prompt tokens served from cache instead of re-read. null = none reported. */
  readTokens: number | null;
  /** The WHOLE prompt the model read, cached portion included. */
  promptTokens: number | null;
  /** readTokens / promptTokens, clamped to 0..1. null when incomputable. */
  ratio: number | null;
}

/** How much of the prompt was served from cache rather than re-read.
 *
 *  History 1: this replaced a "hit rate" of reads/(reads+writes), which was
 *  pinned at 100% forever. That formula only means anything on providers that
 *  BILL for cache writes (Anthropic-style explicit caching). Every native
 *  provider here — OpenRouter's models and local llama.cpp — caches
 *  automatically and reports no write count at all, so the denominator
 *  collapsed to reads/reads. Verified against 507 recorded turns:
 *  cacheCreationTokens was 0 on every single one (Destin, 2026-08-16).
 *
 *  History 2 — the fix this comment block exists for. The replacement then had
 *  a SECOND denominator for Claude Code sessions, `input + read + create`, on
 *  the belief that the statusline reports Anthropic's raw-API convention where
 *  input_tokens is the UNCACHED REMAINDER. It does not. statusline.sh reads
 *  `context_window.total_input_tokens`, which is the WHOLE prompt with the
 *  cached part already counted in — so adding the reads back counted them
 *  twice and the chip could never exceed 50%. Measured across 8 live sessions
 *  on 2026-09-03: total_input_tokens equalled cache_read + cache_creation to
 *  within 2 tokens in every one, the chip read 47-50%, and real reuse was
 *  94-100%.
 *
 *  So there is now ONE denominator for both runtimes. `Math.max` rather than a
 *  bare `inputTokens` is the safety rail: if some future provider (or a future
 *  Claude Code release) really does report the uncached remainder, the parts we
 *  know are in the prompt still bound it from below, and the answer degrades by
 *  the size of that remainder instead of flipping to half. There is no cliff in
 *  it — the two branches meet exactly where they cross. */
export function selectCacheReuse(
  ss: PromptCacheCounts | null | undefined,
  nativeChips: PromptCacheCounts | null | undefined,
): CacheReuse {
  // Precedence matches the Cached: chip beside it — CC's statusline wins when it
  // has written cache numbers, native fills in otherwise. Picked as a UNIT so the
  // denominator can never be resolved from a different source than the numerator.
  const useCC = ss?.cacheReadTokens != null;
  const readTokens = useCC ? ss!.cacheReadTokens : nativeChips?.cacheReadTokens ?? null;
  const createTokens = useCC ? ss!.cacheCreationTokens : nativeChips?.cacheCreationTokens ?? null;
  const inputTokens = useCC ? ss!.inputTokens : nativeChips?.inputTokens ?? null;

  if (readTokens == null || inputTokens == null) return { readTokens, promptTokens: null, ratio: null };

  const promptTokens = Math.max(inputTokens, readTokens + (createTokens ?? 0));
  // Clamped: a provider that reports inconsistent counts should show a bounded
  // percentage, not 340%. The tooltip still prints the raw numbers, so genuinely
  // bad data stays visible instead of being silently smoothed away.
  const ratio = promptTokens > 0 ? Math.min(1, readTokens / promptTokens) : null;
  return { readTokens, promptTokens, ratio };
}

/** What the reuse chip should actually show. Kept separate from the JSX so the
 *  "don't alarm anyone on turn 1" rule is unit-testable rather than buried in a
 *  render branch. */
export type ReuseDisplay =
  | { kind: 'unknown' }                  // '--' — nothing reported cache data
  | { kind: 'first-turn' }               // 'New' — no earlier prompt to reuse yet
  | { kind: 'percent'; pct: number };

export function selectReuseDisplay(reuse: CacheReuse, turnsWithUsage: 0 | 1 | 2 | undefined): ReuseDisplay {
  if (reuse.ratio == null) return { kind: 'unknown' };
  // ?? 1, not ?? 2: an unwired caller errs toward the calm reading rather than
  // raising a red alarm it has no evidence for.
  const firstTurn = (turnsWithUsage ?? 1) <= 1;
  // Zero reuse means two very different things depending on WHEN it happens. On
  // a session's first turn there is simply no earlier prompt to reuse, which is
  // expected and should read as neutral. The same zero on turn 30 means the
  // cache stopped being hit — worth flagging, so it falls through to a red 0%.
  if (reuse.ratio === 0 && firstTurn) return { kind: 'first-turn' };
  return { kind: 'percent', pct: Math.round(reuse.ratio * 100) };
}
