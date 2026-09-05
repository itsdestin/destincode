// Local engine install/status card (Plan B). Lives under the 'local' provider
// row in ProvidersSection; Plan C moves it into the Local Models panel.
// Status language is plain words — never status glyphs (standing UX rule).
// Class idioms (text sizes, accent buttons) mirror ProvidersSection's own rows
// so the card reads as part of the section. As of change 25 the surface IS that
// row surface (bg-inset/50, borderless), not a lookalike.
//
// 2026-09-05 local-engine upgrades (design deck docs/active/design/2026-09-04-
// local-engine-upgrades): a live hardware line (S-4), faster-engine switches
// gated on the detected chip with an install guide for missing system software
// (S-1, Q-1 pick a), and an Advanced disclosure holding the two speed switches,
// the context length and the models folder (Q-4 pick a, Q-2 note: non-developers
// first — anything that needs explaining sits behind Advanced with an (i)).
import { useEffect, useState } from 'react';
import { AnchorTip, Button, Callout, FieldError, SettingRow, TextInput, Toggle } from './ui';
import type { BackendOption, EnginePrereqs, EngineSpeedSettings } from '../../shared/engine-types';

interface EngineStatusView {
  installed: boolean;
  installedVersion: string | null;
  pinnedVersion: string;
  backend: string | null;
  state: 'not-installed' | 'stopped' | 'starting' | 'running' | 'error';
  errorMessage?: string;
  cacheDir: string;
  contextSize: number;   // Plan C: the context-length knob binds to this
  // Optional: an older main omits them and the card simply shows less.
  deviceName?: string | null;
  loadedModelsBytes?: number;
  lastReply?: { promptPerSecond: number; generatePerSecond: number } | null;
  backendOptions?: BackendOption[];
  speed?: EngineSpeedSettings;
}

type Progress =
  | { kind: 'download'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'verify' } | { kind: 'unpack' }
  | { kind: 'done' } | { kind: 'error'; message: string };

// Bytes → whole MB for the download progress line.
const mb = (n: number) => `${Math.round(n / 1048576)} MB`;
// Bytes → GB with one decimal, for "12.4 GB of models loaded".
const gb = (n: number) => `${(n / 1073741824).toFixed(1)} GB`;

// Plain names for the engine builds. The backend id is what main stores; the
// user reads the chip family it targets.
const BACKEND_WORDS: Record<string, string> = {
  vulkan: 'Vulkan (any graphics chip)',
  cpu: 'Processor only',
  metal: 'Metal (Apple graphics)',
  cuda: 'CUDA (NVIDIA)',
  rocm: 'ROCm (AMD)',
};

export default function EngineCard({ showDetails = false }: { showDetails?: boolean }) {
  const [status, setStatus] = useState<EngineStatusView | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Fetch once, then keep live via the two push subscriptions. `alive` guards
    // the async status() resolve against an unmount before it lands.
    let alive = true;
    void window.claude.engine.status().then((s: any) => { if (alive) setStatus(s); });
    const offP = window.claude.engine.onInstallProgress((p: any) => setProgress(p));
    const offS = window.claude.engine.onStatusChanged((s: any) => setStatus(s));
    return () => { alive = false; offP(); offS(); };
  }, []);

  // Context-length knob draft (Plan C, showDetails). Re-syncs whenever the
  // engine's configured contextSize changes (initial load, push, or a commit).
  const [ctxDraft, setCtxDraft] = useState<number | null>(null);
  useEffect(() => { if (status) setCtxDraft(status.contextSize); }, [status?.contextSize]);

  // Advanced disclosure — collapsed by default (Q-2 note: the screen is for
  // non-developers first; the switches inside all carry an (i)).
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // The faster-engine switch that needs system software first (Linux ROCm):
  // which option's guide is open, and what main says is missing.
  const [guideFor, setGuideFor] = useState<string | null>(null);
  const [prereqs, setPrereqs] = useState<EnginePrereqs | null>(null);
  const [copied, setCopied] = useState(false);

  // Shared runner for install/restart/setContext/setBackend: sets busy,
  // surfaces any thrown error, and clears the transient progress line when the
  // action settles.
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setError(null);
    try { setStatus(await fn()); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); setProgress(null); }
  };

  // Commit the context-length knob. Reverts an invalid value (< 1024 or NaN)
  // and no-ops when unchanged, so a blur/Enter can't needlessly reboot the
  // engine (setContext restarts a running server).
  const commitContext = async () => {
    if (ctxDraft == null || !status) return;
    const n = Math.floor(ctxDraft);
    if (!Number.isFinite(n) || n < 1024) { setCtxDraft(status.contextSize); return; }
    if (n === status.contextSize) return;
    await run(() => window.claude.engine.setContext(n));
  };

  // A faster-engine button (S-1). A 'ready' option switches at once — main
  // installs that build, asks it which device it will use, and REFUSES (with
  // the engine's own message) if no graphics chip answers; the refusal lands in
  // `error` below. A 'needs-prereqs' option opens the install guide instead.
  const chooseBackend = async (opt: BackendOption) => {
    if (opt.state === 'needs-prereqs') {
      setGuideFor(opt.backend);
      setPrereqs(null);
      try { setPrereqs(await window.claude.engine.prereqs(opt.backend)); }
      catch (e: any) { setError(e?.message ?? String(e)); }
      return;
    }
    await run(() => window.claude.models.setBackend(opt.backend));
  };

  // "Check again" after the user ran the install: re-read what is missing and,
  // when nothing is, go straight on to the switch.
  const recheck = async () => {
    if (!guideFor) return;
    try {
      const p = await window.claude.engine.prereqs(guideFor);
      setPrereqs(p);
      if (p.satisfied) { setGuideFor(null); await run(() => window.claude.models.setBackend(guideFor)); }
    } catch (e: any) { setError(e?.message ?? String(e)); }
  };

  const copyCommand = async (cmd: string) => {
    try { await navigator.clipboard.writeText(cmd); setCopied(true); setTimeout(() => setCopied(false), 1500); }
    catch { /* clipboard blocked — the command is still on screen to select */ }
  };

  if (!status) return null;

  // A pin bump does NOT upgrade anyone on its own: EngineAcquisition.installed()
  // falls back to whatever complete install it finds, so an existing b-number
  // keeps serving forever and the Install button below is hidden once ANY engine
  // is present. Without this row a newer engine — the only way to run a model
  // built on a newer architecture — is unreachable from the UI (found 2026-08-27,
  // when b9992 could not read qwen4exp and b10665 could).
  const updateAvailable = status.installed
    && status.installedVersion !== null
    && status.installedVersion !== status.pinnedVersion;

  // Plain-words state line (no glyphs). Running/installed spell out version +
  // backend so the user knows exactly what's on disk.
  const stateLabel =
    status.state === 'not-installed' ? 'Not installed'
    : status.state === 'running' ? `Running · ${status.installedVersion} · ${status.backend}`
    : status.state === 'starting' ? 'Starting…'
    : status.state === 'error' ? (status.errorMessage ?? 'Stopped after repeated crashes')
    : `Installed ${status.installedVersion} · ${status.backend} · stopped (starts on first message)`;

  // S-4: what the engine is doing right now, one compact line, only while it
  // runs. Facts arrive from main; an older main sends none and the line is
  // simply absent. Speeds are the engine's own timings from the last reply.
  const hardwareParts: string[] = [];
  if (status.state === 'running') {
    hardwareParts.push(status.deviceName ?? 'Processor only');
    if (typeof status.loadedModelsBytes === 'number') {
      hardwareParts.push(status.loadedModelsBytes > 0 ? `${gb(status.loadedModelsBytes)} of models loaded` : 'no model loaded');
    }
    if (status.lastReply) {
      hardwareParts.push(`last reply ${Math.round(status.lastReply.promptPerSecond)} read / ${Math.round(status.lastReply.generatePerSecond)} write per second`);
    }
  }

  const options = (status.backendOptions ?? []).filter((o) => o.backend !== status.backend);
  const speed = status.speed ?? { speculative: true, compressCache: true };

  return (
    // Change 25: the in-panel row surface — bg-inset/50, borderless. Was
    // `border border-edge-dim bg-well`. Same idiom as ProvidersSection's rows
    // and SettingsRow, which is what the header comment above always intended.
    <div className="mt-2 rounded-lg bg-inset/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-fg font-medium">Local engine (llama.cpp)</p>
          <p className="text-3xs text-fg-muted">{stateLabel}</p>
          {hardwareParts.length > 0 && (
            <p className="text-3xs text-fg-dim" data-testid="engine-hardware-line">{hardwareParts.join(' · ')}</p>
          )}
        </div>
        {/* Primary row action via the shared primitive — drops the hand-rolled
            accent fill + hover:brightness-110 (invisible on near-black accents). */}
        {status.state === 'not-installed' && (
          <Button
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => run(() => window.claude.engine.install())}
          >
            {busy ? 'Installing…' : 'Install'}
          </Button>
        )}
        {status.state === 'error' && (
          <Button
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => run(() => window.claude.engine.restart())}
          >
            Restart engine
          </Button>
        )}
        {/* engine.install() always fetches the PINNED build and verify-boots it
            before it takes over, so the same call is both first install and
            upgrade — nothing new is needed in main. */}
        {updateAvailable && status.state !== 'error' && (
          <Button
            size="sm"
            className="shrink-0"
            disabled={busy}
            onClick={() => run(() => window.claude.engine.install())}
          >
            {busy ? 'Updating…' : 'Update'}
          </Button>
        )}
      </div>
      {busy && progress?.kind === 'download' && (
        <p className="mt-2 text-3xs text-fg-dim">
          Downloading… {mb(progress.receivedBytes)}{progress.totalBytes ? ` of ${mb(progress.totalBytes)}` : ''}
        </p>
      )}
      {busy && (progress?.kind === 'verify' || progress?.kind === 'unpack') && (
        <p className="mt-2 text-3xs text-fg-dim">{progress.kind === 'verify' ? 'Verifying download…' : 'Unpacking…'}</p>
      )}
      {error && <FieldError as="p" className="mt-2">{error}</FieldError>}
      {/* Say WHY the button is there. "A newer engine is available" alone tells a
          non-developer nothing about whether they need it. */}
      {updateAvailable && !busy && (
        <p className="mt-2 text-3xs text-fg-dim">
          A newer engine ({status.pinnedVersion}) is available. Newer engines can run
          newer models — update if a model you downloaded won't load.
        </p>
      )}

      {/* Extra controls for the Local Models panel (Plan C). Only shown once the
          engine is installed — nothing to configure before that. */}
      {showDetails && status.installed && (
        <div className="mt-3 pt-3 border-t border-edge-dim space-y-2.5">
          {/* Backend line + the faster-engine switches main says this machine can
              take (S-1). No option → just the line. The old "Switch to CUDA" that
              showed on every Windows PC is gone: main decides from the detected chip. */}
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xs text-fg-dim">Using: {BACKEND_WORDS[status.backend ?? ''] ?? status.backend ?? 'default'}</p>
            {options.length > 0 && (
              <div className="flex items-center gap-1.5 shrink-0">
                {options.map((opt) => (
                  <Button
                    key={opt.backend}
                    variant="secondary"
                    size="sm"
                    onClick={() => void chooseBackend(opt)}
                    disabled={busy}
                    aria-expanded={guideFor === opt.backend}
                  >
                    {opt.label}
                  </Button>
                ))}
              </div>
            )}
          </div>

          {/* Q-1 pick a: the install guide. What is missing, the one command for
              THIS Linux flavour, and three ways forward — run it in the app's own
              terminal (you press Enter and type your password there), copy it, or
              check again once it is done. Nothing is installed behind your back. */}
          {guideFor && (
            <Callout tone="info" title={`${BACKEND_WORDS[guideFor] ?? guideFor} needs AMD's ROCm software first`} className="text-2xs">
              {!prereqs && <p className="text-fg-muted">Checking what this computer has…</p>}
              {prereqs && !prereqs.satisfied && (
                <div className="space-y-2">
                  <p>
                    {prereqs.explainer}{' '}
                    <AnchorTip label="What is ROCm?" title="What is ROCm?" widthClass="w-72">
                      ROCm is AMD&rsquo;s software for running heavy math on its graphics chips.
                      The faster engine is built on it, so it has to be on this computer first.
                      It is installed with your system&rsquo;s package manager and can be removed
                      the same way.
                    </AnchorTip>
                  </p>
                  {prereqs.command ? (
                    <>
                      <p className="text-fg-muted">
                        {prereqs.distro ? `Install command for ${prereqs.distro}:` : 'Install command:'}
                      </p>
                      <pre className="rounded-md bg-well px-2.5 py-2 text-3xs font-mono whitespace-pre-wrap break-words select-all">{prereqs.command}</pre>
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" onClick={() => void window.claude.engine.runInTerminal(prereqs.command!)}>
                          Run in terminal
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void copyCommand(prereqs.command!)}>
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void recheck()} disabled={busy}>
                          Check again
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setGuideFor(null)}>
                          Not now
                        </Button>
                      </div>
                      <p className="text-fg-muted">
                        The terminal will ask for your password. When it finishes, press Check again.
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-fg-muted">
                        We could not tell which Linux this is, so there is no command to offer.
                        AMD&rsquo;s own guide covers every supported system.
                      </p>
                      <div className="flex flex-wrap gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => void window.claude.shell.openExternal(prereqs.docsUrl)}>
                          Open AMD&rsquo;s guide
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void recheck()} disabled={busy}>
                          Check again
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setGuideFor(null)}>
                          Not now
                        </Button>
                      </div>
                    </>
                  )}
                </div>
              )}
              {prereqs?.satisfied && <p>Everything is in place — switching…</p>}
            </Callout>
          )}

          {/* Advanced disclosure (Q-4 pick a). Collapsed by default; holds the two
              speed switches, the context length and the models folder — the
              settings a non-developer never needs and a power user wants in view. */}
          <button
            type="button"
            onClick={() => setAdvancedOpen((o) => !o)}
            aria-expanded={advancedOpen}
            data-testid="engine-advanced-toggle"
            className="flex items-center gap-1.5 text-2xs text-fg-dim hover:text-fg"
          >
            <svg className={`w-3 h-3 transition-transform ${advancedOpen ? 'rotate-90' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
            </svg>
            Advanced
          </button>

          {advancedOpen && (
            <div className="space-y-2" data-testid="engine-advanced">
              {/* Toggle rows via the shared SettingRow (design guide 4.6, guard
                  setting-row-authority.test.tsx). Both default ON — the best defaults
                  ship, the switch is for ruling a feature out when a model misbehaves
                  (Destin, Q-4 note). */}
              <SettingRow
                variant="item"
                title={(
                  <span className="flex items-center gap-1">
                    Speculative decoding
                    <AnchorTip label="About speculative decoding" title="Speculative decoding" widthClass="w-72">
                      The engine guesses several words ahead from text already in the
                      conversation, then checks the guesses in one go. Replies that repeat
                      earlier text — a file being edited, a quote — come back up to six times
                      faster; other replies are unchanged. The words are exactly what the model
                      would have written anyway.
                    </AnchorTip>
                  </span>
                )}
                description="Big speedup when a reply repeats earlier text. Off only to compare."
                control={(
                  <Toggle
                    checked={speed.speculative}
                    disabled={busy}
                    aria-label="Speculative decoding"
                    onChange={(next) => void run(() => window.claude.engine.setSpeed({ speculative: next }))}
                  />
                )}
              />
              <SettingRow
                variant="item"
                title={(
                  <span className="flex items-center gap-1">
                    Compress context memory
                    <AnchorTip label="About context memory compression" title="Compress context memory" widthClass="w-72">
                      Long conversations are kept in memory while a model works. Storing that
                      memory at 8 bits instead of 16 halves what it takes and speeds up long
                      conversations, with no quality change most people can measure.
                    </AnchorTip>
                  </span>
                )}
                description="Halves what long conversations use; faster after a few thousand words."
                control={(
                  <Toggle
                    checked={speed.compressCache}
                    disabled={busy}
                    aria-label="Compress context memory"
                    onChange={(next) => void run(() => window.claude.engine.setSpeed({ compressCache: next }))}
                  />
                )}
              />

              {/* Context-length knob. Commits on Enter or blur. Moved under Advanced
                  2026-09-05; the per-model setting on each row overrides it. */}
              <div className="flex items-center justify-between gap-2 px-0.5">
                <label htmlFor="engine-context-size" className="text-2xs text-fg-dim flex items-center gap-1">
                  Context length (tokens)
                  <AnchorTip label="About context length" title="Context length" widthClass="w-72">
                    How much of a conversation the model can hold in mind at once, counted in
                    tokens (roughly three-quarters of a word each). Longer costs memory: a
                    9&nbsp;GB model at 128k needs about 16&nbsp;GB more. This is the default
                    for every model; a model&rsquo;s own Settings can override it.
                  </AnchorTip>
                </label>
                {/* Change 20: the shared field surface. type="number" (plus min/step
                    and the busy-disabled state) passes straight through — TextInput is
                    deliberately not restricted to type="text". size="sm" matches the
                    px-2.5 py-1.5 this input already used. */}
                <TextInput
                  id="engine-context-size"
                  type="number"
                  size="sm"
                  min={1024}
                  step={1024}
                  value={ctxDraft ?? ''}
                  disabled={busy}
                  onChange={(e) => setCtxDraft(e.target.value === '' ? null : Number(e.target.value))}
                  onBlur={() => void commitContext()}
                  onKeyDown={(e) => { if (e.key === 'Enter') void commitContext(); }}
                  className="w-24"
                />
              </div>

              {/* Cache location — read-only. */}
              <div className="px-0.5">
                <p className="text-3xs text-fg-muted mb-0.5">Models are stored in</p>
                <p className="text-3xs text-fg-dim font-mono break-all">{status.cacheDir}</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
