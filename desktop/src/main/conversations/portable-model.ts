// desktop/src/main/conversations/portable-model.ts
// Task 4: resolves a native session's CURRENT model binding into the store's
// PORTABLE shape (design §5). ModelBinding.providerId is a local ULID —
// meaningless on a peer device (that device's providers.json has its own ids
// for what may be the "same" provider) — so the store must persist the
// provider's TYPE + LABEL instead, resolved via the registry listing.
//
// Split out of ipc-handlers.ts specifically so it's unit-testable: registering
// the real handlers needs a NativeSessionHost + ProviderRegistry, both of
// which require Electron `app` / userData wiring that isn't worth faking just
// to test this one lookup. ipc-handlers.ts wraps this in a thin async
// `resolvePortableModel(sessionId)` closure over the live nativeHost/registry.
import type { ModelBinding, ProviderStatus } from '../../shared/provider-types';
import type { PortableModelRef } from './store-core';

export function bindingToPortableModel(
  binding: ModelBinding | null,
  providers: ProviderStatus[],
): PortableModelRef | null {
  if (!binding) return null; // no live binding — session isn't native, or the id is unknown to the host
  const row = providers.find((p) => p.id === binding.providerId);
  if (!row) return null; // provider vanished from the registry between binding and now — never guess a label
  return { modelId: binding.modelId, providerType: row.type, providerLabel: row.label };
}
