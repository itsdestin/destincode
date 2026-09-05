// Local engine install/status card (Plan B). Lives under the 'local' provider
// row in ProvidersSection; Plan C moves it into the Local Models panel.
// Status language is plain words — never status glyphs (standing UX rule).
// Class idioms (text sizes, accent buttons) mirror ProvidersSection's own rows
// so the card reads as part of the section. As of change 25 the surface IS that
// row surface (bg-inset/50, borderless), not a lookalike.
//
// 2026-09-05 local-engine upgrades (design deck docs/active/design/2026-09-04-
// local-engine-upgrades, round 2). Hierarchy, top to bottom: the card title with
// the state word beside it · ONE fact line (chip · models loaded · last reply
// speed while running; version · backend otherwise) · the row actions. Then two
// SettingRows: "Faster engine" (only when main found a matching chip) and
// "Advanced" (expands in place — the right-hand chevron every row has, turned
// down; never a leading "›" text toggle, which Destin rejected in round 1).
// Advanced holds the two speed switches, the context length and the folder.
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
// Bytes → GB with one decimal, for "8.9 GB loaded".
const gb = (n: number) => `${(n / 1073741824).toFixed(1)} GB`;

// Plain names for the engine builds. The backend id is what main stores; the
// user reads the chip family it targets.
const BACKEND_WORDS: Record<string, string> = {
  vulkan: 'Vulkan',
  cpu: 'processor only',
  metal: 'Metal',
  cuda: 'CUDA (NVIDIA)',
  rocm: 'ROCm (AMD)',
};
const CHIP_WORDS: Record<string, string> = { cuda: 'NVIDIA', rocm: 'AMD', metal: 'Apple' };

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

  // Advanced — collapsed by default (Q-2 note: non-developers first).
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // The faster-engine option that needs system software first (Linux ROCm):
  // whether its set-up box is open, and what main says is missing.
  const [setupOpen, setSetupOpen] = useState(false);
  const [prereqs, setPrereqs] = useState<EnginePrereqs | null>(null);
  const [copied, setCopied] = useState(false);
  // Its own error, NOT the card-wide `error`: that one renders in the card body,
  // a couple of hundred pixels above the Run-in-terminal button, which lives
  // inside an expanded Callout. A message the user has to scroll to find is a
  // message they do not read.
  const [terminalError, setTerminalError] = useState<string | null>(null);

  // Shared runner for install/restart/setContext/setBackend: sets busy,
  // surfaces any thrown error, and clears the transient progress line when the
  // action settles.
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setError(null);
    try { setStatus(await fn()); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); setProgress(null); }
  };

  // "Run in terminal": open a plain-shell session with the install command
  // already typed onto its prompt. The app does not press Enter — the user
  // reads the command and runs it themselves, in their own terminal, where the
  // password an installer asks for is typed.
  //
  // Nothing selects the session here: main forwards session:created to this
  // window and App.tsx's handler focuses a newly created session and closes
  // Settings, which is the same path every other new session takes.
  const openTerminalWithCommand = async (command: string) => {
    // busy also disables the button — without it a double-click opens two
    // terminals, and the second one steals focus from the first.
    setBusy(true); setTerminalError(null);
    try { await window.claude.engine.runInTerminal(command); }
    // The real reason, not a guess — the terminal failing to open is the only
    // thing the user can act on here (Copy is right beside this button).
    // Electron wraps every rejected invoke as "Error invoking remote method
    // 'engine:run-in-terminal': Error: <the real message>", which is machinery,
    // not something a non-developer can act on. Strip it down to the sentence.
    catch (e: any) {
      const raw = e?.message ?? String(e);
      setTerminalError(raw.replace(/^Error invoking remote method '[^']*':\s*(Error:\s*)?/, ''));
    }
    finally { setBusy(false); }
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

  // The faster-engine row (S-1). main offers an option ONLY after it has found
  // the matching chip AND, where the build needs system software, that software
  // — so a 'ready' switch is expected to succeed. The device check after install
  // is the safety net, not the normal path (round-1 P-3: the refusal "reads as
  // broken", so it is no longer a featured state; a failure lands in `error`).
  const chooseBackend = async (opt: BackendOption) => {
    if (opt.state === 'needs-prereqs') {
      const next = !setupOpen;
      setSetupOpen(next);
      if (next) {
        setPrereqs(null);
        try { setPrereqs(await window.claude.engine.prereqs(opt.backend)); }
        catch (e: any) { setError(e?.message ?? String(e)); }
      }
      return;
    }
    await run(() => window.claude.models.setBackend(opt.backend));
  };

  // "Check again" after the user ran the install: re-read what is missing and,
  // when nothing is, go straight on to the switch.
  const recheck = async (backend: string) => {
    try {
      const p = await window.claude.engine.prereqs(backend);
      setPrereqs(p);
      if (p.satisfied) { setSetupOpen(false); await run(() => window.claude.models.setBackend(backend)); }
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

  // Plain-words state, one word or two, beside the title (no glyphs).
  const stateWord =
    status.state === 'not-installed' ? 'Not installed'
    : status.state === 'running' ? 'Running'
    : status.state === 'starting' ? 'Starting…'
    : 'Stopped';

  // ONE fact line (S-4). Running: chip · models loaded · last reply speed.
  // Otherwise: version · backend, so the user still knows what is on disk.
  const facts: string[] = [];
  if (status.state === 'running') {
    // Three answers, not two (see EngineManager.status): a name is the chip,
    // `null` means the engine looked and found none, and `undefined` means we
    // have not asked yet. Saying "Processor only" while still checking asserts
    // something we do not know — and it lands exactly on a fresh install, whose
    // device list has not been read yet.
    if (status.deviceName !== undefined) facts.push(status.deviceName ?? 'Processor only');
    if (typeof status.loadedModelsBytes === 'number') {
      facts.push(status.loadedModelsBytes > 0 ? `${gb(status.loadedModelsBytes)} loaded` : 'nothing loaded');
    }
    if (status.lastReply) {
      facts.push(`last reply ${Math.round(status.lastReply.promptPerSecond)} read / ${Math.round(status.lastReply.generatePerSecond)} write per second`);
    }
  } else if (status.installed) {
    facts.push(`Engine ${status.installedVersion}`, BACKEND_WORDS[status.backend ?? ''] ?? status.backend ?? '');
    if (status.state === 'stopped') facts.push('starts on first message');
  }
  const factLine = status.state === 'error'
    ? (status.errorMessage ?? 'Stopped after repeated crashes')
    : facts.filter(Boolean).join(' · ');

  const options = (status.backendOptions ?? []).filter((o) => o.backend !== status.backend);
  const speed = status.speed ?? { speculative: true, compressCache: true };

  return (
    // Change 25: the in-panel row surface — bg-inset/50, borderless. Was
    // `border border-edge-dim bg-well`. Same idiom as ProvidersSection's rows
    // and SettingsRow, which is what the header comment above always intended.
    <div className="mt-2 rounded-lg bg-inset/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-fg font-medium">
            Local engine
            <span className="ml-2 text-3xs font-normal text-fg-muted">{stateWord}</span>
          </p>
          {factLine && <p className="text-3xs text-fg-muted" data-testid="engine-fact-line">{factLine}</p>}
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
        <div className="mt-2.5 space-y-1.5">
          {/* S-1: a faster engine, as a row. Present only when main detected the
              matching chip (and its software, where the build needs some). */}
          {options.map((opt) => (
            <div key={opt.backend} className="space-y-1.5">
              <SettingRow
                variant="item"
                title={`Faster engine for your ${CHIP_WORDS[opt.backend] ?? opt.backend} chip`}
                description={[
                  opt.state === 'needs-prereqs'
                    ? `${BACKEND_WORDS[opt.backend] ?? opt.backend} needs AMD's software installed first.`
                    : `${BACKEND_WORDS[opt.backend] ?? opt.backend} is usually much faster than ${BACKEND_WORDS[status.backend ?? ''] ?? 'the current engine'} on this chip.`,
                  // main appends a sentence when it knows something this row
                  // cannot: today, that with no model downloaded yet the switch
                  // can only be checked as far as the engine starting (§A4).
                  opt.note,
                ].filter(Boolean).join(' ')}
                control={(
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => void chooseBackend(opt)}
                    disabled={busy}
                    aria-expanded={opt.state === 'needs-prereqs' ? setupOpen : undefined}
                  >
                    {opt.state === 'needs-prereqs' ? (setupOpen ? 'Hide' : 'Set up') : 'Switch'}
                  </Button>
                )}
              />

              {/* Q-1 pick a: the set-up box. One sentence, the command for THIS
                  Linux flavour with Copy inside it, two buttons. The terminal is
                  where the password is typed — nothing installs behind your back. */}
              {setupOpen && opt.state === 'needs-prereqs' && (
                <Callout
                  tone="info"
                  className="text-2xs"
                  title={(
                    <span className="flex items-center gap-1">
                      Install AMD&rsquo;s ROCm software first
                      <AnchorTip label="What is ROCm?" title="What is ROCm?" widthClass="w-72">
                        ROCm is AMD&rsquo;s software for running heavy math on its graphics chips.
                        The faster engine is built on it, so it has to be on this computer first.
                        It installs with your system&rsquo;s package manager and can be removed
                        the same way.
                      </AnchorTip>
                    </span>
                  )}
                >
                  {!prereqs && <p className="text-fg-muted">Checking this computer…</p>}
                  {prereqs && !prereqs.satisfied && prereqs.command && (
                    <div className="space-y-2">
                      <p className="text-fg-muted">
                        Run this in a terminal{prereqs.distro ? ` (${prereqs.distro})` : ''}. It will ask for your password.
                      </p>
                      <div className="flex items-start gap-1.5 rounded-md bg-well px-2.5 py-2">
                        <pre className="flex-1 min-w-0 text-3xs font-mono whitespace-pre-wrap break-words select-all">{prereqs.command}</pre>
                        <Button size="sm" variant="ghost" onClick={() => void copyCommand(prereqs.command!)} className="shrink-0 -my-1">
                          {copied ? 'Copied' : 'Copy'}
                        </Button>
                      </div>
                      <div className="flex gap-1.5">
                        <Button size="sm" disabled={busy} onClick={() => void openTerminalWithCommand(prereqs.command!)}>
                          Run in terminal
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void recheck(opt.backend)} disabled={busy}>
                          Check again
                        </Button>
                      </div>
                      {terminalError && <FieldError as="p">{terminalError}</FieldError>}
                    </div>
                  )}
                  {prereqs && !prereqs.satisfied && !prereqs.command && (
                    <div className="space-y-2">
                      {/* Two very different reasons there is nothing to paste, and
                          they must not read the same. On Ubuntu and Debian we know
                          exactly which system this is — the packages simply come
                          from AMD's own repository, which has to be added first.
                          Telling that user we could not recognise their Linux,
                          one line under the words "Ubuntu 24.04", reads as the
                          app being broken. */}
                      <p className="text-fg-muted">
                        {prereqs.reason === 'needs-amd-repo'
                          ? <>On {prereqs.distro ?? 'this system'}, AMD&rsquo;s software comes from AMD&rsquo;s own
                            download site rather than your system&rsquo;s. Their guide has the steps;
                            press Check again when it is installed.</>
                          : <>We could not tell which Linux this is. AMD&rsquo;s guide covers every supported system;
                            press Check again when it is installed.</>}
                      </p>
                      <div className="flex gap-1.5">
                        <Button size="sm" variant="secondary" onClick={() => void window.claude.shell.openExternal(prereqs.docsUrl)}>
                          Open AMD&rsquo;s guide
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void recheck(opt.backend)} disabled={busy}>
                          Check again
                        </Button>
                      </div>
                    </div>
                  )}
                  {prereqs?.satisfied && <p>Everything is in place — switching…</p>}
                </Callout>
              )}
            </div>
          ))}

          {/* Advanced (Q-4 pick a): the one expandable-row shape — SettingRow with
              its chevron turned down while open. */}
          <SettingRow
            variant="item"
            title="Advanced"
            description={advancedOpen ? undefined : 'Speed settings, context length, where models are stored'}
            onClick={() => setAdvancedOpen((o) => !o)}
            expanded={advancedOpen}
          />

          {advancedOpen && (
            <div className="space-y-1.5 pl-3" data-testid="engine-advanced">
              {/* Both default ON — the best defaults ship; the switch is for ruling a
                  feature out when a model misbehaves (Destin, Q-4 note). Short hints;
                  the (i) carries the explanation. */}
              <SettingRow
                variant="item"
                title={(
                  <span className="flex items-center gap-1">
                    Speculative decoding
                    <AnchorTip label="About speculative decoding" title="Speculative decoding" widthClass="w-72">
                      The engine guesses several words ahead from text already in the
                      conversation, then checks the guesses in one go. Replies that repeat
                      earlier text — a file being edited, a quote — come back up to six times
                      faster; other replies are unchanged, and the words are exactly what the
                      model would have written anyway.
                    </AnchorTip>
                  </span>
                )}
                description="Faster replies when text repeats."
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
                description="Halves the memory long chats use."
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
                  2026-09-05; a model's own Settings can override it. */}
              <SettingRow
                variant="item"
                title={(
                  <span className="flex items-center gap-1">
                    Context length
                    <AnchorTip label="About context length" title="Context length" widthClass="w-72">
                      How much of a conversation a model holds in mind at once. Longer costs
                      memory: a 9&nbsp;GB model at 128k needs about 16&nbsp;GB more. This is the
                      default for every model; a model&rsquo;s own Settings can override it.
                    </AnchorTip>
                  </span>
                )}
                description="Default for every model."
                control={(
                  <TextInput
                    id="engine-context-size"
                    aria-label="Context length"
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
                )}
              />

              {/* Engine build + folder — read-only facts, one quiet row. */}
              <SettingRow
                variant="item"
                title="Engine build"
                description={status.cacheDir}
                value={`${status.installedVersion ?? '—'} · ${BACKEND_WORDS[status.backend ?? ''] ?? status.backend ?? ''}`}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
