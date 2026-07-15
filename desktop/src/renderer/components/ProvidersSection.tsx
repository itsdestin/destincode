import React, { useState, useEffect, useCallback } from 'react';
import type { ProviderStatus, ProviderConfig, ProviderType } from '../../shared/provider-types';

// Settings → Providers section (Phase 1 Plan A, Task 13). Lets the user add,
// test, enable/disable, and remove the model providers the NATIVE runtime binds
// sessions to (OpenRouter, direct Anthropic/OpenAI/Google keys, custom
// OpenAI-compatible endpoints). Desktop-only surface: the whole section is
// gated on window.claude.native.supported so production builds (native.supported
// false until Phase 2) render nothing.
//
// ERROR TOLERANCE: provider IPC error semantics differ by transport — desktop
// ipcMain.handle lets the registry THROW (renderer promise rejects), while the
// remote WS transport resolves with { ok:false, error }. Every provider call
// runs through the `safe*` helpers below, which tolerate BOTH: a rejected
// promise AND a resolved { ok:false, error/message } object are normalized into
// a single thrown Error the UI can render. testConnection is the ONE exception —
// it legitimately resolves { ok:false, message } for a failed test, which is a
// real result to display, not a transport error, so safeTest never throws on
// ok:false.
//
// LATENT REMOTE PARITY GAP (reconcile before Phase 2 ungates this UI on remote):
// the desktop preload passes provider IPC args POSITIONALLY
// (invoke(PROVIDER_REMOVE, id), invoke(PROVIDER_SET_KEY, id, key)) and the
// ipcMain handlers read them positionally, whereas remote-shim.ts wraps them as
// OBJECTS (invoke('provider:remove', { id }), invoke('provider:set-key', { id,
// key })). A remote WS route would need to UNWRAP those objects before calling
// the registry. In Plan A the section is gated on native.supported (hard-false
// on remote) so this path is never exercised — but when Phase 2 enables it on
// remote, align the payload shapes (and add the WS route) or remove/set-key
// silently break over the WebSocket transport.

// A resolved value shaped like a transport error ({ ok:false, ... }). Used only
// for list/upsert/remove/setKey — NOT test (see module header).
function errorMessageOf(v: unknown): string | null {
  if (v && typeof v === 'object' && (v as any).ok === false) {
    // Only trust a STRING error/message — a resolved { ok:false, error:{...} }
    // (structured error object) would otherwise stringify to "[object Object]".
    const err = (v as any).error;
    const msg = (v as any).message;
    if (typeof err === 'string') return err;
    if (typeof msg === 'string') return msg;
    return 'The provider request failed.';
  }
  return null;
}

// Await a provider IPC promise and normalize a resolved { ok:false } into a
// throw so the caller's single try/catch covers both a rejected promise and a
// resolved-error object. Rejections propagate untouched.
async function normalize<T>(p: Promise<T>): Promise<T> {
  const res = await p;
  const err = errorMessageOf(res);
  if (err) throw new Error(err);
  return res;
}

const safeProviders = {
  list: (): Promise<ProviderStatus[]> =>
    normalize(window.claude.providers.list() as Promise<ProviderStatus[]>),
  upsert: (config: Partial<ProviderConfig>): Promise<string> =>
    normalize(window.claude.providers.upsert(config)),
  remove: (id: string): Promise<unknown> =>
    normalize(window.claude.providers.remove(id)),
  setKey: (id: string, key: string): Promise<unknown> =>
    normalize(window.claude.providers.setKey(id, key)),
  // Never throws on ok:false — a failed test is a real result, not an error.
  // A genuinely rejected promise (or a transport { ok:false, error } with no
  // message) still degrades to a displayable { ok:false, message }.
  async test(id: string): Promise<{ ok: boolean; message: string }> {
    try {
      const res: any = await window.claude.providers.test(id);
      if (res && typeof res === 'object' && typeof res.message === 'string') {
        return { ok: !!res.ok, message: res.message };
      }
      // Resolved error shape without a message, or an unexpected shape.
      const err = errorMessageOf(res);
      return { ok: false, message: err ?? 'Could not test this provider.' };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : 'Could not test this provider.' };
    }
  },
};

// Plain-language state word for a provider row. No status glyphs (●◐○) anywhere —
// the app's standing UX rule. The local-engine row's readiness now derives from
// `ready` (true once Plan B's llama.cpp engine is installed) — the EngineCard
// below the row carries the detailed install/status controls.
function stateWord(p: ProviderStatus): string {
  if (p.type === 'local-engine') return p.ready ? 'Installed' : 'Not installed';
  if (!p.enabled) return 'Disabled';
  if (p.ready) return 'Connected';
  // enabled && !ready && not local → the key is missing (ready already accounts
  // for keyless provider types, so a non-ready enabled provider needs a key).
  return 'Needs API key';
}

// The provider-type options surfaced in the "Add provider" form. Custom endpoints
// map to the openai-compatible runtime type; the rest are direct-key providers.
const ADD_TYPE_OPTIONS: { value: ProviderType; label: string; needsBaseUrl?: boolean }[] = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openai', label: 'OpenAI' },
  { value: 'google', label: 'Google' },
  { value: 'openai-compatible', label: 'Custom endpoint (OpenAI-compatible)', needsBaseUrl: true },
];

// `embedded`: rendered inside the Model Providers popup's "OpenRouter/API"
// section, which supplies its own heading + a dedicated OpenRouter connect flow
// and already gates on native support — so we drop the standalone <h3> AND hide
// BOTH the local-engine row (managed in Local Models) and the openrouter row
// (managed by the section's own Connect-to-OpenRouter control). What's left is
// the "add your own API provider" list.
export default function ProvidersSection({ embedded = false }: { embedded?: boolean } = {}) {
  // Gate the ENTIRE section on native support — hidden in production until
  // Phase 2 ungates. Read once (it's a static boolean, no IPC round-trip).
  const supported = window.claude?.native?.supported === true;

  const [rows, setRows] = useState<ProviderStatus[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await safeProviders.list();
      setRows(list);
      setListError(null);
    } catch (e) {
      setListError(e instanceof Error ? e.message : 'Something went wrong');
      setRows((prev) => prev ?? []); // stop the skeleton; show the error line
    }
  }, []);

  useEffect(() => {
    if (!supported) return;
    void refresh();
  }, [supported, refresh]);

  if (!supported) return null;

  // In embedded mode the local-engine row (managed in Local Models) AND the
  // openrouter row (managed by the section's own Connect control) are hidden.
  const visibleRows = rows === null
    ? null
    : (embedded ? rows.filter((p) => p.type !== 'local-engine' && p.type !== 'openrouter') : rows);

  return (
    <section>
      {!embedded && (
        <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Providers</h3>
      )}

      {visibleRows === null ? (
        // Loading — quiet skeleton (a single muted line) rather than a spinner.
        <p className="text-[11px] text-fg-muted px-1">Loading…</p>
      ) : (
        <div className="space-y-2">
          {/* Load/refresh error — shown inline with a Retry so a transient
              failure (including a HARD initial-load failure that leaves rows
              empty) doesn't strand the user: the Add-provider affordance below
              still renders, and Retry re-runs list(). */}
          {listError && (
            <div className="flex items-center gap-2 px-1">
              <p className="text-[11px] text-red-500 flex-1">
                {visibleRows.length === 0
                  ? `Couldn't load providers — ${listError}`
                  : `Couldn't refresh — ${listError}`}
              </p>
              <button
                onClick={() => void refresh()}
                className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {visibleRows.map((p) => (
            <ProviderRow key={p.id} provider={p} onChanged={refresh} />
          ))}

          {adding ? (
            <AddProviderForm onDone={async () => { setAdding(false); await refresh(); }} onCancel={() => setAdding(false)} />
          ) : (
            <button
              onClick={() => setAdding(true)}
              className="w-full text-xs font-medium py-2.5 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
            >
              Add provider
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// ── One provider row ─────────────────────────────────────────────────────────

function ProviderRow({ provider, onChanged }: { provider: ProviderStatus; onChanged: () => Promise<void> }) {
  // Key entry: hidden until "Add key" / "Replace key". Draft + busy + inline
  // result message (with a tone) all live per-row.
  const [keyOpen, setKeyOpen] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);

  const isLocal = provider.type === 'local-engine';

  const saveKey = async () => {
    const value = keyDraft.trim();
    if (!value) return;
    setBusy(true);
    setNote(null);
    try {
      await safeProviders.setKey(provider.id, value);
      // Immediately verify the key so the user gets a real Connected/failed
      // signal instead of a silent save.
      const res = await safeProviders.test(provider.id);
      setNote({ tone: res.ok ? 'ok' : 'bad', text: res.message });
      setKeyDraft('');
      setKeyOpen(false);
      await onChanged(); // refresh hasKey/ready
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not save the key.' });
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    setBusy(true);
    setNote(null);
    const res = await safeProviders.test(provider.id);
    setNote({ tone: res.ok ? 'ok' : 'bad', text: res.message });
    setBusy(false);
  };

  const toggleEnabled = async () => {
    setBusy(true);
    setNote(null);
    try {
      // Pass ProviderConfig fields ONLY — never the derived ProviderStatus
      // fields (builtIn/hasKey/ready), which would get persisted. Destructure
      // them off so a clean config reaches upsert.
      const { builtIn, hasKey, ready, ...config } = provider;
      await safeProviders.upsert({ ...config, enabled: !provider.enabled });
      await onChanged();
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not update the provider.' });
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = async () => {
    setBusy(true);
    setNote(null);
    try {
      await safeProviders.remove(provider.id);
      setConfirmingRemove(false);
      await onChanged();
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not remove the provider.' });
    } finally {
      // Reset in finally (mirrors saveKey/toggleEnabled): a success that somehow
      // leaves this row mounted must not strand it permanently disabled.
      setBusy(false);
    }
  };

  return (
    <div className="bg-inset/50 hover:bg-inset rounded-lg px-3 py-2.5 transition-colors">
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-fg font-medium truncate">{provider.label}</p>
          <p className="text-[10px] text-fg-muted">{stateWord(provider)}</p>
        </div>

        {/* Enable/disable toggle — hidden for the dormant local engine (nothing
            to enable in Plan A). */}
        {!isLocal && (
          <button
            onClick={() => void toggleEnabled()}
            disabled={busy}
            aria-pressed={provider.enabled}
            className={`w-8 h-4.5 rounded-full relative transition-colors shrink-0 disabled:opacity-60 ${provider.enabled ? 'bg-accent' : 'bg-inset'}`}
            title={provider.enabled ? 'Enabled' : 'Disabled'}
          >
            <span className={`absolute top-0.5 w-3.5 h-3.5 rounded-full bg-white transition-transform ${provider.enabled ? 'left-[calc(100%-16px)]' : 'left-0.5'}`} />
          </button>
        )}
      </div>

      {/* Row actions — key + test live under the header. Local engine has no
          key/test affordances (Plan B territory). */}
      {!isLocal && (
        <div className="flex items-center gap-1.5 mt-2 flex-wrap">
          {!keyOpen && (
            <button
              onClick={() => { setKeyOpen(true); setNote(null); }}
              className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
            >
              {provider.hasKey ? 'Replace key' : 'Add key'}
            </button>
          )}
          <button
            onClick={() => void runTest()}
            disabled={busy}
            className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors disabled:opacity-60"
          >
            {busy ? 'Testing…' : 'Test'}
          </button>
          {/* Remove — non-builtIn rows only (local/openrouter are builtIn and
              cannot be removed). Consequence-gated inline confirm. */}
          {!provider.builtIn && !confirmingRemove && (
            <button
              onClick={() => { setConfirmingRemove(true); setNote(null); }}
              className="text-[11px] font-medium px-2.5 py-1 rounded-lg border border-red-500/40 text-red-500 hover:bg-red-500/10 transition-colors"
            >
              Remove
            </button>
          )}
        </div>
      )}

      {/* Key input — revealed on Add/Replace key. */}
      {keyOpen && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="password"
            autoFocus
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void saveKey(); }}
            placeholder="Paste API key"
            aria-label={`${provider.label} API key`}
            className="flex-1 text-xs bg-inset border border-edge-dim rounded-lg px-3 py-2 text-fg focus:outline-none focus:border-accent"
          />
          <button
            onClick={() => void saveKey()}
            disabled={busy || keyDraft.trim().length === 0}
            className="text-xs font-medium px-3 py-2 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            onClick={() => { setKeyOpen(false); setKeyDraft(''); }}
            className="text-xs font-medium px-3 py-2 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Remove confirm — plain-language consequence (the key is deleted). */}
      {confirmingRemove && (
        <div className="mt-2 space-y-2 rounded-lg bg-inset border border-edge-dim p-3">
          <p className="text-[11px] text-fg-dim leading-relaxed">
            Remove {provider.label}? Its API key is deleted from this computer.
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setConfirmingRemove(false)}
              className="flex-1 text-xs font-medium py-2 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => void confirmRemove()}
              disabled={busy}
              className="flex-1 text-xs font-medium py-2 rounded-lg bg-red-500 text-white hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}

      {/* Inline result — green-ish tone for ok, destructive for a failure.
          Plain words only. */}
      {note && (
        <p className={`text-[10px] mt-2 ${note.tone === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
          {note.text}
        </p>
      )}

      {/* Local engine install/status/restart controls moved to the Local Models
          section (Plan C) — the local row just points there now. */}
      {isLocal && (
        <p className="text-[10px] text-fg-muted mt-2">Managed in Local Models below.</p>
      )}
    </div>
  );
}

// ── Add-provider form ────────────────────────────────────────────────────────

function AddProviderForm({ onDone, onCancel }: { onDone: () => Promise<void>; onCancel: () => void }) {
  const [type, setType] = useState<ProviderType>('anthropic');
  const [label, setLabel] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  // Named apiKey (not `key`) so it doesn't read as React's list `key` prop,
  // which appears just below on the <option key=…> elements.
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const needsBaseUrl = ADD_TYPE_OPTIONS.find((o) => o.value === type)?.needsBaseUrl === true;

  const submit = async () => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel) { setError('Give the provider a name.'); return; }
    if (needsBaseUrl && !baseUrl.trim()) { setError('A custom endpoint needs a base URL.'); return; }
    setBusy(true);
    setError(null);
    try {
      // Pass ProviderConfig fields ONLY (no id — the registry mints one and
      // returns it). baseUrl is only meaningful for custom endpoints.
      const id = await safeProviders.upsert({
        type,
        label: trimmedLabel,
        ...(needsBaseUrl ? { baseUrl: baseUrl.trim() } : {}),
        enabled: true,
      });
      // If a key was entered, save it against the freshly-minted id.
      const trimmedKey = apiKey.trim();
      if (trimmedKey) {
        await safeProviders.setKey(id, trimmedKey);
      }
      await onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the provider.');
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg bg-inset border border-edge-dim p-3">
      <h4 className="text-[10px] font-medium text-fg-muted uppercase tracking-wider">Add provider</h4>

      {/* Type */}
      <div className="space-y-1">
        <label htmlFor="add-provider-type" className="text-[10px] text-fg-muted">Type</label>
        <select
          id="add-provider-type"
          value={type}
          onChange={(e) => setType(e.target.value as ProviderType)}
          className="w-full text-xs bg-inset border border-edge-dim rounded-lg px-3 py-2 text-fg focus:outline-none focus:border-accent"
        >
          {ADD_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {/* Label */}
      <div className="space-y-1">
        <label htmlFor="add-provider-label" className="text-[10px] text-fg-muted">Name</label>
        <input
          id="add-provider-label"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. My OpenAI"
          className="w-full text-xs bg-inset border border-edge-dim rounded-lg px-3 py-2 text-fg focus:outline-none focus:border-accent"
        />
      </div>

      {/* Base URL — custom endpoints only. */}
      {needsBaseUrl && (
        <div className="space-y-1">
          <label htmlFor="add-provider-baseurl" className="text-[10px] text-fg-muted">Base URL</label>
          <input
            id="add-provider-baseurl"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            placeholder="http://localhost:11434/v1"
            className="w-full text-xs bg-inset border border-edge-dim rounded-lg px-3 py-2 text-fg focus:outline-none focus:border-accent"
          />
        </div>
      )}

      {/* Optional key */}
      <div className="space-y-1">
        <label htmlFor="add-provider-key" className="text-[10px] text-fg-muted">API key (optional)</label>
        <input
          id="add-provider-key"
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Paste API key"
          className="w-full text-xs bg-inset border border-edge-dim rounded-lg px-3 py-2 text-fg focus:outline-none focus:border-accent"
        />
      </div>

      {error && <p className="text-[10px] text-red-500">{error}</p>}

      <div className="flex gap-2 pt-1">
        <button
          onClick={onCancel}
          className="flex-1 text-xs font-medium py-2 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy}
          className="flex-1 text-xs font-medium py-2 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy ? 'Adding…' : 'Add provider'}
        </button>
      </div>
    </div>
  );
}
