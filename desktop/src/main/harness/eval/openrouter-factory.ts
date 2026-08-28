// A ModelFactory for the review runner.
//
// WHY this is separate from provider-registry.ts: that module reads the app's
// safeStorage-encrypted keys and its own ~/.youcoded/providers.json. The runner
// must never touch either — it is a test tool that has to stay clear of Destin's
// live app data (.claude/rules/live-app-safety.md). One env var, one endpoint.
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { ModelFactory } from '../harness-session';

const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function makeOpenRouterFactory(apiKey: string, modelId: string): ModelFactory {
  if (!apiKey) {
    throw new Error('No OpenRouter key. Set OPENROUTER_API_KEY in your environment before running the review battery.');
  }
  // No `includeUsage: true`, for the same reason the app's own OpenRouter
  // branch dropped it (provider-registry.ts): the SDK turns that flag into
  // `stream_options: { include_usage: true }` and nothing else (verified in
  // @ai-sdk/openai-compatible@3.0.14), which is the exact parameter
  // OpenRouter's Usage Accounting docs call deprecated and inert — full usage
  // details come back on every response without being asked. Harmless on the
  // wire either way; keeping it here would have left the repo passing a
  // documented no-op in one file while explaining in another why it must not.
  const provider = createOpenAICompatible({
    name: 'openrouter',
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
  });
  // The binding argument is ignored: the runner pins one model per session, and
  // accepting a binding here would let a roster typo silently run a different one.
  // No `as any`: provider(modelId) returns LanguageModelV4, a member of `ai`'s
  // LanguageModel union that ModelFactory expects — provider-registry.ts:249-255
  // makes the identical call with no cast.
  return async () => provider(modelId);
}
