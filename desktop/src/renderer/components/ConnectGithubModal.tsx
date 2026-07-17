// desktop/src/renderer/components/ConnectGithubModal.tsx
// Walks a non-developer through connecting GitHub via the device-code flow so
// enabling Sync never dead-ends on "gh is not installed" / "Not signed in to
// GitHub". Everything real happens in the main process (github-auth.ts +
// github-connect.ts); this modal only renders state and relays requests over
// window.claude.github. The access token NEVER reaches the renderer — only the
// public {installed, authed, login} / {userCode, verificationUri, expiresAt} /
// {ok, login?, error?} fields do — so the whole flow works identically over the
// remote WebSocket. The one platform difference is opening the verification URL
// (shell.openExternal on Electron; a copyable link on remote — see below).
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { getPlatform } from '../platform';
import { Button } from './ui';

type Stage = 'checking' | 'gh-missing' | 'code' | 'done' | 'error';

// Typed connect-done reasons → friendly, non-technical copy.
type ConnectError = 'expired' | 'denied' | 'network' | 'cancelled' | 'login-failed';
const ERROR_COPY: Record<ConnectError, string> = {
  expired: 'That code expired — try again.',
  denied: 'Access was denied in the browser.',
  network: "Couldn't reach GitHub — check your connection.",
  cancelled: 'Connection was cancelled — try again.',
  'login-failed': 'Signed in to GitHub but saving the credential failed — try again.',
};

interface Props {
  onClose: () => void;
  /** Fired once GitHub is connected (already-authed on open OR a fresh login).
   *  The SyncPanel uses this to refresh status + re-kick a mid-flight enable. */
  onConnected?: (login?: string) => void;
}

interface ConnectCode {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
}

// Result shape of window.claude.github.installGh().
interface InstallResult {
  ok: boolean;
  restartRequired?: boolean;
  error?: string;
  manual?: string;
}

export default function ConnectGithubModal({ onClose, onConnected }: Props) {
  const gh = (window as any).claude?.github;
  const isElectron = getPlatform() === 'electron';

  const [stage, setStage] = useState<Stage>('checking');
  const [code, setCode] = useState<ConnectCode | null>(null);
  const [login, setLogin] = useState<string | undefined>(undefined);
  const [errorReason, setErrorReason] = useState<ConnectError | null>(null);
  const [copied, setCopied] = useState(false);

  // gh-missing sub-state (install button feedback). Kept local to that stage.
  const [installBusy, setInstallBusy] = useState(false);
  const [installNote, setInstallNote] =
    useState<{ kind: 'restart' | 'manual' | 'error'; text: string } | null>(null);

  // cancelledRef — the async check/connect chains and the close timer must not
  // setState after unmount (the modal can be closed mid-flight).
  const cancelledRef = useRef(false);

  // Success is reached from two places (already-authed on open, and the
  // connect-done push). Centralize so both refresh sync + auto-close the same.
  const succeed = useCallback((who?: string) => {
    if (cancelledRef.current) return;
    setLogin(who);
    setStage('done');
    onConnected?.(who);
    // Auto-close after a beat so the user sees the confirmation. Direct onClose
    // (not the cancel-then-close path) — there's no live flow to abort.
    setTimeout(() => { if (!cancelledRef.current) onClose(); }, 1500);
  }, [onConnected, onClose]);

  // Begin the device flow: ask main for the code + start its polling.
  const startCode = useCallback(async () => {
    setErrorReason(null);
    setCode(null);
    setStage('code');
    try {
      const c: ConnectCode = await gh.connectStart();
      if (cancelledRef.current) return;
      setCode(c);
    } catch (err: any) {
      // connectStart rejects (e.g. startDeviceFlow threw 'network') → show the
      // error state immediately; there's no flow running to emit connect-done.
      if (cancelledRef.current) return;
      const reason = String(err?.message ?? err) as ConnectError;
      setErrorReason(reason in ERROR_COPY ? reason : 'network');
      setStage('error');
    }
  }, [gh]);

  // status() → decide the entry stage. Reused by "Check again" after install.
  const runCheck = useCallback(async () => {
    setInstallNote(null);
    setStage('checking');
    try {
      const s = await gh.status();
      if (cancelledRef.current) return;
      if (s?.authed) { succeed(s.login); return; }
      if (!s?.installed) { setStage('gh-missing'); return; }
      void startCode();
    } catch (err: any) {
      if (cancelledRef.current) return;
      setErrorReason('network');
      setStage('error');
    }
  }, [gh, succeed, startCode]);

  // Mount: run the initial check and subscribe to the connect-done push for the
  // whole lifetime (the push can land while we're on the 'code' screen).
  useEffect(() => {
    cancelledRef.current = false;
    void runCheck();
    const unsub = gh?.onConnectDone?.((p: { ok: boolean; login?: string; error?: string }) => {
      if (cancelledRef.current) return;
      if (p.ok) { succeed(p.login); return; }
      const reason = (p.error ?? 'network') as ConnectError;
      setErrorReason(reason in ERROR_COPY ? reason : 'network');
      setStage('error');
    });
    return () => {
      cancelledRef.current = true;
      unsub?.();
    };
    // Intentionally mount-only — runCheck/succeed are stable enough and we must
    // NOT re-subscribe/re-check on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Every user-initiated close path aborts main's poll first (harmless no-op if
  // no flow is running) so a dangling device-flow poll doesn't keep spinning.
  const handleClose = useCallback(() => {
    try { gh?.connectCancel?.(); } catch { /* fire-and-forget */ }
    onClose();
  }, [gh, onClose]);

  // ESC closes via the shared LIFO stack (no window-level listener).
  useEscClose(true, handleClose);

  const copyCode = useCallback(() => {
    if (!code) return;
    navigator.clipboard?.writeText(code.userCode).then(
      () => { if (!cancelledRef.current) { setCopied(true); setTimeout(() => { if (!cancelledRef.current) setCopied(false); }, 1500); } },
      () => {},
    );
  }, [code]);

  // Windows: actually installs via winget; mac/linux: returns the manual command.
  const handleInstallGh = useCallback(async () => {
    setInstallBusy(true);
    setInstallNote(null);
    try {
      const r: InstallResult = await gh.installGh();
      if (cancelledRef.current) return;
      if (r.ok) { void runCheck(); return; }
      if (r.restartRequired) {
        setInstallNote({ kind: 'restart', text: r.error ?? 'Quit and reopen YouCoded to finish.' });
      } else if (r.manual) {
        setInstallNote({ kind: 'manual', text: r.manual });
      } else {
        setInstallNote({ kind: 'error', text: r.error ?? 'Could not install GitHub CLI.' });
      }
    } catch (err: any) {
      if (!cancelledRef.current) setInstallNote({ kind: 'error', text: String(err?.message ?? err) });
    } finally {
      if (!cancelledRef.current) setInstallBusy(false);
    }
  }, [gh, runCheck]);

  const openVerificationUrl = useCallback(() => {
    if (!code) return;
    // Desktop: hand off to the OS default browser. Remote/Android render a link
    // instead (handled in the JSX) — this path is Electron-only.
    (window as any).claude?.shell?.openExternal?.(code.verificationUri);
  }, [code]);

  return (
    <>
      <Scrim layer={2} onClick={handleClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal
        aria-labelledby="connect-github-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[26rem] max-w-[calc(100vw-2rem)] p-5"
      >
        {/* Header — consistent across every stage */}
        <div className="flex items-start justify-between gap-3">
          <div id="connect-github-title" className="text-sm font-semibold text-fg">Connect GitHub</div>
          <button
            onClick={handleClose}
            aria-label="Close"
            className="text-fg-muted hover:text-fg-2 text-lg leading-none w-6 h-6 flex items-center justify-center rounded hover:bg-inset -mt-1 -mr-1"
          >
            {'✕'}
          </button>
        </div>

        {/* ---- checking ---- */}
        {stage === 'checking' && (
          <div className="mt-4 text-xs text-fg-muted">Checking your GitHub connection…</div>
        )}

        {/* ---- gh-missing ---- */}
        {stage === 'gh-missing' && (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-fg-2 leading-relaxed">
              YouCoded needs GitHub's command-line tool (gh) to connect your account.
            </p>

            {installNote?.kind === 'restart' && (
              <div className="rounded-md border border-edge bg-inset px-3 py-2 text-xs text-fg-dim">
                {installNote.text}
              </div>
            )}
            {installNote?.kind === 'manual' && (
              <div className="space-y-1">
                <div className="text-[11px] text-fg-muted">Run this in your terminal, then choose “Check again”:</div>
                {/* copy-inside-container: the Copy button docks INSIDE the code
                    block instead of floating beside it as a second surface.
                    hover:bg-edge overrides ghost's hover:bg-inset, which would be
                    invisible sitting on an inset container. */}
                <div
                  className="flex items-center gap-2 bg-inset rounded"
                  style={{ padding: '4px 4px 4px 8px' }}
                >
                  <code className="flex-1 font-mono text-xs text-fg-dim break-all">{installNote.text}</code>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="hover:bg-edge shrink-0"
                    onClick={() => navigator.clipboard?.writeText(installNote.text).catch(() => {})}
                  >
                    Copy
                  </Button>
                </div>
              </div>
            )}
            {installNote?.kind === 'error' && (
              <div role="alert" className="text-xs text-red-500">{installNote.text}</div>
            )}

            {/* "Never mind" removed: it called the same handleClose as the ✕ in
                the header, so it was a second way to do one thing. Dialogs with
                an ✕ get no redundant text cancel. */}
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="secondary" onClick={() => void runCheck()} disabled={installBusy}>
                Check again
              </Button>
              {/* This primary had NO hover state at all before. */}
              <Button onClick={() => void handleInstallGh()} disabled={installBusy}>
                {installBusy ? 'Installing…' : 'Install GitHub CLI'}
              </Button>
            </div>
          </div>
        )}

        {/* ---- code (the main state) ---- */}
        {stage === 'code' && (
          <div className="mt-3 space-y-3">
            <p className="text-xs text-fg-2 leading-relaxed">
              Open GitHub and enter this one-time code to connect your account.
            </p>

            {code ? (
              <>
                {/* Big, easy-to-read code (mono). Copy sits alongside it. */}
                <div className="flex items-center gap-2">
                  <div className="flex-1 font-mono text-2xl tracking-[0.25em] text-fg text-center bg-inset rounded-md py-3 select-all">
                    {code.userCode}
                  </div>
                  <button
                    onClick={copyCode}
                    className="text-xs px-3 py-2 rounded bg-inset hover:bg-edge text-fg-2 shrink-0"
                  >
                    {copied ? 'Copied' : 'Copy'}
                  </button>
                </div>

                {isElectron ? (
                  // Desktop — open the OS browser directly.
                  <button
                    onClick={openVerificationUrl}
                    className="w-full text-sm px-3 py-2 rounded bg-accent text-on-accent"
                  >
                    Open github.com/login/device
                  </button>
                ) : (
                  // Remote / touch — no shell access; render a copyable link the
                  // user opens themselves. <a target=_blank> works in a browser.
                  <div className="space-y-1">
                    <div className="text-[11px] text-fg-muted">Then open this address in your browser:</div>
                    <div className="flex items-center gap-2">
                      <a
                        href={code.verificationUri}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="flex-1 text-xs text-accent underline break-all bg-inset px-2 py-1.5 rounded"
                      >
                        {code.verificationUri}
                      </a>
                      <button
                        onClick={() => navigator.clipboard?.writeText(code.verificationUri).catch(() => {})}
                        className="text-xs px-2 py-1 rounded bg-inset hover:bg-edge text-fg-dim shrink-0"
                      >
                        Copy
                      </button>
                    </div>
                  </div>
                )}

                <p className="text-[11px] text-fg-muted">Waiting for you to approve in your browser…</p>
              </>
            ) : (
              <div className="text-xs text-fg-muted">Preparing your code…</div>
            )}

            <div className="flex justify-end pt-1">
              <button
                onClick={handleClose}
                className="text-sm px-3 py-1 rounded text-fg-dim hover:text-fg hover:bg-inset transition-colors"
              >
                Never mind
              </button>
            </div>
          </div>
        )}

        {/* ---- done ---- */}
        {stage === 'done' && (
          <div className="mt-4 space-y-2">
            <p className="text-sm text-fg">
              {login ? <>GitHub connected as <span className="font-medium">{login}</span>.</> : 'GitHub connected.'}
            </p>
            <p className="text-xs text-fg-muted">You're all set — this window will close automatically.</p>
          </div>
        )}

        {/* ---- error ---- */}
        {stage === 'error' && (
          <div className="mt-4 space-y-3">
            <p role="alert" className="text-sm text-fg-2">
              {errorReason ? ERROR_COPY[errorReason] : ERROR_COPY.network}
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={handleClose}
                className="text-sm px-3 py-1 rounded text-fg-dim hover:text-fg hover:bg-inset transition-colors"
              >
                Never mind
              </button>
              <button
                onClick={() => void startCode()}
                className="text-sm px-3 py-1 rounded bg-accent text-on-accent"
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </OverlayPanel>
    </>
  );
}
