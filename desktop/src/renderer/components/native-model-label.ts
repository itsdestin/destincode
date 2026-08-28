// src/renderer/components/native-model-label.ts
//
// Turns a native-runtime model id into a short human label for the StatusBar
// model chip. Native sessions bind to arbitrary provider model ids (OpenRouter
// slugs, models.dev ids, local GGUF filenames, or whatever a user typed into an
// openai-compatible endpoint), so there is no fixed alias list to match against
// the way Claude Code sessions have (StatusBar's MODELS).
//
// Why a local heuristic instead of the picker's catalog labels: ModelCatalog is
// network-backed (OpenRouter /api/v1/models + models.dev) behind a TTL'd disk
// cache, it's async, it returns [] when no provider keys are set, and it has NO
// rows at all for openai-compatible custom endpoints (the user types the id by
// hand). A status chip that goes blank offline — or permanently blank on a
// custom endpoint — is worse than an approximate label. The exact catalog label
// stays where an async fetch and an empty state are already handled: the picker.
//
// The label is best-effort by design. Every caller MUST also surface the raw id
// (the chip puts it in `title`), so an imperfect prettification is never lossy.
import { stripSplitSuffix } from '../../shared/gguf-split';

/**
 * Quantization / precision suffix on local GGUF builds — noise in a chip.
 *
 * Matched against the WHOLE trailing suffix rather than a post-split token,
 * because quant tags carry their own `_` separators (`Q4_K_M`) and splitting
 * first shreds them into `Q4`/`K`/`M`, which no per-token pattern can recognize.
 * The leading `(?:^|[-_])` lets an id that is ONLY a quant tag match too, and
 * the optional `UD-` covers unsloth dynamic quants (`UD-Q4_K_XL`) — without it
 * the tag's own prefix survived as a bare "UD" token in the chip.
 */
const QUANT_SUFFIX = /(?:^|[-_])(?:UD[-_])?(?:I?Q\d+(?:_[A-Z0-9]+)*|[BF]F?16|F32|FP\d+)$/i;

/** Format tags that DO survive as standalone tokens after splitting. */
const FORMAT_TOKEN = /^(?:GGUF|MLX)$/i;

/** Weight-file extensions to drop before splitting. */
const EXT = /\.(?:gguf|bin|safetensors|pt|pth)$/i;

/** Tokens that should render upper-case rather than title-case. */
const ACRONYMS = new Set(['gpt', 'ai', 'llm', 'moe', 'vl', 'r1', 'qwq', 'sdk', 'oss']);

/**
 * Vendor words that add nothing once the chip is already scoped to a model.
 * `claude-sonnet-5` → "Sonnet 5", matching how the Claude Code chip renders a
 * bare "Sonnet". Only stripped in LEADING position, so a model genuinely named
 * e.g. `foo-claude` keeps it.
 */
const LEADING_NOISE = new Set(['claude', 'models', 'model']);

/** Title-case one token, preserving anything that already carries case/digits
 *  (`30B`, `A3B`, `Qwen3`, `4.5`) — lowercasing those reads as a typo. */
function titleToken(tok: string): string {
  if (ACRONYMS.has(tok.toLowerCase())) return tok.toUpperCase();
  // Already mixed-case or contains a digit → the author's casing is intentional.
  if (/[A-Z]/.test(tok) || /\d/.test(tok)) {
    // Bare lowercase-with-digits (`gemini3`) still wants a capital.
    return /^[a-z]/.test(tok) ? tok[0].toUpperCase() + tok.slice(1) : tok;
  }
  return tok[0].toUpperCase() + tok.slice(1);
}

/**
 * `anthropic/claude-sonnet-5` → `Sonnet 5`
 * `Qwen3-30B-A3B-Q4_K_M.gguf` → `Qwen3 30B A3B`
 *
 * Returns '' only for an empty/whitespace id — callers treat that as "no model
 * bound" rather than rendering an empty chip.
 */
export function nativeModelLabel(modelId: string | undefined | null): string {
  if (!modelId) return '';

  // 1. Drop the vendor/org prefix: OpenRouter ids are `org/model`, and a local
  //    path-like id may carry several segments. The last one is the model.
  const tail = modelId.split('/').filter(Boolean).pop() ?? '';
  if (!tail) return '';

  // 2. Drop a weight-file extension, then the -00001-of-00004 split marker: a
  //    split GGUF is one model, and the part numbers are pure machine detail.
  const bare = stripSplitSuffix(tail.replace(EXT, ''));

  // 3. Strip the quantization suffix BEFORE splitting — see QUANT_SUFFIX. Loop
  //    because stacked tags exist in the wild (`…-Q4_K_M-F16`).
  let trimmed = bare;
  for (;;) {
    const next = trimmed.replace(QUANT_SUFFIX, '');
    if (next === trimmed) break;
    trimmed = next;
  }

  // 4. Split on separators, preserving dotted version numbers (e.g. 4-6 → 4.6)
  //    when a standalone single digit follows a separator and another single digit.
  let normalized = trimmed.replace(/\b(\d+)[-_]+(\d+)\b/g, '$1.$2');
  let tokens = normalized.split(/[-_]+/).filter(Boolean).filter((t) => !FORMAT_TOKEN.test(t));

  // 5. Strip leading vendor noise (only leading — see LEADING_NOISE).
  while (tokens.length > 1 && LEADING_NOISE.has(tokens[0].toLowerCase())) tokens.shift();

  // Everything was noise (e.g. a bare `Q4_K_M`) — fall back to the raw tail so
  // the chip says SOMETHING recognizable rather than going blank.
  if (tokens.length === 0) return bare;

  return tokens.map(titleToken).join(' ');
}
