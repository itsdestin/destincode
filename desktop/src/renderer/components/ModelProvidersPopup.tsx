import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEscClose } from '../hooks/use-esc-close';
import ProvidersSection from './ProvidersSection';
import LocalModelsSection from './LocalModelsSection';
import type { FirstRunState } from '../../shared/first-run-types';
import type { ProviderStatus } from '../../shared/provider-types';
import { chatGptPlanLabel, type ChatGptAccountStatus, type ChatGptUsage } from '../../shared/chatgpt-types';
import { AnchorTip, Button, Dialog, InputGroup, TextInput, SettingRow } from './ui';
import BrailleSpinner from './BrailleSpinner';

// Settings → Model Providers. One settings row that opens an L2 popup gathering
// every engine/provider surface in one place: Claude Code (the default engine),
// OpenRouter (cloud models via YouCoded's native harness), and Local Models
// (models that run on this computer). Replaces the two standalone settings
// sections (Providers, Local Models) with a single organized popup.
//
// Gated on window.claude.native.supported, so — like the sections it replaces —
// it renders NOTHING in production until Phase 2 ungates the native runtime.
// Desktop-authoritative; not mounted in AndroidSettings.
//
// Pattern mirrors AccountSection/AboutPopup: a row-button in the settings stack
// that opens a centered, portaled L2 overlay where the real controls live. The
// (i) AnchorTips carry the plain-language "what is this?" explanations so the
// section bodies stay focused on the actual settings.

export default function ModelProvidersSection({
  onOpenClaudePreferences,
  autoOpen,
  onAutoOpenHandled,
}: {
  // Opens Claude Code's preferences popup (/config). Threaded from App, which
  // owns that popup's open state — undefined on surfaces that lack it.
  onOpenClaudePreferences?: () => void;
  // Deep-link: when true, open the popup immediately on mount (mirrors
  // SyncSection). Used by the provider-error bubble's "Open Settings" jump so
  // the user lands directly on the Model Providers controls, not the row.
  autoOpen?: boolean;
  onAutoOpenHandled?: () => void;
}) {
  // Gate on native support — invisible in production (same as the sections it
  // replaces). Static boolean, no IPC round-trip.
  const supported = window.claude?.native?.supported === true;
  const [open, setOpen] = useState(false);

  // Auto-open when deep-linked, then clear the flag so it doesn't reopen after
  // the user closes it (same one-shot handshake SyncSection uses).
  useEffect(() => {
    if (autoOpen && !open) {
      setOpen(true);
      onAutoOpenHandled?.();
    }
  }, [autoOpen, open, onAutoOpenHandled]);

  if (!supported) return null;

  return (
    <>
      <SettingRow
        // Simple stacked-layers glyph — "choose your engine".
        icon={
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3l9 5-9 5-9-5 9-5z" />
            <path d="M3 13l9 5 9-5" />
          </svg>
        }
        title="Model Providers"
        description="Claude Code, ChatGPT, OpenRouter, local models"
        onClick={() => setOpen(true)}
      />

      {open && (
        <ModelProvidersPopupInner
          onClose={() => setOpen(false)}
          onOpenClaudePreferences={onOpenClaudePreferences}
        />
      )}
    </>
  );
}

// ── The popup ────────────────────────────────────────────────────────────────

function ModelProvidersPopupInner({
  onClose,
  onOpenClaudePreferences,
}: {
  onClose: () => void;
  onOpenClaudePreferences?: () => void;
}) {
  useEscClose(true, onClose);

  return createPortal(
    <>
      <Dialog open onClose={onClose} title="Model Providers" size="panel">
            <p className="text-2xs text-fg-dim leading-relaxed">
              Choose which AI engine powers your sessions. Claude Code is the default; a ChatGPT plan,
              OpenRouter and local models are optional alternatives.
            </p>

            <ClaudeCodeBlock onOpenClaudePreferences={onOpenClaudePreferences} onCloseParent={onClose} />

            <ChatGptBlock />

            <OpenRouterBlock />

            <LocalModelsBlock />

            <SearchProvidersBlock />
      </Dialog>
    </>,
    document.body,
  );
}

// Shared header for each section: bold name + an (i) explainer.
function SectionHeader({ title, info }: { title: string; info: { label: string; body: React.ReactNode } }) {
  return (
    <div className="flex items-center gap-1.5 mb-2.5">
      {/* K1: was the app's only text-sm/font-semibold section header, which read
          as a second dialog title rather than a section label. */}
      <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase">{title}</h3>
      <AnchorTip label={info.label} title={title}>{info.body}</AnchorTip>
    </div>
  );
}

// ── 1. Claude Code ───────────────────────────────────────────────────────────

function ClaudeCodeBlock({
  onOpenClaudePreferences,
  onCloseParent,
}: {
  onOpenClaudePreferences?: () => void;
  onCloseParent: () => void;
}) {
  const [state, setState] = useState<FirstRunState | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    // First-run state carries the Claude Code install + sign-in result. It's the
    // only signal available without adding a new IPC; it reflects the last known
    // setup outcome (a later sign-out via the terminal isn't tracked here).
    // `firstRun` isn't part of the typed window.claude shape — FirstRunView
    // reaches it via an `any` cast too. Match that pattern.
    (window as any).claude.firstRun.getState()
      .then((s: FirstRunState) => { if (alive) { setState(s); setLoaded(true); } })
      .catch(() => { if (alive) setLoaded(true); });
    return () => { alive = false; };
  }, []);

  // Guard `prerequisites` too — getState() can resolve to a state whose array
  // is absent (e.g. a profile that never ran first-run), and `state?.` alone
  // would still call .find on undefined.
  const claudePrereq = state?.prerequisites?.find((p) => p.name === 'claude');
  const installed = claudePrereq?.status === 'installed';
  const signedIn = state?.authComplete === true;

  // Plain-word status line (no ●◐○ glyphs).
  let statusText: string;
  let statusTone: 'ok' | 'warn';
  if (!loaded) {
    statusText = 'Checking…';
    statusTone = 'warn';
  } else if (signedIn) {
    statusText = state?.authMode === 'apikey'
      ? 'Connected with an Anthropic API key'
      : 'Signed in with your Claude account';
    statusTone = 'ok';
  } else if (installed) {
    statusText = 'Installed — not signed in yet';
    statusTone = 'warn';
  } else {
    statusText = 'Not set up yet';
    statusTone = 'warn';
  }

  return (
    <section>
      <SectionHeader
        title="Claude Code"
        info={{
          label: 'About Claude Code',
          body: (
            <>
              <p>
                Claude Code is Anthropic's AI coding agent — the engine YouCoded is built around. It can
                read your files, run commands, browse, and use tools.
              </p>
              <p>
                You sign in with your Claude Pro or Max plan (or an Anthropic API key) — there's no extra
                account to create.
              </p>
            </>
          ),
        }}
      />

      <div className="bg-inset/50 rounded-lg px-3 py-2.5">
        <p className="text-xs text-fg font-medium">Default engine</p>
        <p className={`text-2xs mt-0.5 ${statusTone === 'ok' ? 'text-green-600' : 'text-fg-muted'}`}>
          {statusText}
        </p>
        <p className="text-3xs text-fg-muted mt-1.5 leading-relaxed">
          Every session runs through Claude Code unless you pick another provider below.
        </p>

        {/* Outline peer action — the shared secondary recipe replaces the
            hand-rolled border-edge-dim/text-fg-2 copy of it. */}
        {onOpenClaudePreferences && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => { onCloseParent(); onOpenClaudePreferences(); }}
            className="mt-2.5"
          >
            Claude Code preferences
          </Button>
        )}
      </div>
    </section>
  );
}

// ── 1b. ChatGPT ──────────────────────────────────────────────────────────────
// Sign in with ChatGPT (design 2026-09-04, questions deck Q-1a/Q-2a/Q-6a): the
// user's own ChatGPT plan, used by YouCoded's assistant. A sign-in, not a key —
// so this is its own block with the Claude Code and OpenRouter rows for
// neighbours, not a row in the API-key list below. The (i) carries the one
// honest sentence about the footing (Q-6a): OpenAI welcomes this out loud but
// has not written it into its terms.

/** Reads the account state through the (still MOCK_ONLY) `chatgpt` namespace —
 *  reached with a cast like `firstRun`, until it joins the typed bridge. */
function chatGptApi(): {
  status: () => Promise<ChatGptAccountStatus>;
  signIn: () => Promise<boolean>;
  cancelSignIn: () => Promise<boolean>;
  signOut: () => Promise<boolean>;
} {
  return (window as any).claude.chatgpt;
}

function ChatGptBlock() {
  const [status, setStatus] = useState<ChatGptAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try { setStatus(await chatGptApi().status()); }
    catch (e) { setNote(e instanceof Error ? e.message : 'Could not read the ChatGPT sign-in state.'); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  // While the browser round-trip is open, poll — the sign-in completes in a
  // tab this app does not own, so nothing else tells the row it is done.
  useEffect(() => {
    if (status?.state !== 'waiting') return;
    const t = setInterval(() => { void refresh(); }, 1000);
    return () => clearInterval(t);
  }, [status?.state, refresh]);

  const run = async (verb: () => Promise<boolean>, failText: string) => {
    setBusy(true);
    setNote(null);
    try {
      const ok = await verb();
      if (!ok) setNote(failText);
      await refresh();
    } catch (e) {
      setNote(e instanceof Error ? e.message : failText);
    } finally {
      setBusy(false);
    }
  };

  // Plain-word status line — no glyphs (the app's standing rule).
  let line: React.ReactNode;
  let tone: 'ok' | 'muted' | 'bad' = 'muted';
  if (!status) {
    line = 'Checking…';
  } else if (status.state === 'signed-in') {
    line = `Signed in as ${status.email} · ${chatGptPlanLabel(status.plan)}`;
    tone = 'ok';
  } else if (status.state === 'waiting') {
    line = (
      <span className="inline-flex items-center gap-1.5">
        <BrailleSpinner size="sm" />
        Waiting for you to finish in the browser…
      </span>
    );
  } else if (status.state === 'blocked') {
    // OpenAI's own words, verbatim — never a guessed cause.
    line = `Signed in as ${status.email} — ${status.reason}`;
    tone = 'bad';
  } else {
    line = 'Not signed in';
  }

  return (
    <section>
      <SectionHeader
        title="ChatGPT"
        info={{
          label: 'About ChatGPT sign-in',
          body: (
            <>
              <p>
                Sign in with your ChatGPT account and YouCoded's assistant can use the models your
                plan includes — GPT-5.6 and the rest — with no API key and nothing extra to pay.
              </p>
              <p>
                It runs on your plan's limits: a five-hour window and a weekly one, the same ones
                the Codex app uses. The usage card and the status bar show how much is left.
              </p>
              <p>
                OpenAI has publicly welcomed apps like this using your plan, but it is not written
                into their terms yet. If OpenAI ever turns it off, this row will say so plainly and
                everything else in the app keeps working.
              </p>
            </>
          ),
        }}
      />

      <div className="bg-inset/50 rounded-lg px-3 py-2.5">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-fg font-medium">ChatGPT</p>
            <p className={`text-2xs mt-0.5 ${tone === 'ok' ? 'text-green-600' : tone === 'bad' ? 'text-destructive-fg' : 'text-fg-muted'}`}>
              {line}
            </p>
          </div>
          {/* One action per state (G-4): the primary is the sign-in; everything
              after it is an outline peer. */}
          {status?.state === 'waiting' ? (
            <Button variant="secondary" size="sm" disabled={busy} className="shrink-0"
              onClick={() => void run(() => chatGptApi().cancelSignIn(), 'Could not cancel the sign-in.')}>
              Cancel
            </Button>
          ) : status?.state === 'signed-in' || status?.state === 'blocked' ? (
            <Button variant="secondary" size="sm" disabled={busy} className="shrink-0"
              onClick={() => void run(() => chatGptApi().signOut(), 'Could not sign out.')}>
              Sign out
            </Button>
          ) : (
            <Button size="sm" disabled={busy || !status} className="shrink-0"
              onClick={() => void run(() => chatGptApi().signIn(), 'Could not open the sign-in page.')}>
              Sign in with ChatGPT
            </Button>
          )}
        </div>

        {status?.state === 'signed-in' ? (
          <p className="text-3xs text-fg-muted mt-1.5 leading-relaxed">
            {planUsageLine(status.usage) ?? 'Your plan’s models are in the model picker under ChatGPT.'}
          </p>
        ) : status?.state === 'waiting' ? (
          <p className="text-3xs text-fg-muted mt-1.5 leading-relaxed">
            Sign in on chatgpt.com in the tab that opened, then come back here.
          </p>
        ) : status?.state === 'signed-out' ? (
          <p className="text-3xs text-fg-muted mt-1.5 leading-relaxed">
            Your plan's models, in YouCoded's assistant. Opens chatgpt.com to sign in.
          </p>
        ) : null}

        {note && <p className="text-3xs mt-2 text-destructive-fg">{note}</p>}
      </div>
    </section>
  );
}

/** "34% of the 5-hour window (resets 4:10 pm) · 12% of the week" — the two
 *  rolling windows the plan is metered on, or null when OpenAI reported none. */
function planUsageLine(u: ChatGptUsage | null | undefined): string | null {
  if (!u) return null;
  const parts: string[] = [];
  if (u.five_hour) parts.push(`${Math.round(u.five_hour.utilization)}% of the 5-hour window (resets ${clockTime(u.five_hour.resets_at)})`);
  if (u.seven_day) parts.push(`${Math.round(u.seven_day.utilization)}% of the week`);
  return parts.length ? `Plan usage: ${parts.join(' · ')}` : null;
}

function clockTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'later';
  return new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// ── 2. OpenRouter ────────────────────────────────────────────────────────────

function OpenRouterBlock() {
  // The OpenRouter builtin provider (stable id 'openrouter'). undefined = still
  // loading; null = not found (shouldn't happen — it's builtin).
  const [openrouter, setOpenrouter] = useState<ProviderStatus | null | undefined>(undefined);
  const [connectOpen, setConnectOpen] = useState(false);
  const [testNote, setTestNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await window.claude.providers.list() as ProviderStatus[];
      setOpenrouter(list.find((p) => p.id === 'openrouter' || p.type === 'openrouter') ?? null);
    } catch {
      setOpenrouter(null);
    }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const connected = openrouter?.hasKey === true;

  const runTest = async () => {
    if (!openrouter) return;
    setTestNote(null);
    try {
      const res: any = await window.claude.providers.test(openrouter.id);
      setTestNote({ tone: res?.ok ? 'ok' : 'bad', text: res?.message ?? (res?.ok ? 'Connected.' : 'Could not verify the key.') });
    } catch (e) {
      setTestNote({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not test the connection.' });
    }
  };

  return (
    <section>
      <SectionHeader
        title="OpenRouter/API"
        info={{
          label: 'About OpenRouter',
          body: (
            <>
              <p>
                OpenRouter is a single gateway to hundreds of AI models — GPT, Gemini, Llama, and many
                more — from different companies.
              </p>
              <p>
                Instead of making a separate account with each one, you get one API key and YouCoded routes
                your sessions through it. You pay OpenRouter directly for what you use. You can also add your
                own direct provider keys or a custom endpoint below.
              </p>
            </>
          ),
        }}
      />

      {/* OpenRouter connect state — the "To connect…" instructions + key entry
          now live inside the Connect modal, not an always-on banner. */}
      <div className="bg-inset/50 rounded-lg px-3 py-2.5 mb-3">
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-fg font-medium">OpenRouter</p>
            <p className="text-3xs text-fg-muted">
              {openrouter === undefined ? 'Checking…' : connected ? 'Connected' : 'Not connected'}
            </p>
          </div>
          {/* Primary row action. hover:brightness-110 dropped — the primitive's
              bg fade is the one hover idiom (it stays visible on near-black
              accents, where brightness-110 does nothing). */}
          <Button size="sm" onClick={() => { setTestNote(null); setConnectOpen(true); }} className="shrink-0">
            {connected ? 'Replace key' : 'Connect to OpenRouter'}
          </Button>
        </div>
        {connected && (
          <div className="flex items-center gap-1.5 mt-2">
            <Button variant="secondary" size="sm" onClick={() => void runTest()}>
              Test
            </Button>
          </div>
        )}
        {testNote && (
          <p className={`text-3xs mt-2 ${testNote.tone === 'ok' ? 'text-green-600' : 'text-red-500'}`}>
            {testNote.text}
          </p>
        )}
      </div>

      {/* Other API providers — direct keys (Anthropic/OpenAI/Google) + custom
          endpoints. Embedded hides the openrouter + local-engine rows. */}
      <ProvidersSection embedded />

      {connectOpen && openrouter && (
        <ConnectOpenRouterModal
          providerId={openrouter.id}
          hasKey={connected}
          onClose={() => setConnectOpen(false)}
          onSaved={refresh}
        />
      )}
    </section>
  );
}

// Mini modal: the "how to connect" steps + the API-key textbox, opened by the
// Connect-to-OpenRouter button. Layer 3 so it stacks above the L2 Model
// Providers popup. Saving sets the key and verifies it before closing.
function ConnectOpenRouterModal({
  providerId, hasKey, onClose, onSaved,
}: {
  providerId: string;
  hasKey: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  useEscClose(true, onClose);
  const [keyDraft, setKeyDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  const save = async () => {
    const value = keyDraft.trim();
    if (!value) return;
    setBusy(true);
    setNote(null);
    try {
      await window.claude.providers.setKey(providerId, value);
      // Verify immediately so the user gets a real Connected/failed signal.
      const res: any = await window.claude.providers.test(providerId);
      const ok = !!res?.ok;
      setNote({ tone: ok ? 'ok' : 'bad', text: res?.message ?? (ok ? 'Connected.' : 'Saved, but the key could not be verified.') });
      await onSaved();
      if (ok) { setKeyDraft(''); setTimeout(onClose, 700); } // brief success flash, then close
    } catch (e) {
      setNote({ tone: 'bad', text: e instanceof Error ? e.message : 'Could not save the key.' });
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <>
      <Dialog
        open
        onClose={onClose}
        layer={3}
        size="prompt"
        title={hasKey ? 'Replace OpenRouter key' : 'Connect OpenRouter'}
        scrollBody={false}
      >
        <div className="p-4 space-y-3">
          <ol className="text-2xs text-fg-2 leading-relaxed space-y-1 list-decimal pl-4">
            <li>
              Create a free account at{' '}
              <button
                onClick={() => void window.claude.shell.openExternal('https://openrouter.ai')}
                className="text-accent hover:underline"
              >
                openrouter.ai
              </button>
              .
            </li>
            <li>Add a little credit and create an API key.</li>
            <li>Paste the key below and press Connect.</li>
          </ol>

          {/* Change 20 only. NOT an InputGroup: Connect/Cancel sit in the modal
              footer BELOW the field, which is explicitly the shape change 77 does
              not convert. */}
          <TextInput
            type="password"
            autoFocus
            value={keyDraft}
            onChange={(e) => setKeyDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void save(); }}
            placeholder="Paste your OpenRouter API key"
            aria-label="OpenRouter API key"
            className="w-full"
          />

          {note && (
            <p className={`text-3xs ${note.tone === 'ok' ? 'text-green-600' : 'text-red-500'}`}>{note.text}</p>
          )}

          <div className="flex gap-2 pt-1">
            {/* Popup footer pair — md is the footer size; only the flex-1 stretch
                and the taller py-2 are genuine layout extras. */}
            <Button variant="secondary" onClick={onClose} className="flex-1 py-2">
              Cancel
            </Button>
            <Button
              onClick={() => void save()}
              disabled={busy || keyDraft.trim().length === 0}
              className="flex-1 py-2"
            >
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>,
    document.body,
  );
}

// ── 3. Local Models ──────────────────────────────────────────────────────────

function LocalModelsBlock() {
  return (
    <section>
      <SectionHeader
        title="Local Models"
        info={{
          label: 'About local models',
          body: (
            <>
              <p>
                Local models run entirely on this computer — no internet, no account, and no per-use cost.
                YouCoded downloads the model file and runs it with a bundled engine.
              </p>
              <p>
                Bigger, smarter models need more memory (RAM), and a good graphics card (GPU) makes them
                faster. Each model below shows whether it should run well on your hardware.
              </p>
            </>
          ),
        }}
      />

      {/* Embedded: no standalone header (this section supplies it). */}
      <LocalModelsSection embedded />
    </section>
  );
}

// ── 4. Search Providers ──────────────────────────────────────────────────────

// Search providers (native WebSearch keyed upgrades — spec §3.2). NOT model
// providers: Tavily/Exa have no languageModel(), so they live OUTSIDE
// ProviderRegistry/ADD_TYPE_OPTIONS on their own search:* IPC + SecretsStore-backed
// key store. Free search (Exa keyless → DuckDuckGo) works with no key at all; a
// key just makes web search faster and more reliable. search:* is untyped on the
// window.claude shape (like firstRun above), so we reach it via `any` casts.
type SearchBackendId = 'tavily' | 'exa';

// Per-backend copy: a one-line "why add a key" hint + the free-signup URL. Kept
// deliberately non-committal about tiers/quotas (they change) — see the
// "never write misleading text" workspace rule.
const SEARCH_BACKEND_META: Record<SearchBackendId, { hint: string; url: string }> = {
  tavily: { hint: 'Search API tuned for AI — a key makes it the first backend used.', url: 'https://tavily.com' },
  exa: { hint: 'Neural search for AI — a key upgrades the keyless free tier.', url: 'https://exa.ai' },
};

function SearchProvidersBlock() {
  const [rows, setRows] = useState<Array<{ id: SearchBackendId; label: string; hasKey: boolean }>>([]);
  // Which backend's key input is open (only one at a time).
  const [editing, setEditing] = useState<SearchBackendId | null>(null);
  // The in-flight key text. Never held beyond save(): cleared on save/cancel and
  // never logged or persisted anywhere but through search.setKey.
  const [draft, setDraft] = useState('');
  const [testMsg, setTestMsg] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState(false);

  // hasKey comes ONLY from list() — we never infer "connected" from local state.
  const refresh = useCallback(() => (window as any).claude.search?.list()
    .then(setRows).catch(() => setRows([])), []);
  useEffect(() => { void refresh(); }, [refresh]);

  const openEditor = (id: SearchBackendId) => {
    setEditing(id);
    setDraft('');
    // Drop any stale test note for this row when reopening the editor.
    setTestMsg((m) => { const n = { ...m }; delete n[id]; return n; });
  };

  const save = async (id: SearchBackendId) => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    try {
      // testBackend() itself never throws, but the IPC channel underneath
      // (ipcRenderer.invoke) can still reject — so can setKey below. Catch both:
      // { ok, message } IS the logical result; a caught reject becomes an honest
      // note too. Only persist the key when the test actually passed.
      const res = await (window as any).claude.search.test(id, key) as { ok: boolean; message: string };
      if (!res.ok) {
        setTestMsg((m) => ({ ...m, [id]: { ok: false, text: res.message } }));
        return; // keep the input open with the rejection message
      }
      await (window as any).claude.search.setKey(id, key);
      // Success: the "Key saved" badge is the confirmation — drop the ok note so
      // it doesn't linger as a redundant line under the row.
      setTestMsg((m) => { const n = { ...m }; delete n[id]; return n; });
      setDraft('');
      setEditing(null);
      void refresh();
    } catch (e) {
      setTestMsg((m) => ({ ...m, [id]: { ok: false, text: e instanceof Error ? e.message : "Couldn't reach the search service." } }));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: SearchBackendId) => {
    setBusy(true);
    try {
      await (window as any).claude.search.removeKey(id);
      setTestMsg((m) => { const n = { ...m }; delete n[id]; return n; });
      void refresh();
    } catch (e) {
      setTestMsg((m) => ({ ...m, [id]: { ok: false, text: e instanceof Error ? e.message : "Couldn't reach the search service." } }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <SectionHeader
        title="Web Search"
        info={{
          label: 'About web search',
          body: (
            <>
              <p>
                When Claude searches the web, YouCoded runs the search itself — no extra account needed.
                It works for free out of the box using open search backends.
              </p>
              <p>
                Adding a free Tavily or Exa API key is optional. It makes web search faster and more
                reliable, especially when the free backends are busy. Your key is stored encrypted on this
                computer and never leaves it.
              </p>
            </>
          ),
        }}
      />

      <p className="text-3xs text-fg-muted mb-2.5 leading-relaxed">
        Web search works for free with no setup. Add an optional key to make it faster and more reliable.
      </p>

      <div className="space-y-2">
        {rows.map((row) => {
          const meta = SEARCH_BACKEND_META[row.id];
          const isEditing = editing === row.id;
          const note = testMsg[row.id];
          return (
            <div key={row.id} className="bg-inset/50 rounded-lg px-3 py-2.5">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-fg font-medium">{row.label}</p>
                  <p className="text-3xs text-fg-muted">{meta.hint}</p>
                </div>
                {row.hasKey ? (
                  <div className="flex items-center gap-1.5 shrink-0">
                    <span className="text-3xs font-medium text-green-600">Key saved</span>
                    {/* danger-outline per spec change 68: "Remove" reads the same
                        everywhere. This one was the neutral half of the
                        ProvidersSection(red)-vs-here(neutral) contradiction; it
                        deletes a stored API key, so it takes the red outline. */}
                    <Button variant="danger-outline" size="sm" onClick={() => void remove(row.id)} disabled={busy}>
                      Remove
                    </Button>
                  </div>
                ) : !isEditing ? (
                  // Disabled while ANY row's save/remove is in flight — otherwise
                  // opening this editor mid-save gets clobbered when the in-flight
                  // save resolves and clears editing/draft.
                  <Button size="sm" onClick={() => openEditor(row.id)} disabled={busy} className="shrink-0">
                    Add key
                  </Button>
                ) : null}
              </div>

              {isEditing && !row.hasKey && (
                <div className="mt-2 space-y-2">
                  {/* Change 77: Save moves INSIDE the field. Cancel stays outside
                      (one action per field), and so does the "Get a free key"
                      link, which is a navigation aid rather than a field action. */}
                  <InputGroup className="w-full">
                    <InputGroup.Field
                      type="password"
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') void save(row.id); }}
                      placeholder={`Paste your ${row.label} API key`}
                      aria-label={`${row.label} API key`}
                    />
                    <Button size="sm" onClick={() => void save(row.id)} disabled={busy || draft.trim().length === 0}>
                      {busy ? 'Checking…' : 'Save'}
                    </Button>
                  </InputGroup>
                  <div className="flex items-center justify-between gap-2">
                    <button
                      onClick={() => void (window as any).claude.shell.openExternal(meta.url)}
                      className="text-3xs text-accent hover:underline"
                    >
                      Get a free key
                    </button>
                    <Button variant="secondary" size="sm" onClick={() => { setEditing(null); setDraft(''); }}>
                      Cancel
                    </Button>
                  </div>
                </div>
              )}

              {note && (
                <p className={`text-3xs mt-2 ${note.ok ? 'text-fg-muted' : 'text-red-500'}`}>
                  {note.text}
                </p>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
