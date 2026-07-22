import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import SettingsRow from './SettingsRow';
import { Button } from './ui';
import ConnectGithubModal from './ConnectGithubModal';

// Settings → GitHub row (Connected accounts, Phase 3 of the 2026-07-22
// sync-setup overhaul). Sits directly under the WeCoded Account row so the two
// identities the app holds — WeCoded (SyncHub, games, marketplace account) and
// GitHub (sync storage, publishing, bug reports) — are visible and manageable
// in one place. Before this row there was NO GitHub sign-out surface at all.
//
// Status comes from the combined github:status (app token OR gh CLI). The
// Disconnect button only exists for the APP token — a gh CLI login is not our
// credential to delete, so that state gets an explanatory note instead
// (matching the no-forced-migration rule). Desktop + remote only: the Android
// settings stack doesn't mount this (github:* are not-implemented stubs there).

interface GithubStatus {
  installed: boolean;
  authed: boolean;
  login?: string;
  source?: 'app' | 'gh' | null;
  degradedStorage?: boolean;
}

// Same octocat path AccountSection / SignInPromptModal use, so the GitHub
// affordance reads consistently across the app.
function GitHubIcon({ className = 'w-4 h-4 text-fg-muted' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export default function GithubAccountSection() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [open, setOpen] = useState(false);

  const refresh = useCallback(async () => {
    const fn = (window as any).claude?.github?.status;
    if (typeof fn !== 'function') { setStatus(null); return; }
    try { setStatus(await fn()); } catch { setStatus(null); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const subtitle = status === null
    ? 'Checking…'
    : status.authed
      ? `Connected${status.login ? ` as @${status.login}` : ''} — powers sync and publishing`
      : 'Connect to sync across devices and publish themes & skills';

  return (
    <>
      <SettingsRow
        icon={<GitHubIcon />}
        title="GitHub"
        subtitle={subtitle}
        onClick={() => setOpen(true)}
      />
      {open && (
        <GithubPopup
          status={status}
          refresh={refresh}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function GithubPopup({ status, refresh, onClose }: {
  status: GithubStatus | null;
  refresh: () => Promise<void>;
  onClose: () => void;
}) {
  const [showConnect, setShowConnect] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ESC first closes this popup; while the connect modal is stacked on top,
  // ITS own useEscClose is the newer LIFO entry and wins — no clash.
  useEscClose(!showConnect, onClose);

  const handleDisconnect = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await (window as any).claude?.github?.disconnect?.();
      setConfirming(false);
      await refresh();
    } catch (err: any) {
      setError(String(err?.message ?? err));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const connected = !!status?.authed;
  const viaGhCli = connected && status?.source === 'gh';

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-labelledby="github-popup-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-md w-[calc(100%-2rem)] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-edge flex items-center justify-between px-5 py-3">
          <h3 id="github-popup-title" className="text-sm font-semibold text-fg">GitHub</h3>
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

        <div className="p-5 space-y-4">
          <div className="flex items-center gap-3">
            <GitHubIcon className="w-8 h-8 text-fg" />
            <div className="min-w-0">
              <div className="text-sm text-fg font-medium">
                {connected ? (status?.login ? `@${status.login}` : 'Connected') : 'Not connected'}
              </div>
              <div className="text-[11px] text-fg-muted">
                Stores your encrypted sync backups and publishes your themes, skills, and bug reports.
              </div>
            </div>
          </div>

          {/* Keychain-less Linux stores the token as a plain 0600 file — the
              degraded policy is explicit everywhere, including here. */}
          {connected && status?.degradedStorage && (
            <p className="text-[11px] text-amber-500 leading-relaxed">
              Your sign-in is stored without system-keychain encryption on this
              computer (no keychain service was available). It is protected only
              by file permissions.
            </p>
          )}

          {viaGhCli && (
            <p className="text-[11px] text-fg-muted leading-relaxed">
              You're signed in through the GitHub CLI installed on this computer,
              so there's nothing for YouCoded to disconnect here — to sign out,
              run <code className="font-mono">gh auth logout</code> in a terminal.
            </p>
          )}

          {error && <p className="text-[11px] text-red-500">{error}</p>}

          <div className="flex items-center gap-2 pt-1">
            {!connected && (
              <Button size="sm" onClick={() => setShowConnect(true)}>Connect GitHub…</Button>
            )}
            {connected && !viaGhCli && !confirming && (
              <Button variant="secondary" size="sm" onClick={() => setConfirming(true)}>
                Disconnect
              </Button>
            )}
            {confirming && (
              <div className="space-y-2">
                <p className="text-[11px] text-fg-2 leading-relaxed">
                  This removes the saved GitHub sign-in from this device. Sync will
                  pause until you reconnect; your data on GitHub is not deleted.
                </p>
                <div className="flex items-center gap-2">
                  <Button variant="danger" size="sm" disabled={busy} onClick={() => { void handleDisconnect(); }}>
                    {busy ? 'Disconnecting…' : 'Disconnect'}
                  </Button>
                  <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                    Never mind
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
      </OverlayPanel>

      {showConnect && (
        <ConnectGithubModal
          onClose={() => setShowConnect(false)}
          onConnected={() => { void refresh(); }}
        />
      )}
    </>,
    document.body,
  );
}
