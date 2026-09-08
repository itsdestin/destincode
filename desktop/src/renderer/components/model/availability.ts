import { useEffect, useState } from 'react';
import { CLAUDE_ALIASES } from '../../../shared/model-ids';
import type { ModelChoice } from './ModelPicker';

// WHY THIS FILE EXISTS (Destin, deck 2026-09-07, P-1 / P-3 / Q-E).
//
// Three surfaces have to agree on one question — "can this install actually run
// that model right now?":
//   · the model menu, which now LISTS what it cannot run, greyed, with a reason
//     rather than hiding it (Q-E a);
//   · Assistant settings' Default model row, which keeps naming your choice and
//     says it is being ignored rather than erasing it (P-1 a, P-2 note);
//   · the new-session forms, which start with nothing chosen rather than
//     substituting a model you did not pick (P-3 b).
//
// One pure answer, three readers. Two of them already hold the provider list and
// the catalog, so the judgement is a plain function over data the caller has,
// not a fourth fetch.

export interface ProviderRow {
  id: string;
  type: string;
  label: string;
  ready: boolean;
  /** Present on the real bridge reply; absent in older fixtures. */
  enabled?: boolean;
  hasKey?: boolean;
}

export interface CatalogRow { id: string; providerId: string; label: string }

export interface AvailabilityData {
  providers: ProviderRow[];
  catalog: CatalogRow[];
  /** Whether Claude Code itself can start a conversation on this install. */
  claudeReady: boolean;
}

/** Why this provider cannot serve a model right now — the words shown on the
 *  greyed row. Short enough to sit at the end of a model row. */
export function providerReason(p: ProviderRow): string {
  if (p.enabled === false) return 'Turned off';
  if (p.type === 'chatgpt') return 'Sign in to use';
  if (p.type === 'local-engine') return 'Set up local models';
  return 'Add an API key';
}

/** A provider with no catalog of its own (Ollama, LM Studio, a custom endpoint):
 *  any model id the user types is legitimate, so a missing catalog row is not a
 *  missing model. */
function isFreeform(p: ProviderRow, catalog: CatalogRow[]): boolean {
  return p.type === 'openai-compatible' && !catalog.some((c) => c.providerId === p.id);
}

/**
 * The reason this choice cannot be used, or null when it can.
 *
 * Deliberately never repairs anything: it reports. Every caller shows the
 * reason instead of quietly moving the user to a model they did not choose,
 * which is the rule Destin set on 2026-09-07 ("nothing should be overridden").
 */
export function unavailableReason(choice: ModelChoice | null | undefined, d: AvailabilityData): string | null {
  if (!choice) return null;
  if (choice.runtime === 'claude') {
    if (!(CLAUDE_ALIASES as readonly string[]).includes(choice.alias)) return 'No longer available';
    return d.claudeReady ? null : 'Sign in to use';
  }
  const p = d.providers.find((x) => x.id === choice.providerId);
  if (!p) return 'No longer set up';
  if (!p.ready) return providerReason(p);
  if (isFreeform(p, d.catalog)) return null;
  return d.catalog.some((c) => c.providerId === p.id && c.id === choice.modelId)
    ? null
    : 'No longer in the model list';
}

/**
 * Is Claude Code signed in on this install?
 *
 * WHY the optimistic default: this is read through the same untyped first-run
 * bridge the Cloud providers page uses, and it is absent in the workbench and on
 * hosts that never had a first run. Greying every Claude model because a status
 * call did not answer would be the app inventing a problem — so unknown means
 * available, and only a definite "signed in with ChatGPT / not finished" greys
 * them out. `authComplete` alone is not enough: it is set by ANY finished
 * sign-in, ChatGPT included (ModelProvidersPopup.tsx:132).
 */
export function useClaudeReady(): boolean {
  const [ready, setReady] = useState(true);
  useEffect(() => {
    let alive = true;
    const fr = (window as any).claude?.firstRun;
    if (!fr?.getState) return;
    Promise.resolve(fr.getState())
      .then((s: { authComplete?: boolean; authMode?: string } | null | undefined) => {
        if (!alive || !s) return;
        setReady(s.authComplete === true && s.authMode !== 'chatgpt');
      })
      .catch(() => { /* unknown — stays available */ });
    return () => { alive = false; };
  }, []);
  return ready;
}

/**
 * The provider list, the catalog and Claude's sign-in state, fetched once for a
 * surface that has none of its own (Assistant settings' Default model row).
 *
 * `loaded` matters: before the answer arrives NOTHING may be called
 * unavailable, or the panel would accuse a perfectly good default of being
 * broken for the first frames after it opens.
 */
export function useAvailabilityData(reloadKey?: unknown): AvailabilityData & { loaded: boolean } {
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [catalog, setCatalog] = useState<CatalogRow[]>([]);
  const [loaded, setLoaded] = useState(false);
  const claudeReady = useClaudeReady();
  useEffect(() => {
    let cancelled = false;
    const api = (window as any).claude?.providers;
    if (!api?.list || !api?.catalog) { setLoaded(true); return; }
    Promise.all([
      api.list().catch(() => []),
      api.catalog().catch(() => []),
    ]).then(([list, cat]: [any, any]) => {
      if (cancelled) return;
      setProviders(Array.isArray(list) ? list : []);
      setCatalog(Array.isArray(cat) ? cat : []);
      setLoaded(true);
    }).catch(() => { if (!cancelled) setLoaded(true); });
    return () => { cancelled = true; };
  }, [reloadKey]);
  return { providers, catalog, claudeReady, loaded };
}
