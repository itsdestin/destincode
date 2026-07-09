// Post-sign-in handle prompt (spec §2/§6): you need a handle to be
// discoverable, so ask once right after sign-in. Skippable; "skip" persists
// so we never nag. Also catches pre-existing signed-in users without handles.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { useAccount } from '../state/account-context';

// Persisted "don't nag me again" flag. Set on skip (and on ESC, which is the
// same as skip), never set when the user actually claims a handle.
const DISMISS_KEY = 'youcoded-handle-prompt-dismissed';

export default function HandlePrompt() {
  const { signedIn, user, setHandle } = useAccount();
  const [open, setOpen] = useState(false);

  // Once the user answers (skip or save) or ESC-dismisses this session, don't
  // let the effect re-open the prompt — even though refresh() re-fires the
  // effect and (in tests) the mocked profile may still report no handle.
  const closedRef = useRef(false);

  // Effect-driven open: show only when signed in, no handle yet, and not
  // previously dismissed. Recomputes when auth state changes (e.g. right after
  // sign-in completes, or when a refresh reveals a handle-less profile).
  useEffect(() => {
    if (closedRef.current) return;
    const dismissed = localStorage.getItem(DISMISS_KEY) === '1';
    setOpen(Boolean(signedIn && user && !user.handle && !dismissed));
  }, [signedIn, user]);

  if (!open) return null; // render nothing when closed
  return <HandlePromptPopup setHandle={setHandle} closedRef={closedRef} setOpen={setOpen} />;
}

// Mounted only while open so the input's useState initializer seeds cleanly.
function HandlePromptPopup({
  setHandle,
  closedRef,
  setOpen,
}: {
  setHandle: (handle: string) => Promise<void>;
  closedRef: React.MutableRefObject<boolean>;
  setOpen: (open: boolean) => void;
}) {
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Skip (and ESC — registered below) persist the flag so we never nag again.
  const skip = () => {
    localStorage.setItem(DISMISS_KEY, '1');
    closedRef.current = true;
    setOpen(false);
  };

  // ESC dismissal is the same as clicking "Skip for now".
  useEscClose(true, skip);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await setHandle(draft.trim());
      // Claiming a handle is a real answer — close WITHOUT setting the dismissal
      // flag (there's nothing left to nag about).
      closedRef.current = true;
      setOpen(false);
    } catch (err) {
      // 400/409 (taken / reserved / invalid) arrive as the server's message.
      setError(err instanceof Error ? err.message : 'Could not set handle');
    } finally {
      setSaving(false);
    }
  };

  return createPortal(
    <>
      {/* Skip on scrim click so the prompt is genuinely skippable. */}
      <Scrim layer={2} onClick={skip} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-labelledby="handle-prompt-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-sm w-[calc(100%-2rem)] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-5 space-y-4">
          <div className="space-y-1.5">
            <h3 id="handle-prompt-title" className="text-sm font-semibold text-fg">Pick a handle</h3>
            <p className="text-[11px] text-fg-dim leading-relaxed">
              Friends will find you by your handle — like a username. You can change it later in Settings → Account.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 flex items-center bg-inset border border-edge-dim rounded-lg px-3 py-2 focus-within:border-accent">
              <span className="text-xs text-fg-muted select-none">@</span>
              <input
                id="handle-prompt-input"
                aria-label="Handle"
                autoFocus
                value={draft}
                onChange={(e) => { setDraft(e.target.value); setError(null); }}
                onKeyDown={(e) => { if (e.key === 'Enter' && draft.trim().length > 0 && !saving) void save(); }}
                className="flex-1 text-xs bg-transparent text-fg focus:outline-none ml-0.5"
              />
            </div>
            <button
              onClick={() => void save()}
              disabled={saving || draft.trim().length === 0}
              className="text-xs font-medium px-3 py-2 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
          {/* Plain words for status, never glyphs. */}
          {error && <p className="text-[10px] text-red-500">{error}</p>}

          <button
            onClick={skip}
            className="w-full text-xs font-medium py-2 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
          >
            Skip for now
          </button>
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}
