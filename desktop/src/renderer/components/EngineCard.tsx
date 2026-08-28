// Local engine install/status card (Plan B). Lives under the 'local' provider
// row in ProvidersSection; Plan C moves it into the Local Models panel.
// Status language is plain words — never status glyphs (standing UX rule).
// Class idioms (text sizes, accent buttons) mirror ProvidersSection's own rows
// so the card reads as part of the section. As of change 25 the surface IS that
// row surface (bg-inset/50, borderless), not a lookalike.
import { useEffect, useState } from 'react';
import { Button, TextInput } from './ui';

interface EngineStatusView {
  installed: boolean;
  installedVersion: string | null;
  pinnedVersion: string;
  backend: string | null;
  state: 'not-installed' | 'stopped' | 'starting' | 'running' | 'error';
  errorMessage?: string;
  cacheDir: string;
  contextSize: number;   // Plan C: the context-length knob binds to this
}

type Progress =
  | { kind: 'download'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'verify' } | { kind: 'unpack' }
  | { kind: 'done' } | { kind: 'error'; message: string };

// Bytes → whole MB for the download progress line.
const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

// A cuda asset only ships for Windows x64 (engine-pin.ts). The renderer can't
// probe the asset table, so the "Switch to CUDA" button gates on Windows +
// not-already-cuda; on the rare Windows arm64 box setBackend surfaces a plain
// "not available for this platform" error instead of silently doing nothing.
const isWindows = typeof navigator !== 'undefined' && /win/i.test(navigator.platform);

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

  return (
    // Change 25: the in-panel row surface — bg-inset/50, borderless. Was
    // `border border-edge-dim bg-well`. Same idiom as ProvidersSection's rows
    // and SettingsRow, which is what the header comment above always intended.
    <div className="mt-2 rounded-lg bg-inset/50 px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-fg font-medium">Local engine (llama.cpp)</p>
          <p className="text-3xs text-fg-muted">{stateLabel}</p>
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
      {error && <p className="mt-2 text-3xs text-destructive-fg">{error}</p>}
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
          {/* Backend line + optional CUDA switch (Windows only). */}
          <div className="flex items-center justify-between gap-2">
            <p className="text-2xs text-fg-dim">Using: {status.backend ?? 'default'}</p>
            {isWindows && status.backend !== 'cuda' && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => run(() => window.claude.models.setBackend('cuda'))}
                disabled={busy}
                className="shrink-0"
              >
                Switch to CUDA (faster on NVIDIA)
              </Button>
            )}
          </div>

          {/* Context-length knob. Commits on Enter or blur. */}
          <div className="flex items-center justify-between gap-2">
            <label htmlFor="engine-context-size" className="text-2xs text-fg-dim">Context length (tokens)</label>
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
          <div>
            <p className="text-3xs text-fg-muted mb-0.5">Models are stored in</p>
            <p className="text-3xs text-fg-dim font-mono break-all">{status.cacheDir}</p>
          </div>
        </div>
      )}
    </div>
  );
}
