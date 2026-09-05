// The ChatGPT-plan request shape (backend design §4.2). One `wrapLanguageModel`
// middleware sits between the harness and `@ai-sdk/openai`'s Responses model so
// every request to https://chatgpt.com/backend-api/codex/responses carries what
// that endpoint insists on — and the harness never learns the provider is
// special. Nothing here talks to the network; the credential lives in
// `ChatGptAuth.fetch()` (chatgpt-auth.ts), which the registry hands the SDK.
//
// Why a middleware and not a custom client: the SDK's Responses path already
// serialises `store`, `include`, `instructions`, `prompt_cache_key` and
// `stream: true` from its provider options. All we do is fill those options in
// and translate the one call shape the endpoint refuses.
import type { LanguageModelMiddleware } from 'ai';
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Content,
  LanguageModelV4FinishReason,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4ResponseMetadata,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
  SharedV4ProviderMetadata,
  SharedV4Warning,
} from '@ai-sdk/provider';

/** What the model is told when the harness sends no system text at all. The
 *  endpoint refuses an EMPTY `instructions`, so a sentence is always sent. */
export const CHATGPT_DEFAULT_INSTRUCTIONS = "You are YouCoded's assistant.";

/** Reasoning comes back encrypted from this endpoint; asking for it is what
 *  lets a later step carry it. The SDK adds this itself for `store: false` on
 *  a model it knows is a reasoning model — redundant there, load-bearing on
 *  any id it does not recognise (the plan's manifest names new ones first). */
const ENCRYPTED_REASONING = 'reasoning.encrypted_content';

/** The `providerOptions.openai` fields this middleware owns. Typed loosely on
 *  purpose: the SDK parses them with its own zod schema at call time, and the
 *  keys here are the documented ones (store / include / instructions /
 *  promptCacheKey / systemMessageMode in @ai-sdk/openai's responses options). */
type OpenAIResponsesOptions = Record<string, unknown> & { include?: unknown };

/**
 * Builds the middleware. `cacheKey` is the harness session id (§4.2): the
 * endpoint caches the shared prefix of a conversation under it, so every step
 * of one session must send the same key.
 */
export function chatGptMiddleware(cacheKey?: string): LanguageModelMiddleware {
  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => transformParams(params, cacheKey),
    // Phase 0 P0-5: a non-streaming call is refused outright (HTTP 400
    // "Stream must be set to true"). The harness always streams, but the
    // auto-title feeder calls `generateText`, which does not — without this
    // every ChatGPT-bound session would stay "New Session" forever, and
    // silently, because the feeder skips a model it cannot resolve. So a
    // generate call is served by streaming and folding the parts back into
    // the one-shot result shape.
    wrapGenerate: async ({ doStream }) => foldStream(await doStream()),
  };
}

/** Pure: the params rewrite, exported so a test can pin it without a model. */
export function transformParams(
  params: LanguageModelV4CallOptions,
  cacheKey?: string,
): LanguageModelV4CallOptions {
  // The endpoint does not accept a system-role input item; the same text has
  // to travel in the top-level `instructions` field instead. Gather every
  // system message (the harness sends one; a caller composing more gets them
  // joined in order), and fall back to the fixed sentence when there is none.
  const systemTexts = params.prompt
    .filter((m): m is Extract<LanguageModelV4Prompt[number], { role: 'system' }> => m.role === 'system')
    .map((m) => m.content.trim())
    .filter((t) => t.length > 0);
  const instructions = systemTexts.length > 0 ? systemTexts.join('\n\n') : CHATGPT_DEFAULT_INSTRUCTIONS;
  // Drop the system messages from the prompt ourselves AND tell the SDK to
  // remove them: the SDK's `remove` mode is what §4.2 pins, but on its own it
  // logs a "system messages are removed for this model" warning on every
  // call. An already-clean prompt keeps the console quiet.
  const prompt = params.prompt.filter((m) => m.role !== 'system');

  const existing = (params.providerOptions?.openai ?? {}) as OpenAIResponsesOptions;
  // Keep anything the caller already asked for in `include` and add ours once.
  const include = Array.isArray(existing.include) ? [...(existing.include as unknown[])] : [];
  if (!include.includes(ENCRYPTED_REASONING)) include.push(ENCRYPTED_REASONING);

  const openai: OpenAIResponsesOptions = {
    ...existing,
    // The endpoint refuses `store: true`; the app keeps its own transcript.
    store: false,
    instructions,
    systemMessageMode: 'remove',
    include,
    ...(cacheKey ? { promptCacheKey: cacheKey } : {}),
  };
  return {
    ...params,
    prompt,
    providerOptions: { ...params.providerOptions, openai: openai as never },
  };
}

/**
 * Runs a stream to completion and returns what a non-streaming call would
 * have: the ordered content, the finish reason, usage, warnings and response
 * metadata. Text and reasoning parts arrive as start/delta/end triples keyed
 * by id and are joined back into one part each; tool calls and everything
 * else already arrive whole and are kept in order. An `error` part is thrown,
 * which is what a failed one-shot call does too.
 */
export async function foldStream(result: {
  stream: ReadableStream<LanguageModelV4StreamPart>;
  request?: { body?: unknown };
  response?: { headers?: Record<string, string> };
}): Promise<LanguageModelV4GenerateResult> {
  const content: LanguageModelV4Content[] = [];
  // Open text/reasoning parts by stream id → the content entry being filled.
  const open = new Map<string, { type: 'text' | 'reasoning'; text: string; providerMetadata?: SharedV4ProviderMetadata }>();
  let finishReason: LanguageModelV4FinishReason = { unified: 'other', raw: undefined };
  let usage: LanguageModelV4Usage = {
    inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: undefined, text: undefined, reasoning: undefined },
  };
  let providerMetadata: SharedV4ProviderMetadata | undefined;
  let warnings: SharedV4Warning[] = [];
  let response: LanguageModelV4ResponseMetadata | undefined;

  const reader = result.stream.getReader();
  // Set only when the loop reached the end of the stream on its own. If we
  // leave early (an `error` part throws), the network connection underneath is
  // still open: just letting go of the reader leaves the socket held until the
  // garbage collector happens to notice, so a run of failed titles can pile up
  // dead connections. Cancelling closes it there and then.
  let drained = false;
  try {
    while (true) {
      const { done, value: part } = await reader.read();
      if (done) { drained = true; break; }
      switch (part.type) {
        case 'stream-start':
          warnings = part.warnings;
          break;
        case 'response-metadata': {
          const { type: _t, ...meta } = part;
          response = { ...response, ...meta };
          break;
        }
        case 'text-start':
        case 'reasoning-start': {
          const entry = {
            type: part.type === 'text-start' ? 'text' as const : 'reasoning' as const,
            text: '',
            ...(part.providerMetadata ? { providerMetadata: part.providerMetadata } : {}),
          };
          open.set(part.id, entry);
          // Push now so the part keeps its place in the order it started.
          content.push(entry);
          break;
        }
        case 'text-delta':
        case 'reasoning-delta': {
          const entry = open.get(part.id);
          if (entry) {
            entry.text += part.delta;
            if (part.providerMetadata) entry.providerMetadata = { ...entry.providerMetadata, ...part.providerMetadata };
          }
          break;
        }
        case 'text-end':
        case 'reasoning-end': {
          const entry = open.get(part.id);
          if (entry && part.providerMetadata) entry.providerMetadata = { ...entry.providerMetadata, ...part.providerMetadata };
          open.delete(part.id);
          break;
        }
        case 'tool-input-start':
        case 'tool-input-delta':
        case 'tool-input-end':
          // Streaming-only progress for a tool call; the whole call follows as
          // a `tool-call` part, which is the one a generate result carries.
          break;
        case 'finish':
          finishReason = part.finishReason;
          usage = part.usage;
          if (part.providerMetadata) providerMetadata = part.providerMetadata;
          break;
        case 'raw':
          break;
        case 'error':
          throw part.error instanceof Error ? part.error : new Error(String(part.error));
        default:
          // tool-call, tool-result, tool-approval-request, file, source,
          // reasoning-file, custom — already complete parts, kept in order.
          content.push(part as LanguageModelV4Content);
      }
    }
  } finally {
    // cancel() also releases the lock, so it is one or the other. Its own
    // failure is ignored on purpose: we are already on the way out, and a
    // complaint from the cancel would replace the real reason we stopped.
    if (drained) reader.releaseLock();
    else await reader.cancel().catch(() => { /* already gone */ });
  }

  return {
    content,
    finishReason,
    usage,
    warnings,
    ...(providerMetadata ? { providerMetadata } : {}),
    ...(result.request ? { request: result.request } : {}),
    ...(response || result.response?.headers
      ? { response: { ...response, ...(result.response?.headers ? { headers: result.response.headers } : {}) } }
      : {}),
  };
}
