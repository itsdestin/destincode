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
  const provider = createOpenAICompatible({
    name: 'openrouter',
    baseURL: OPENROUTER_BASE_URL,
    apiKey,
    includeUsage: true,
  });
  // The binding argument is ignored: the runner pins one model per session, and
  // accepting a binding here would let a roster typo silently run a different one.
  // No `as any`: provider(modelId) returns LanguageModelV4, a member of `ai`'s
  // LanguageModel union that ModelFactory expects — provider-registry.ts:249-255
  // makes the identical call with no cast.
  return async () => provider(modelId);
}
