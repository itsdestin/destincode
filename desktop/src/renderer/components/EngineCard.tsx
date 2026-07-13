// Local engine install/status card (Plan B). Lives under the 'local' provider
// row in ProvidersSection; Plan C moves it into the Local Models panel.
// Status language is plain words — never status glyphs (standing UX rule).
// Class idioms (text sizes, bg-well surface, accent buttons, border-edge-dim)
// mirror ProvidersSection's own rows so the card reads as part of the section.
import React, { useEffect, useState } from 'react';

interface EngineStatusView {
  installed: boolean;
  installedVersion: string | null;
  pinnedVersion: string;
  backend: string | null;
  state: 'not-installed' | 'stopped' | 'starting' | 'running' | 'error';
  errorMessage?: string;
  cacheDir: string;
}

type Progress =
  | { kind: 'download'; receivedBytes: number; totalBytes: number | null }
  | { kind: 'verify' } | { kind: 'unpack' }
  | { kind: 'done' } | { kind: 'error'; message: string };

// Bytes → whole MB for the download progress line.
const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

export default function EngineCard() {
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

  // Shared runner for install/restart: sets busy, surfaces any thrown error,
  // and clears the transient progress line when the action settles.
  const run = async (fn: () => Promise<any>) => {
    setBusy(true); setError(null);
    try { setStatus(await fn()); }
    catch (e: any) { setError(e?.message ?? String(e)); }
    finally { setBusy(false); setProgress(null); }
  };

  if (!status) return null;

  // Plain-words state line (no glyphs). Running/installed spell out version +
  // backend so the user knows exactly what's on disk.
  const stateLabel =
    status.state === 'not-installed' ? 'Not installed'
    : status.state === 'running' ? `Running · ${status.installedVersion} · ${status.backend}`
    : status.state === 'starting' ? 'Starting…'
    : status.state === 'error' ? (status.errorMessage ?? 'Stopped after repeated crashes')
    : `Installed ${status.installedVersion} · ${status.backend} · stopped (starts on first message)`;

  return (
    <div className="mt-2 rounded-lg border border-edge-dim bg-well px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-xs text-fg font-medium">Local engine (llama.cpp)</p>
          <p className="text-[10px] text-fg-muted">{stateLabel}</p>
        </div>
        {status.state === 'not-installed' && (
          <button
            className="text-[11px] font-medium px-2.5 py-1 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
            disabled={busy}
            onClick={() => run(() => window.claude.engine.install())}
          >
            {busy ? 'Installing…' : 'Install'}
          </button>
        )}
        {status.state === 'error' && (
          <button
            className="text-[11px] font-medium px-2.5 py-1 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-not-allowed shrink-0"
            disabled={busy}
            onClick={() => run(() => window.claude.engine.restart())}
          >
            Restart engine
          </button>
        )}
      </div>
      {busy && progress?.kind === 'download' && (
        <p className="mt-2 text-[10px] text-fg-dim">
          Downloading… {mb(progress.receivedBytes)}{progress.totalBytes ? ` of ${mb(progress.totalBytes)}` : ''}
        </p>
      )}
      {busy && (progress?.kind === 'verify' || progress?.kind === 'unpack') && (
        <p className="mt-2 text-[10px] text-fg-dim">{progress.kind === 'verify' ? 'Verifying download…' : 'Unpacking…'}</p>
      )}
      {error && <p className="mt-2 text-[10px] text-red-500">{error}</p>}
    </div>
  );
}
