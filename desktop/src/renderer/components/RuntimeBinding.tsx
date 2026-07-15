import React, { useEffect, useState } from 'react';
import { isAndroid, isRemoteMode } from '../platform';

// Shared "Runtime" selector (Claude Code vs the YouCoded native harness) + the
// native provider/model binding picker, used by BOTH new-session forms — the
// SessionStrip dropdown AND the app-open welcome screen. Extracted so the two
// forms can never drift on native-session creation logic.
//
// Split into a hook (all the state + derivation) and a presentational component
// (the Runtime toggle + provider/model selects). The parent owns `runtime` so it
// can hide ITS OWN Claude-alias model selector when the native runtime is chosen
// (that selector's styling differs per form, so it stays form-local).

export type Runtime = 'claude' | 'native';
export interface Binding { providerId: string; modelId: string }

interface ProviderRow { id: string; type: string; label: string; ready: boolean }
interface CatalogRow { id: string; providerId: string; label: string }

// Seed the binding picker from the last-used choice so it sticks across sessions.
export function loadLastBinding(): Binding | null {
  try {
    const raw = localStorage.getItem('youcoded-last-binding');
    if (raw) {
      const b = JSON.parse(raw);
      if (b && typeof b.providerId === 'string' && typeof b.modelId === 'string') return b;
    }
  } catch { /* corrupt entry — ignore */ }
  return null;
}

// Persist the effective binding on a successful native create (both forms call this).
export function persistLastBinding(binding: Binding): void {
  try { localStorage.setItem('youcoded-last-binding', JSON.stringify(binding)); } catch { /* storage full/blocked — non-fatal */ }
}

// Native runtime is desktop-only AND gated on the capability flag — with a single
// runtime there's nothing to select, so the whole selector hides.
export function isNativeSupported(): boolean {
  return !isAndroid() && !isRemoteMode() && (window as any).claude?.native?.supported === true;
}

export interface NativeBinding {
  nativeSupported: boolean;
  readyProviders: ProviderRow[];
  modelCatalog: CatalogRow[];
  selectedProviderId: string;
  selectedProvider: ProviderRow | undefined;
  providerModels: CatalogRow[];
  needsFreeformModel: boolean;
  selectedModelId: string;
  effectiveBinding: Binding | null;
  /** True when the native runtime is chosen but no usable provider/binding exists. */
  nativeCreateBlocked: boolean;
}

// All derived binding state. Pure derivation (no state writes) apart from the one
// lazy fetch effect, so there's no update loop — the parent reads the returned
// values directly during render.
export function useNativeBinding({ active, runtime, binding, setBinding }: {
  active: boolean;              // the new-session form is open (gates the fetch)
  runtime: Runtime;
  binding: Binding | null;
  setBinding: (b: Binding) => void;
}): NativeBinding & { setBinding: (b: Binding) => void } {
  const nativeSupported = isNativeSupported();
  const [providersList, setProvidersList] = useState<ProviderRow[]>([]);
  const [modelCatalog, setModelCatalog] = useState<CatalogRow[]>([]);

  // Load providers + catalog when the native runtime is selected in an open form.
  useEffect(() => {
    if (!nativeSupported || runtime !== 'native' || !active) return;
    let cancelled = false;
    Promise.all([
      window.claude.providers.list().catch(() => []),
      window.claude.providers.catalog().catch(() => []),
    ]).then(([list, cat]) => {
      if (cancelled) return;
      setProvidersList(Array.isArray(list) ? (list as ProviderRow[]) : []);
      setModelCatalog(Array.isArray(cat) ? (cat as CatalogRow[]) : []);
    });
    return () => { cancelled = true; };
  }, [nativeSupported, runtime, active]);

  const readyProviders = providersList.filter((p) => p.ready);
  const selectedProviderId = (binding && readyProviders.some((p) => p.id === binding.providerId))
    ? binding.providerId
    : (readyProviders[0]?.id ?? '');
  const selectedProvider = readyProviders.find((p) => p.id === selectedProviderId);
  const providerModels = modelCatalog.filter((m) => m.providerId === selectedProviderId);
  // openai-compatible endpoints (Ollama, LM Studio, custom) may expose no catalog
  // rows — let the user type the model id directly.
  const needsFreeformModel = selectedProvider?.type === 'openai-compatible' && providerModels.length === 0;
  // Validate the stored/selected modelId against the catalog (mirrors the
  // providerId guard) so a stale id on a still-ready provider whose catalog no
  // longer lists it can't create a session bound to a model the <select> can't
  // display. Freeform ids pass through as typed.
  const selectedModelId = (binding && binding.providerId === selectedProviderId && binding.modelId
    && (needsFreeformModel || providerModels.some((m) => m.id === binding.modelId)))
    ? binding.modelId
    : (providerModels[0]?.id ?? '');
  // Trimmed only at the boundary (never on the displayed value) — a whitespace-only
  // freeform entry is truthy but not a real model, so it must NOT pass the gate.
  const resolvedModelId = selectedModelId.trim();
  const effectiveBinding = selectedProviderId && resolvedModelId
    ? { providerId: selectedProviderId, modelId: resolvedModelId }
    : null;
  const nativeCreateBlocked = runtime === 'native' && (readyProviders.length === 0 || !effectiveBinding);

  return {
    nativeSupported, readyProviders, modelCatalog, selectedProviderId, selectedProvider,
    providerModels, needsFreeformModel, selectedModelId, effectiveBinding, nativeCreateBlocked, setBinding,
  };
}

// The Runtime toggle + (when native is chosen) the provider/model picker.
// Self-gates on native support — renders nothing when there's only one runtime.
export function RuntimeBindingFields({
  runtime, onRuntime, nb,
}: {
  runtime: Runtime;
  onRuntime: (r: Runtime) => void;
  nb: NativeBinding & { setBinding: (b: Binding) => void };
}) {
  if (!nb.nativeSupported) return null;
  return (
    <>
      <div>
        <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Runtime</label>
        <div className="inline-flex rounded border border-edge overflow-hidden">
          <button
            type="button"
            onClick={() => onRuntime('claude')}
            className={`px-3 py-1 text-xs ${runtime === 'claude' ? 'bg-accent text-on-accent' : 'bg-panel text-fg hover:bg-inset'}`}
          >
            Claude Code
          </button>
          <button
            type="button"
            onClick={() => onRuntime('native')}
            className={`px-3 py-1 text-xs ${runtime === 'native' ? 'bg-accent text-on-accent' : 'bg-panel text-fg hover:bg-inset'}`}
          >
            YouCoded
          </button>
        </div>
      </div>

      {runtime === 'native' && (
        <div className="flex flex-col gap-2">
          {nb.readyProviders.length === 0 ? (
            <p className="text-[10px] text-fg-faint">Add a provider key in Settings → Model Providers first.</p>
          ) : (
            <>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Provider</label>
                <select
                  value={nb.selectedProviderId}
                  onChange={(e) => {
                    const pid = e.target.value;
                    const firstModel = nb.modelCatalog.find((m) => m.providerId === pid)?.id ?? '';
                    nb.setBinding({ providerId: pid, modelId: firstModel });
                  }}
                  className="w-full bg-inset text-fg text-xs rounded-sm px-2 py-1 border border-edge"
                >
                  {nb.readyProviders.map((p) => (
                    <option key={p.id} value={p.id}>{p.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-[10px] uppercase tracking-wider text-fg-muted mb-1 block">Model</label>
                {nb.needsFreeformModel ? (
                  <input
                    type="text"
                    value={nb.selectedModelId}
                    placeholder="e.g. llama3.1"
                    onChange={(e) => nb.setBinding({ providerId: nb.selectedProviderId, modelId: e.target.value })}
                    className="w-full bg-inset text-fg text-xs rounded-sm px-2 py-1 border border-edge"
                  />
                ) : (
                  <select
                    value={nb.selectedModelId}
                    onChange={(e) => nb.setBinding({ providerId: nb.selectedProviderId, modelId: e.target.value })}
                    className="w-full bg-inset text-fg text-xs rounded-sm px-2 py-1 border border-edge"
                  >
                    {nb.providerModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.label}</option>
                    ))}
                  </select>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}
