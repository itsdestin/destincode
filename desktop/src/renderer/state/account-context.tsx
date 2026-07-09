// account-context.tsx
// Global "am I signed in to my YouCoded account?" React context.
//
// WHY the "account" naming: this is the Phase 2 rename. Phase 1 renamed only the
// underlying window.claude surface (marketplaceAuth → account) and deliberately
// left the React-side provider/hook identifiers on their old marketplace names to
// keep that diff small. Phase 2's friends UI builds on the account identity, so
// the React-side rename to AccountProvider / useAccount lands here as a pure
// mechanical change with zero behavior difference.
//
// Uses window.claude.account (exposed via preload + remote-shim) for all
// communication with the main process. The main process owns the token — it never
// crosses the IPC boundary into the renderer.
//
// Polling contract (device-code OAuth flow):
//   1. startSignIn() calls account.start() → receives device_code + auth_url
//   2. A poll loop calls account.poll(device_code) every pollIntervalMs ms
//   3. When poll returns status "complete", refresh() is called to update state
//   4. The loop times out after 15 minutes (POLL_TIMEOUT_MS)

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MarketplaceUser } from "../../main/marketplace-auth-store";

// ── Context shape ─────────────────────────────────────────────────────────────

interface AccountCtx {
  /** Whether the user is currently signed in to their YouCoded account. */
  signedIn: boolean;
  /** The signed-in user's profile, or null if not signed in. */
  user: MarketplaceUser | null;
  /** True while the device-code sign-in flow is in progress. */
  signInPending: boolean;
  /** Kick off the device-code OAuth flow. Resolves when sign-in completes or rejects on timeout/error. */
  startSignIn(): Promise<void>;
  /** Sign out and clear local state. */
  signOut(): Promise<void>;
  /** Update display name; refreshes user state on success. Throws on failure. */
  updateProfile(displayName: string): Promise<void>;
  /** Set/change handle; refreshes user state. Throws with the server's message on 400/409. */
  setHandle(handle: string): Promise<void>;
  /** Delete the account server-side and clear local state. */
  deleteAccount(): Promise<void>;
}

const AccountContext = createContext<AccountCtx | null>(null);

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_POLL_INTERVAL_MS = 2000;
// 15 minutes — matches the typical GitHub device-code expiry window
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

// ── Provider ──────────────────────────────────────────────────────────────────

export function AccountProvider({
  children,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
}: {
  children: React.ReactNode;
  /** Override poll interval — used by tests to speed up the poll loop. */
  pollIntervalMs?: number;
}) {
  const [signedIn, setSignedIn] = useState(false);
  const [user, setUser] = useState<MarketplaceUser | null>(null);
  const [signInPending, setSignInPending] = useState(false);

  // Fix: cancelledRef prevents setState calls and poll-loop IPC calls after unmount.
  // Without this, an in-progress sign-in flow (which can run up to 15 minutes)
  // keeps firing poll() IPC calls and calling setState long after the component is gone.
  const cancelledRef = useRef(false);
  useEffect(() => {
    cancelledRef.current = false;
    return () => {
      cancelledRef.current = true;
    };
  }, []);

  // Refresh auth state from the main process (token + user profile).
  // Called on mount and after sign-in completes.
  const refresh = useCallback(async () => {
    // Note: signedIn() and user() return plain values (NOT ApiResult-wrapped).
    // The main process reads from its in-memory store so these are cheap/fast.
    const isIn = await window.claude.account.signedIn();
    if (cancelledRef.current) return; // unmounted — skip setState
    const profile = await window.claude.account.user();
    if (cancelledRef.current) return; // unmounted — skip setState
    setSignedIn(isIn);
    setUser(profile);
  }, []);

  // Load initial auth state on mount
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Start the device-code OAuth flow.
  // Prevents concurrent flows with signInPending guard.
  const startSignIn = useCallback(async () => {
    if (signInPending) return;
    setSignInPending(true);
    try {
      // Fix: start() returns ApiResult<AuthStartResponse> — must check .ok and
      // read .value; the main process may return an error if the auth server is down.
      const startRes = await window.claude.account.start();
      if (cancelledRef.current) return; // unmounted mid-await — abort before setState
      if (!startRes.ok) {
        throw new Error(`sign-in start failed: ${startRes.message ?? "unknown error"}`);
      }
      const { device_code } = startRes.value;

      const deadline = Date.now() + POLL_TIMEOUT_MS;

      // Poll loop — runs until "complete" or timeout.
      // Fix: each await point checks cancelledRef so an unmount during the 15-minute
      // window stops the loop immediately instead of continuing to burn IPC calls.
      while (true) {
        if (cancelledRef.current) return; // unmounted — stop loop
        if (Date.now() > deadline) {
          throw new Error("sign-in timed out — please try again");
        }

        const pollRes = await window.claude.account.poll(device_code);
        if (cancelledRef.current) return; // unmounted mid-await — stop loop

        if (!pollRes.ok) {
          throw new Error(`sign-in poll failed: ${pollRes.message ?? "unknown error"}`);
        }
        const pollData = pollRes.value;

        if (pollData.status === "complete") {
          // Main process has stored the token — refresh our renderer-side state
          await refresh();
          return;
        }

        // Status is "pending" — wait before polling again
        await new Promise((r) => setTimeout(r, pollIntervalMs));
        if (cancelledRef.current) return; // unmounted during sleep — stop loop
      }
    } finally {
      // Always clear pending flag, even on error or timeout.
      // Guard against setState on unmounted: if cancelled the component is gone
      // but setSignInPending is a no-op at that point (React silently ignores it).
      setSignInPending(false);
    }
  }, [signInPending, pollIntervalMs, refresh]);

  // Sign out — clear token on main process side, then clear local React state.
  // Fix: optimistic sign-out — local state is cleared unconditionally even if
  // the IPC call rejects. This is intentional: a failed signOut() on the main
  // process side is rare and the UX cost of leaving the user "stuck signed in"
  // is worse than the edge-case inconsistency. Do NOT add error propagation here
  // unless the design explicitly requires rollback on failure.
  const signOut = useCallback(async () => {
    // Fix: try/CATCH (not try/finally) so the IPC rejection is SWALLOWED, not
    // re-thrown. void-callers (the "Sign out" button) would otherwise get an
    // unhandled promise rejection — contradicting the "do NOT propagate" contract
    // above. Local state is cleared after the try either way, so a failed
    // main-process signOut still leaves the UI signed out (optimistic).
    try {
      await window.claude.account.signOut();
    } catch (err) {
      console.warn("account.signOut() failed; clearing local state anyway", err);
    }
    setSignedIn(false);
    setUser(null);
  }, []);

  // Update the display name. Unlike signOut, this propagates failure to the caller
  // (the Settings UI shows the error inline) and refreshes user state on success so
  // the new name renders without a manual reload.
  const updateProfile = useCallback(async (displayName: string) => {
    const res = await window.claude.account.updateProfile(displayName);
    if (!res.ok) {
      // Fix: on failure ALSO refresh before re-throwing. A 401 makes the main
      // process clear the local session (dead/expired token); refresh() re-reads
      // signedIn()/user() so the UI flips to signed-out promptly instead of
      // staying stranded "signed in" while every call fails. Non-401 failures
      // (e.g. validation) leave the session intact, so refresh is a cheap no-op.
      await refresh();
      throw new Error(res.message ?? "couldn't update name");
    }
    await refresh();
  }, [refresh]);

  // Claim/change the @handle. Throws with the server's message (e.g. "that handle is
  // taken" on 409) so the Settings UI can surface it verbatim; refreshes on success.
  const setHandle = useCallback(async (handle: string) => {
    const res = await window.claude.account.setHandle(handle);
    if (!res.ok) {
      // Fix: on failure ALSO refresh before re-throwing — a 401 cleared the local
      // session in the main process, so refresh() flips the UI to signed-out
      // instead of leaving the post-sign-in handle prompt stuck showing "invalid
      // token" with no way out (the exact migration bug). Non-401 failures (e.g.
      // "handle taken") keep the session, so refresh is a cheap no-op there.
      await refresh();
      throw new Error(res.message ?? "couldn't set handle");
    }
    await refresh();
  }, [refresh]);

  // Permanent hard-delete. Main clears the local session too, but we also clear
  // renderer state immediately so the UI reflects the signed-out state at once.
  const deleteAccount = useCallback(async () => {
    const res = await window.claude.account.deleteAccount();
    if (!res.ok) {
      // Same 401 escape hatch as updateProfile/setHandle: a dead token makes
      // main clear the local session, so refresh() flips the UI to signed-out
      // instead of stranding the user retrying delete against "invalid token".
      await refresh();
      throw new Error(res.message ?? "couldn't delete account");
    }
    setSignedIn(false);
    setUser(null);
  }, [refresh]);

  // Fix: memoize context value so consumers only re-render when signedIn / user /
  // signInPending actually change. Action fns (startSignIn, signOut, updateProfile,
  // setHandle, deleteAccount) are stable useCallback references, so they don't break
  // the memo comparison. Matches the pattern used in ThemeProvider (theme-context.tsx).
  const value = useMemo<AccountCtx>(
    () => ({ signedIn, user, signInPending, startSignIn, signOut, updateProfile, setHandle, deleteAccount }),
    [signedIn, user, signInPending, startSignIn, signOut, updateProfile, setHandle, deleteAccount],
  );

  return (
    <AccountContext.Provider value={value}>
      {children}
    </AccountContext.Provider>
  );
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/** Access account auth state and actions from any component inside AccountProvider. */
export function useAccount(): AccountCtx {
  const ctx = useContext(AccountContext);
  if (!ctx) {
    throw new Error(
      "useAccount must be used inside <AccountProvider>"
    );
  }
  return ctx;
}
