// Announces features that aren't bridged to remote access yet.
//
// Most of window.claude's channels have no handler in remote-server.ts. They
// now answer immediately with {ok:false, unsupported:true} rather than hanging
// for 30 seconds, but the answer lands in call sites that largely don't check
// it — ProjectView's listProjectsIndex().then() has no .catch(), account-context
// calls reloadFromStore() as `void` — so without this the user just gets an
// empty panel and no reason for it.
//
// Mount-only; renders nothing until the shim reports something. The shim
// dedupes by feature, so this shows at most one toast per feature per page load
// even for channels polled on a loop.

import { useEffect, useState } from 'react';
import { REMOTE_UNSUPPORTED_EVENT, type RemoteUnsupportedDetail } from '../remote-unsupported';

const VISIBLE_MS = 6000;

export default function RemoteUnsupportedNotice() {
  const [notice, setNotice] = useState<RemoteUnsupportedDetail | null>(null);

  useEffect(() => {
    const onUnsupported = (e: Event) => {
      const detail = (e as CustomEvent).detail as RemoteUnsupportedDetail | undefined;
      if (!detail) return;
      setNotice(detail);
    };
    window.addEventListener(REMOTE_UNSUPPORTED_EVENT, onUnsupported);
    return () => window.removeEventListener(REMOTE_UNSUPPORTED_EVENT, onUnsupported);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), VISIBLE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  if (!notice) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      // Bottom-center, above the input chrome. --vvp-offset keeps it clear of
      // the soft keyboard on a phone, the same way .jump-to-bottom does.
      className="fixed left-1/2 -translate-x-1/2 z-[9500] max-w-[min(28rem,calc(100vw-2rem))] px-3 py-2 rounded-lg bg-panel border border-edge shadow-lg text-[13px] text-fg-2 flex items-start gap-2"
      style={{ bottom: `calc(var(--bottom-chrome-height, 5rem) + var(--vvp-offset, 0px) + 0.75rem)` }}
    >
      <span className="shrink-0 mt-0.5 text-fg-muted" aria-hidden>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
          <circle cx="12" cy="12" r="10" />
          <path strokeLinecap="round" d="M12 8h.01M11 12h1v4h1" />
        </svg>
      </span>
      <span className="min-w-0">{notice.message}</span>
      <button
        type="button"
        onClick={() => setNotice(null)}
        className="shrink-0 -mr-1 -mt-0.5 w-6 h-6 rounded-md inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-inset"
        aria-label="Dismiss"
      >
        ✕
      </button>
    </div>
  );
}
