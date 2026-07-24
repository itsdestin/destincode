import React, { useEffect, useRef, useState } from 'react';
import { TextInput } from './ui';
import type { ModelBinding } from '../../shared/provider-types';
import type { PortableModelRef } from '../../shared/types';

// Task 6 — the resume-time provider-scoped model selector. Extracted from
// ModelPickerPopup's native branch (catalog + providers.list() -> group by
// provider label; ModelPickerPopup.tsx:176-196,266-304) so both the Resume
// Browser's inline expanded row AND Task 9's pre-resume ("MovedGate") modal
// can host the exact same picker. This component owns NO modal chrome
// (no Scrim/OverlayPanel) — it's meant to be embedded inside whatever
// surface the caller already has open.
//
// Destin's ruling (verbatim constraint set, task-6-brief.md): native resume
// ALWAYS offers this selector, on any device; pre-filled from lastUsedModel
// ONLY when it matches a model actually available on THIS device's provider
// registry; the selection becomes the binding; never auto-launch a binding
// on the caller's behalf; no local match -> the picker opens un-prefilled,
// never an error, never a substitute for the saved model.
//
// Internal (uncontrolled) selection state: the caller only needs the
// resulting binding via onSelect, not to drive which row is highlighted, so
// there is no `value` prop — each mount owns its own selection. This also
// means a fresh mount (e.g. re-expanding a different Resume Browser row) is
// the reset mechanism instead of a key/prop the caller would have to manage.
interface CatalogModelRow {
  id: string;
  providerId: string;
  label: string;
}

interface ProviderRow {
  id: string;
  type: string;
  label: string;
}

export interface NativeModelSelectProps {
  /** Portable reference to resume-time-pre-fill from (PastSession.lastUsedModel).
   *  Matched against the LOCAL catalog by modelId + the owning provider's type —
   *  the ULID in a CatalogModel.providerId is per-device and cannot be compared
   *  directly across synced devices (see PortableModelRef's doc comment in
   *  shared/types.ts). Absent, or no local match, means no prefill. */
  prefill?: PortableModelRef;
  /** Fired once a binding is selected — either the user clicking a row, or (on
   *  first load) an automatic prefill match. Never fired for a prefill miss. */
  onSelect: (binding: ModelBinding, portable: PortableModelRef) => void;
}

export default function NativeModelSelect({ prefill, onSelect }: NativeModelSelectProps) {
  const [catalog, setCatalog] = useState<CatalogModelRow[]>([]);
  const [providers, setProviders] = useState<ProviderRow[]>([]);
  const [providerLabels, setProviderLabels] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [selected, setSelected] = useState<{ providerId: string; modelId: string } | null>(null);
  // Guards the prefill auto-select so it only ever runs once per mount, even
  // if the catalog effect were to re-run (it currently only fires on mount —
  // this is belt-and-suspenders against a future dependency change firing it
  // twice and re-selecting after the user already picked something else).
  const prefillAppliedRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      window.claude.providers.catalog().catch(() => []),
      window.claude.providers.list().catch(() => []),
    ]).then(([cat, list]: [any[], any[]]) => {
      if (cancelled) return;
      const catalogRows: CatalogModelRow[] = Array.isArray(cat) ? cat : [];
      const providerRows: ProviderRow[] = Array.isArray(list) ? list : [];
      setCatalog(catalogRows);
      setProviders(providerRows);
      const labels: Record<string, string> = {};
      for (const p of providerRows) if (p?.id) labels[p.id] = p.label ?? p.id;
      setProviderLabels(labels);
      setLoaded(true);

      // Prefill match: modelId equality among catalog rows whose OWNING
      // provider row's .type === prefill.providerType. Catalog rows only
      // carry the local ULID providerId, not a type — join through
      // providers.list() to get it. No match -> stays unselected, per the
      // ruling above (never substitute, never error).
      if (prefill && !prefillAppliedRef.current) {
        const match = catalogRows.find((m) => {
          const p = providerRows.find((row) => row.id === m.providerId);
          return !!p && p.type === prefill.providerType && m.id === prefill.modelId;
        });
        if (match) {
          prefillAppliedRef.current = true;
          const binding: ModelBinding = { providerId: match.providerId, modelId: match.id };
          setSelected(binding);
          onSelect(binding, prefill);
        }
      }
    }).catch(() => setLoaded(true));
    return () => { cancelled = true; };
    // Runs once per mount — a fresh NativeModelSelect instance per Resume
    // Browser row expansion (or per pre-resume modal open) IS the reset.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePick = (providerId: string, modelId: string) => {
    setSelected({ providerId, modelId });
    const row = providers.find((p) => p.id === providerId);
    const portable: PortableModelRef = {
      modelId,
      providerType: row?.type ?? '',
      providerLabel: row?.label ?? providerId,
    };
    onSelect({ providerId, modelId }, portable);
  };

  const q = search.trim().toLowerCase();
  const filtered = q
    ? catalog.filter((m) =>
        m.label.toLowerCase().includes(q) ||
        m.id.toLowerCase().includes(q) ||
        (providerLabels[m.providerId] ?? '').toLowerCase().includes(q))
    : catalog;
  // Group by provider label, preserving catalog order — same grouping as
  // ModelPickerPopup's native branch (ModelPickerPopup.tsx:266-304).
  const groups = new Map<string, CatalogModelRow[]>();
  for (const m of filtered) {
    const key = providerLabels[m.providerId] ?? m.providerId;
    const arr = groups.get(key) ?? [];
    arr.push(m);
    groups.set(key, arr);
  }

  return (
    <div className="flex flex-col gap-2">
      <TextInput
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search models…"
        aria-label="Search models"
        className="w-full"
      />
      <div className="flex flex-col gap-3 max-h-56 overflow-y-auto">
        {!loaded ? (
          <p className="text-xs text-fg-muted text-center py-2">Loading…</p>
        ) : catalog.length === 0 ? (
          <p className="text-xs text-fg-muted text-center py-2">No models available. Add a provider key in Settings → Providers.</p>
        ) : groups.size === 0 ? (
          <p className="text-xs text-fg-muted text-center py-2">No models match your search.</p>
        ) : (
          [...groups.entries()].map(([label, models]) => (
            <section key={label}>
              <div className="text-3xs uppercase tracking-wider text-fg-muted mb-1">{label}</div>
              <div className="flex flex-col gap-1">
                {models.map((m) => {
                  const isSelected = selected?.providerId === m.providerId && selected?.modelId === m.id;
                  return (
                    <button
                      key={`${m.providerId}:${m.id}`}
                      type="button"
                      onClick={() => handlePick(m.providerId, m.id)}
                      aria-pressed={isSelected}
                      className={`text-left text-xs rounded px-2 py-1.5 transition-colors ${
                        isSelected ? 'bg-accent text-on-accent font-medium' : 'bg-inset text-fg-2 hover:bg-well'
                      }`}
                    >
                      {m.label}
                    </button>
                  );
                })}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}
