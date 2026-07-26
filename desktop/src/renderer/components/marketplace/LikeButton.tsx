// LikeButton.tsx
// Heart icon toggle for themes. Optimistic update with server reconciliation.
//
// Props:
//   themeId       — slug/id passed to the API
//   initialLiked  — local starting state (default false; backend doesn't currently
//                   expose per-user liked state so this is best-effort)
//   initialCount  — like count from useMarketplaceStats().themes[themeId]?.likes ?? 0
//
// Behavior:
//   - Signed out:   click opens SignInPromptModal with "Sign in to YouCoded" CTA.
//                   Used to be a silent inline toast that was easy to miss and had
//                   no way to actually start the sign-in flow.
//   - Signed in:    flips state immediately (optimistic), calls window.claude.marketplaceApi.likeTheme()
//       ok + liked:true   → reconcile, increment count
//       ok + liked:false  → reconcile, decrement count (backend toggled back)
//       err 401           → revert, open SignInPromptModal (token was rejected)
//       err other         → revert, show "Couldn't like theme — try again" toast
//   - Disables button during in-flight request to prevent double-clicks

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useAccount } from '../../state/account-context';
import SignInPromptModal from './SignInPromptModal';
import { Toast } from '../ui';

// ── Local toast state (no global toast context available inside the modal) ────
//
// Change 44: this used to be a whole hand-rolled toast — its own setTimeout, its
// own unmount cleanup, its own bg-panel/border/shadow at text-3xs, and its own
// z-index. The <Toast> primitive owns all of that now, so what is left here is
// just "which message, if any". The `nonce` exists because the primitive re-arms
// its timer when the MESSAGE changes: both call sites below show the same string,
// so without it a second failure inside the 3s window would inherit whatever was
// left of the first one's timer instead of getting a fresh read.

function useLocalToast() {
  const [toast, setToast] = useState<{ message: string; nonce: number } | null>(null);
  const showToast = useCallback((message: string) => {
    setToast((prev) => ({ message, nonce: (prev?.nonce ?? 0) + 1 }));
  }, []);
  return { toast, showToast, clearToast: useCallback(() => setToast(null), []) };
}

// ── Heart SVG icons ───────────────────────────────────────────────────────────

function HeartFilled({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M8 14.25l-.345-.666C3.5 9.402 1 7.16 1 4.5a3.5 3.5 0 0 1 5.5-2.878A3.5 3.5 0 0 1 15 4.5c0 2.66-2.5 4.902-6.655 9.084L8 14.25z" />
    </svg>
  );
}

function HeartOutline({ size = 14 }: { size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
    >
      <path d="M8 14.25l-.345-.666C3.5 9.402 1 7.16 1 4.5a3.5 3.5 0 0 1 5.5-2.878A3.5 3.5 0 0 1 15 4.5c0 2.66-2.5 4.902-6.655 9.084L8 14.25z" />
    </svg>
  );
}

// ── LikeButton ────────────────────────────────────────────────────────────────

interface LikeButtonProps {
  themeId: string;
  initialLiked?: boolean;
  initialCount: number;
}

export default function LikeButton({ themeId, initialLiked = false, initialCount }: LikeButtonProps) {
  const { signedIn } = useAccount();

  const [liked, setLiked] = useState(initialLiked);
  const [count, setCount] = useState(initialCount);
  const [inFlight, setInFlight] = useState(false);
  // Signed-out users get a real modal CTA instead of a fly-by toast — the toast
  // had no actual sign-in button and was widely missed.
  const [signInPromptOpen, setSignInPromptOpen] = useState(false);

  const { toast, showToast, clearToast } = useLocalToast();

  // cancelledRef — prevents setState after unmount if a slow API call returns late
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  // Sync external count updates (stats-context loading late) into local state.
  // Skip while a like is in flight so we don't clobber the optimistic +/-1 delta.
  useEffect(() => {
    if (!inFlight) setCount(initialCount);
  }, [initialCount, inFlight]);

  // Note: initialLiked is NOT synced here intentionally. The backend doesn't expose
  // per-user liked state today, so initialLiked is always undefined → false. Adding
  // a sync effect for it would cause a re-render storm on every stats reload with no
  // benefit. Revisit when the backend exposes per-user liked state.

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    // Stop click from bubbling up to MarketplaceCard's onClick (which opens detail)
    e.stopPropagation();

    // Signed-out guard: open the sign-in prompt modal instead of the API call.
    // The prompt has an actual "Sign in to YouCoded" button that kicks off the
    // device-code OAuth flow.
    if (!signedIn) {
      setSignInPromptOpen(true);
      return;
    }

    if (inFlight) return;

    // ── Optimistic update ─────────────────────────────────────────────────────
    const prevLiked = liked;
    const prevCount = count;
    const nextLiked = !liked;
    const nextCount = nextLiked ? count + 1 : count - 1;

    setLiked(nextLiked);
    setCount(Math.max(0, nextCount));
    setInFlight(true);

    try {
      const res = await window.claude.marketplaceApi.likeTheme(themeId);

      if (cancelledRef.current) return;

      if (res.ok) {
        // Reconcile with server: server is authoritative on the final liked state
        const serverLiked = res.value.liked;
        setLiked(serverLiked);
        // Adjust count based on reconciliation vs. our optimistic prediction
        if (serverLiked !== nextLiked) {
          // Server toggled differently than we predicted (unusual but possible)
          setCount(serverLiked ? prevCount + 1 : Math.max(0, prevCount - 1));
        }
        // If server matches our prediction, count is already correct — no update needed
      } else {
        // API error — revert optimistic update
        setLiked(prevLiked);
        setCount(prevCount);

        if (res.status === 401) {
          // Server rejected our token (expired/revoked) — surface the prompt
          // modal so the user can re-auth without hunting for the chip.
          setSignInPromptOpen(true);
        } else {
          showToast("Couldn't like theme — try again");
        }
      }
    } catch {
      // Network or unexpected error — revert
      if (cancelledRef.current) return;
      setLiked(prevLiked);
      setCount(prevCount);
      showToast("Couldn't like theme — try again");
    } finally {
      if (!cancelledRef.current) setInFlight(false);
    }
  }, [signedIn, inFlight, liked, count, themeId, showToast]);

  // ── Tooltip for signed-out state (shown on hover via title attribute) ────────
  const title = !signedIn ? 'Sign in to like themes' : liked ? 'Unlike' : 'Like';

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        disabled={inFlight}
        title={title}
        aria-label={liked ? `Unlike (${count})` : `Like (${count})`}
        aria-pressed={liked}
        className={`flex items-center gap-1 px-1.5 py-0.5 rounded-md text-3xs font-medium transition-colors disabled:opacity-50 ${
          liked
            ? 'text-red-400 hover:text-red-300'
            : 'text-fg-muted hover:text-red-400'
        }`}
      >
        {liked ? <HeartFilled size={12} /> : <HeartOutline size={12} />}
        <span>{count > 0 ? count : ''}</span>
      </button>

      {/* Inline toast — shown briefly on non-auth errors only. Auth errors now
          open the SignInPromptModal below instead of using this toast.

          Change 44: the `anchored` variant IS this site — the primitive was built
          with it in mind. The hand-rolled `zIndex: 62` is gone with it: that
          number was reverse-engineered from CONTENT_Z[2] + 1 to clear the parent
          OverlayPanel, which is exactly the kind of magic z-index design rule 11
          exists to stop. It also grows text-3xs -> text-sm, matching every other
          toast in the app instead of being a third size. */}
      {toast && (
        <Toast
          key={toast.nonce}
          variant="anchored"
          tone="error"
          message={toast.message}
          onDismiss={clearToast}
        />
      )}

      <SignInPromptModal
        open={signInPromptOpen}
        onClose={() => setSignInPromptOpen(false)}
        title="Sign in to like themes"
        message="Liking themes lets the community see what's popular. Sign in with your GitHub account to like this and other themes."
      />
    </div>
  );
}
