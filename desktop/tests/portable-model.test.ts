// Pins bindingToPortableModel — the pure core of ipc-handlers.ts's
// resolvePortableModel helper (Task 4). Split into its own module so this is
// testable without constructing a NativeSessionHost or a real ProviderRegistry
// (both need Electron `app` / userData wiring) — see portable-model.ts's WHY
// comment and ipc-handlers.ts's thin async wrapper around it.
import { describe, it, expect } from 'vitest';
import { bindingToPortableModel } from '../src/main/conversations/portable-model';
import type { ModelBinding, ProviderStatus } from '../src/shared/provider-types';

function provider(over: Partial<ProviderStatus>): ProviderStatus {
  return {
    id: 'prov-1', type: 'local-engine' as any, label: 'Local models (llama.cpp)',
    enabled: true, builtIn: true, hasKey: true, ready: true, ...over,
  };
}

describe('bindingToPortableModel', () => {
  it('resolves a live binding + matching provider row into the portable shape', () => {
    const binding: ModelBinding = { providerId: 'prov-1', modelId: 'qwen-3' };
    const providers = [provider({ id: 'prov-1', type: 'local-engine' as any, label: 'Local models (llama.cpp)' })];
    expect(bindingToPortableModel(binding, providers)).toEqual({
      modelId: 'qwen-3', providerType: 'local-engine', providerLabel: 'Local models (llama.cpp)',
    });
  });

  it('returns null when there is no live binding (session not native / unknown id)', () => {
    expect(bindingToPortableModel(null, [provider({})])).toBeNull();
  });

  it('returns null (never guesses) when the binding points at a provider missing from the registry listing', () => {
    const binding: ModelBinding = { providerId: 'vanished', modelId: 'qwen-3' };
    expect(bindingToPortableModel(binding, [provider({ id: 'prov-1' })])).toBeNull();
  });

  it('picks the row matching providerId, not just the first row, when multiple providers are configured', () => {
    const binding: ModelBinding = { providerId: 'prov-2', modelId: 'gpt-x' };
    const providers = [
      provider({ id: 'prov-1', type: 'local-engine' as any, label: 'Local models (llama.cpp)' }),
      provider({ id: 'prov-2', type: 'openai' as any, label: 'My OpenAI key' }),
    ];
    expect(bindingToPortableModel(binding, providers)).toEqual({
      modelId: 'gpt-x', providerType: 'openai', providerLabel: 'My OpenAI key',
    });
  });
});
