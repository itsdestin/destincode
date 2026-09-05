import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isAndroid, isRemoteMode } from '../platform';
import { PRESETS } from '../../shared/harness-manifest';
import { Callout, Checkbox } from './ui';

// The two built-in native harness presets (personality profiles, not capability
// tiers). A native session is stamped with one at create time; it drives the
// session's starting permission posture + prompt personality.
export type PresetId = 'assistant' | 'coder';

/** Spec §3.4 heuristic: a project folder set at form-open → Coder, else Assistant.
 *  Both new-session forms seed the preset from this until the user picks one. */
function defaultPresetFor(cwd: string): PresetId { return cwd.trim() ? 'coder' : 'assistant'; }

// Preset lifecycle (spec §3.4): follow the folder heuristic (folder set → Coder,
// empty → Assistant) UNTIL the user explicitly picks a card, then latch. Lifted
// here so both new-session forms share ONE implementation (the whole reason
// RuntimeBinding exists) — a per-form copy already drifted on the re-arm bug (I2):
// the old code re-armed by resetting a `touched` ref AND setting cwd back to the
// default folder, relying on a cwd-change to re-run a `useEffect([cwd])`. But
// after the first create the folder is ALREADY the default, so `setCwd(same)`
// caused no state change → the effect didn't re-run → the user's last manual pick
// stuck even though `touched` was cleared. The fix keys the re-arm on `active`
// (form open) transitioning false→true and re-derives EXPLICITLY from the current
// cwd, so an unchanged cwd can no longer trap it.
export function usePreset({ active, cwd }: { active: boolean; cwd: string }): {
  preset: PresetId;
  setPreset: (p: PresetId) => void;   // marks touched (latches the manual pick)
} {
  const [preset, setPresetState] = useState<PresetId>(() => defaultPresetFor(cwd));
  // Has the user manually picked a card this open? While false, `preset` tracks
  // the folder heuristic; once true, the manual pick sticks even if cwd changes.
  const touched = useRef(false);
  // Previous `active`, so we can detect the false→true (fresh open) edge.
  const prevActive = useRef(active);

  // Track the folder heuristic while the user hasn't picked. Pure derivation from
  // cwd (no state writes when touched) — can't loop (dep is only cwd).
  useEffect(() => {
    if (!touched.current) setPresetState(defaultPresetFor(cwd));
  }, [cwd]);

  // Re-arm on each fresh OPEN: when the form goes closed→open, drop the latch and
  // re-derive from the CURRENT cwd DIRECTLY. Keyed on `active` (not cwd), so the
  // "cwd unchanged after create" trap that broke the per-form copies can't recur —
  // this always fires on open regardless of whether cwd moved.
  useEffect(() => {
    if (active && !prevActive.current) {
      touched.current = false;
      setPresetState(defaultPresetFor(cwd));
    }
    prevActive.current = active;
    // cwd is intentionally read but NOT a dependency: the re-arm must trigger on
    // the `active` edge alone, using whatever cwd is current at that commit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const setPreset = useCallback((p: PresetId) => {
    touched.current = true;   // latch — the heuristic stops overriding this pick
    setPresetState(p);
  }, []);

  return { preset, setPreset };
}

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
function isNativeSupported(): boolean {
  return !isAndroid() && !isRemoteMode() && (window as any).claude?.native?.supported === true;
}

// Create-time memory-fit verdict for a local-engine model (from main's
// models.memoryCheck). 'too-large' blocks create; 'tight' is a warning.
export interface MemVerdict { verdict: 'ok' | 'tight' | 'too-large'; headline: string; detail: string }

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
  /** True when the native runtime is chosen but no usable provider/binding exists
   *  OR the selected local model is too large to fit. */
  nativeCreateBlocked: boolean;
  // Local-engine memory guard (shared by both new-session forms).
  memVerdict: MemVerdict | null;
  memDetailOpen: boolean;
  setMemDetailOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** S-2: "don't warn me again" for the selected model (remembered in main per model +
   *  context length). Undefined when the bridge has no such channel (older main). */
  memDismissed: boolean;
  dismissMemoryWarning?: (next: boolean) => void;
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
  // Local-engine memory guard (#2) — moved here from SessionStrip so BOTH
  // new-session forms enforce it.
  const [memVerdict, setMemVerdict] = useState<MemVerdict | null>(null);
  const [memDetailOpen, setMemDetailOpen] = useState(false);

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

  // Ask main whether this local model fits given what's already resident. Runs
  // only for the local-engine provider (cloud models don't consume our memory).
  // liveModels() falls back to a cache scan when the engine is off, so this is
  // cheap and never boots the engine. Decision (Destin): block only 'too-large'.
  const isLocalEngine = runtime === 'native' && selectedProviderId === 'local';
  useEffect(() => {
    let cancelled = false;
    setMemDetailOpen(false);
    if (!isLocalEngine || !resolvedModelId) { setMemVerdict(null); return; }
    (window.claude.models as any).memoryCheck?.(resolvedModelId)
      .then((v: any) => { if (!cancelled) setMemVerdict(v && v.verdict ? v : null); })
      .catch(() => { if (!cancelled) setMemVerdict(null); });
    return () => { cancelled = true; };
  }, [isLocalEngine, resolvedModelId]);
  const memBlocked = memVerdict?.verdict === 'too-large';
  // S-2: the checkbox state; main remembers the choice per model at the current
  // context length. Optimistic — the warning stays visible until the picker
  // re-opens, which is when the remembered answer takes effect.
  const [memDismissed, setMemDismissed] = useState(false);
  useEffect(() => { setMemDismissed(false); }, [resolvedModelId]);
  // Optional-chained: the SessionStrip unit tests' bridge stub has no `models` at all.
  const dismissMemoryWarning = typeof (window.claude.models as any)?.dismissMemoryWarning === 'function' && resolvedModelId
    ? (next: boolean) => {
      setMemDismissed(next);
      if (next) void (window.claude.models as any).dismissMemoryWarning(resolvedModelId);
    }
    : undefined;

  const nativeCreateBlocked = runtime === 'native' && (readyProviders.length === 0 || !effectiveBinding || memBlocked);

  return {
    nativeSupported, readyProviders, modelCatalog, selectedProviderId, selectedProvider,
    providerModels, needsFreeformModel, selectedModelId, effectiveBinding, nativeCreateBlocked,
    memVerdict, memDetailOpen, setMemDetailOpen, setBinding, memDismissed, dismissMemoryWarning,
  };
}

// The native-only extras that are NOT model selection: the harness preset and
// the local-engine memory-fit warning. Split out so the unified <ModelPicker>
// can host them without dragging in the Runtime toggle and the provider/model
// <Select> pair it replaced. Both are now deleted — all three new-session
// surfaces (SessionStrip, the welcome form, the Resume Browser) go through
// <ModelPicker>, so this is the only place the preset/memory UI lives.
export function NativeExtras({ nb, preset, onPreset }: {
  nb: NativeBinding & { setBinding: (b: Binding) => void };
  preset: PresetId;
  onPreset: (p: PresetId) => void;
}) {
  return (
    <>
      {/* Preset picker (spec §3.4): the native harness personality —
          Assistant (asks first) vs Coder (agentic, auto-edits). Both carry
          the full tool suite; they differ in prompt + starting permission
          posture. Stamped at create; drives the resolved harnessId. */}
      <div>
        <label className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1 block">Preset</label>
        <div className="flex gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => onPreset(p.id as PresetId)}
              aria-pressed={preset === p.id}
              className={`flex-1 text-left rounded border px-2 py-1.5 ${preset === p.id ? 'border-accent bg-inset' : 'border-edge bg-panel hover:bg-inset'}`}
            >
              <div className="text-xs text-fg">{p.name}</div>
              <div className="text-3xs text-fg-muted leading-snug">{p.description}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Memory guard (#2): block only when clearly too large; otherwise a
          warning with a "Show more" detail (overflow + LRU eviction).
          local-engine models only.
          2026-09-05 (deck S-2): the shared Callout replaces the hand-rolled box
          and its ⚠️/⛔ glyphs (the app's no-status-glyph rule); a 'tight' warning
          carries "Don't warn me again for this model" — remembered per model at
          the context length it was answered for, so the same warning does not
          return every time the model is picked. A 'too-large' block has no such
          box: it is not a choice. */}
      {nb.memVerdict && nb.memVerdict.verdict !== 'ok' && (
        <Callout
          tone={nb.memVerdict.verdict === 'too-large' ? 'danger' : 'warning'}
          title={nb.memVerdict.headline}
          className="text-2xs"
        >
          <button
            type="button"
            onClick={() => nb.setMemDetailOpen((o) => !o)}
            className="underline text-fg-muted hover:text-fg whitespace-nowrap"
          >
            {nb.memDetailOpen ? 'Show less' : 'Show more'}
          </button>
          {nb.memDetailOpen && (
            <p className="mt-1 text-fg-muted leading-snug">{nb.memVerdict.detail}</p>
          )}
          {nb.memVerdict.verdict === 'tight' && nb.dismissMemoryWarning && (
            <label className="mt-2 flex items-center gap-2 text-3xs text-fg-muted cursor-pointer">
              <Checkbox
                checked={nb.memDismissed}
                onChange={(next) => nb.dismissMemoryWarning?.(next)}
                aria-label="Don't warn me again for this model"
              />
              Don&rsquo;t warn me again for this model at this context length
            </label>
          )}
        </Callout>
      )}
    </>
  );
}
