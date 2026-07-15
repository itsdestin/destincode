import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { useScrollFade } from '../hooks/useScrollFade';
import { InfoPopover } from './InfoPopover';
import ProvidersSection from './ProvidersSection';
import LocalModelsSection from './LocalModelsSection';
import type { FirstRunState } from '../../shared/first-run-types';

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
// (i) InfoPopovers carry the plain-language "what is this?" explanations so the
// section bodies stay focused on the actual settings.

export default function ModelProvidersSection({
  onOpenClaudePreferences,
}: {
  // Opens Claude Code's preferences popup (/config). Threaded from App, which
  // owns that popup's open state — undefined on surfaces that lack it.
  onOpenClaudePreferences?: () => void;
}) {
  // Gate on native support — invisible in production (same as the sections it
  // replaces). Static boolean, no IPC round-trip.
  const supported = window.claude?.native?.supported === true;
  const [open, setOpen] = useState(false);

  if (!supported) return null;

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Model Providers</h3>

      {/* Row-button — same class list as the Account / About rows. */}
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          {/* Simple stacked-layers glyph — "choose your engine". */}
          <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M12 3l9 5-9 5-9-5 9-5z" />
            <path d="M3 13l9 5 9-5" />
          </svg>
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">Model Providers</span>
          <p className="text-[10px] text-fg-muted truncate">Claude Code, OpenRouter, and local models</p>
        </div>
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {open && (
        <ModelProvidersPopupInner
          onClose={() => setOpen(false)}
          onOpenClaudePreferences={onOpenClaudePreferences}
        />
      )}
    </section>
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
  const scrollRef = useScrollFade<HTMLDivElement>();

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-labelledby="model-providers-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-md w-[calc(100%-2rem)] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-edge flex items-center justify-between px-5 py-3">
          <h3 id="model-providers-title" className="text-sm font-semibold text-fg">Model Providers</h3>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-fg-muted hover:text-fg transition-colors w-7 h-7 flex items-center justify-center rounded-sm hover:bg-inset"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div ref={scrollRef} className="scroll-fade">
          <div className="p-5 space-y-6">
            <p className="text-[11px] text-fg-dim leading-relaxed">
              Choose which AI engine powers your sessions. Claude Code is the default; OpenRouter and
              local models are optional alternatives.
            </p>

            <ClaudeCodeBlock onOpenClaudePreferences={onOpenClaudePreferences} onCloseParent={onClose} />

            <hr className="border-edge-dim" />

            <OpenRouterBlock />

            <hr className="border-edge-dim" />

            <LocalModelsBlock />
          </div>
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}

// Shared header for each section: bold name + an (i) explainer.
function SectionHeader({ title, info }: { title: string; info: { label: string; body: React.ReactNode } }) {
  return (
    <div className="flex items-center gap-1.5 mb-2.5">
      <h4 className="text-sm font-semibold text-fg">{title}</h4>
      <InfoPopover label={info.label} title={title}>{info.body}</InfoPopover>
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

  const claudePrereq = state?.prerequisites.find((p) => p.name === 'claude');
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
        <p className={`text-[11px] mt-0.5 ${statusTone === 'ok' ? 'text-green-600' : 'text-fg-muted'}`}>
          {statusText}
        </p>
        <p className="text-[10px] text-fg-muted mt-1.5 leading-relaxed">
          Every session runs through Claude Code unless you pick another provider below.
        </p>

        {onOpenClaudePreferences && (
          <button
            onClick={() => { onCloseParent(); onOpenClaudePreferences(); }}
            className="mt-2.5 text-[11px] font-medium px-2.5 py-1 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
          >
            Claude Code preferences
          </button>
        )}
      </div>
    </section>
  );
}

// ── 2. OpenRouter ────────────────────────────────────────────────────────────

function OpenRouterBlock() {
  return (
    <section>
      <SectionHeader
        title="OpenRouter"
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
                your sessions through it. You pay OpenRouter directly for what you use.
              </p>
            </>
          ),
        }}
      />

      <div className="bg-well border border-edge-dim rounded-lg px-3 py-2.5 mb-3">
        <p className="text-[11px] text-fg-dim leading-relaxed mb-2">To connect OpenRouter:</p>
        <ol className="text-[11px] text-fg-2 leading-relaxed space-y-1 list-decimal pl-4">
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
          <li>Paste the key into the OpenRouter row below and press Test.</li>
        </ol>
      </div>

      {/* The actual provider controls — OpenRouter row, other direct-key
          providers, and custom endpoints. Embedded: no standalone header, and
          the local-engine row is hidden (it lives in Local Models below). */}
      <ProvidersSection embedded />
    </section>
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
