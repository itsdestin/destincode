import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { Scrim, OverlayPanel } from './overlays/Overlay';
import { useEscClose } from '../hooks/use-esc-close';
import { useMarketplaceAuth } from '../state/marketplace-auth-context';
import type { MarketplaceUser } from '../../main/marketplace-auth-store';

// Settings → Account section. One self-contained row-button + popup, mounted in
// both the Desktop and Android settings stacks. Reads all state and actions from
// useMarketplaceAuth(); it never touches window.claude.account directly (the
// context owns the token boundary). Follows the chip+popup pattern used by
// PerformanceButton / SoundButton / AboutPopup — a small settings row that opens
// a centered L2 overlay where the real controls live.

// GitHub octocat mark — same path used in SignInPromptModal / MarketplaceAuthChip
// so the sign-in affordance reads consistently across the app.
function GitHubIcon({ className = 'w-4 h-4' }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

// Generic person glyph for the signed-out row (no avatar to show yet).
function PersonIcon() {
  return (
    <svg className="w-4 h-4 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 3.5-6 8-6s8 2 8 6" />
    </svg>
  );
}

export default function AccountSection() {
  const { signedIn, user } = useMarketplaceAuth();
  const [open, setOpen] = useState(false);

  const rowLabel = 'Account';
  const rowDesc = signedIn
    ? `Signed in as @${user?.handle ?? user?.login ?? ''}`
    : 'Sign in to like themes, rate plugins, and play games';

  return (
    <section>
      <h3 className="text-[10px] font-medium text-fg-muted tracking-wider uppercase mb-3">Account</h3>

      {/* Row button — verbatim class list from the About row (SettingsPanel:2451). */}
      <button
        onClick={() => setOpen(true)}
        className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
      >
        <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
          {signedIn && user?.avatar_url ? (
            // alt="" so the avatar doesn't leak into the button's accessible name.
            <img src={user.avatar_url} alt="" className="w-5 h-5 rounded-full object-cover" />
          ) : (
            <PersonIcon />
          )}
        </div>
        <div className="flex-1 min-w-0">
          <span className="text-xs text-fg font-medium">{rowLabel}</span>
          <p className="text-[10px] text-fg-muted truncate">{rowDesc}</p>
        </div>
        <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
      </button>

      {/* AccountPopup portals itself to document.body (same as AboutPopup) so the
          popup centers over the full viewport, not inside SettingsPanel's
          transformed wrapper. Render directly here — do NOT wrap in a second portal. */}
      {open && <AccountPopup onClose={() => setOpen(false)} />}
    </section>
  );
}

// Mounted only while open, so useState initializers seed cleanly from the current
// user profile (no reset-on-change effect needed).
function AccountPopup({ onClose }: { onClose: () => void }) {
  const { signedIn, user, signInPending, startSignIn, signOut, updateProfile, setHandle, deleteAccount } =
    useMarketplaceAuth();

  useEscClose(true, onClose);

  return createPortal(
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal={true}
        aria-labelledby="account-popup-title"
        className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-md w-[calc(100%-2rem)] max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 border-b border-edge flex items-center justify-between px-5 py-3">
          <h3 id="account-popup-title" className="text-sm font-semibold text-fg">Account</h3>
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

        <div className="scroll-fade">
          <div className="p-5 space-y-5">
            {signedIn && user ? (
              <SignedInBody
                user={user}
                signOut={signOut}
                updateProfile={updateProfile}
                setHandle={setHandle}
                deleteAccount={deleteAccount}
                onClose={onClose}
              />
            ) : (
              <SignedOutBody signInPending={signInPending} startSignIn={startSignIn} />
            )}
          </div>
        </div>
      </OverlayPanel>
    </>,
    document.body,
  );
}

// ── Signed-out ──────────────────────────────────────────────────────────────

function SignedOutBody({
  signInPending,
  startSignIn,
}: {
  signInPending: boolean;
  startSignIn: () => Promise<void>;
}) {
  // Surface sign-in failures (poll timeout, network) inline — previously the
  // void startSignIn() swallowed them and the user saw nothing happen.
  const [signInError, setSignInError] = useState<string | null>(null);
  return (
    <div className="flex flex-col items-center gap-4 py-2 text-center">
      <p className="text-[11px] text-fg-dim leading-relaxed">
        One sign-in for the marketplace and games — GitHub only sees your public profile.
      </p>
      <button
        onClick={() => {
          setSignInError(null);
          startSignIn().catch((e) =>
            setSignInError(e instanceof Error ? e.message : 'sign-in failed'),
          );
        }}
        disabled={signInPending}
        className="flex items-center gap-2 px-4 py-1.5 text-sm font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        <GitHubIcon />
        {signInPending ? 'Signing in…' : 'Sign in with GitHub'}
      </button>
      {signInError && <p className="text-[10px] text-red-500">{signInError}</p>}
    </div>
  );
}

// ── Signed-in ───────────────────────────────────────────────────────────────

function SignedInBody({
  user,
  signOut,
  updateProfile,
  setHandle,
  deleteAccount,
  onClose,
}: {
  // Reuse the canonical profile type instead of a duplicate local interface.
  user: MarketplaceUser;
  signOut: () => Promise<void>;
  updateProfile: (name: string) => Promise<void>;
  setHandle: (handle: string) => Promise<void>;
  deleteAccount: () => Promise<void>;
  onClose: () => void;
}) {
  // Seed drafts from the current profile. Component is remounted each time the
  // popup opens, so these initializers always reflect the latest user.
  const [nameDraft, setNameDraft] = useState(user.display_name ?? user.login);
  const [nameSaving, setNameSaving] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [nameSaved, setNameSaved] = useState(false);

  const [handleDraft, setHandleDraft] = useState(user.handle ?? '');
  const [handleSaving, setHandleSaving] = useState(false);
  const [handleError, setHandleError] = useState<string | null>(null);
  const [handleSaved, setHandleSaved] = useState(false);

  const [deleteExpanded, setDeleteExpanded] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const saveName = async () => {
    setNameSaving(true);
    setNameError(null);
    setNameSaved(false);
    try {
      await updateProfile(nameDraft.trim());
      setNameSaved(true);
    } catch (err) {
      // Surface the server's message verbatim (e.g. validation copy).
      setNameError(err instanceof Error ? err.message : 'Could not save name');
    } finally {
      setNameSaving(false);
    }
  };

  const saveHandle = async () => {
    setHandleSaving(true);
    setHandleError(null);
    setHandleSaved(false);
    try {
      await setHandle(handleDraft.trim());
      setHandleSaved(true);
    } catch (err) {
      // 400/409 (taken / reserved / cooldown) all arrive as the server's message.
      setHandleError(err instanceof Error ? err.message : 'Could not set handle');
    } finally {
      setHandleSaving(false);
    }
  };

  const confirmDelete = async () => {
    setDeleting(true);
    setDeleteError(null);
    try {
      await deleteAccount();
      onClose(); // success — close the popup; the row falls back to signed-out
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Could not delete account');
      setDeleting(false);
    }
  };

  return (
    <>
      {/* Linked-provider list — single provider in Phase 1, non-editable. */}
      <section className="flex items-center gap-3">
        {user.avatar_url ? (
          <img src={user.avatar_url} alt="" className="w-10 h-10 rounded-full object-cover shrink-0" />
        ) : (
          <div className="w-10 h-10 rounded-full bg-inset flex items-center justify-center shrink-0">
            <PersonIcon />
          </div>
        )}
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs text-fg font-medium">
            <GitHubIcon className="w-3.5 h-3.5" />
            <span>Connected: GitHub (@{user.login})</span>
          </div>
          <p className="text-[10px] text-fg-muted">Your linked sign-in provider.</p>
        </div>
      </section>

      <hr className="border-edge-dim" />

      {/* Display name */}
      <section className="space-y-1.5">
        <label htmlFor="account-display-name" className="text-[10px] font-medium text-fg-muted uppercase tracking-wider">
          Display name
        </label>
        <div className="flex items-center gap-2">
          <input
            id="account-display-name"
            aria-label="Display name"
            value={nameDraft}
            onChange={(e) => { setNameDraft(e.target.value); setNameSaved(false); }}
            className="flex-1 text-xs bg-inset border border-edge-dim rounded-lg px-3 py-2 text-fg focus:outline-none focus:border-accent"
          />
          <button
            onClick={() => void saveName()}
            disabled={nameSaving || nameDraft.trim().length === 0}
            className="text-xs font-medium px-3 py-2 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {nameSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {nameError && <p className="text-[10px] text-red-500">{nameError}</p>}
        {nameSaved && !nameError && <p className="text-[10px] text-fg-muted">Saved</p>}
      </section>

      {/* Handle */}
      <section className="space-y-1.5">
        <label htmlFor="account-handle" className="text-[10px] font-medium text-fg-muted uppercase tracking-wider">
          Handle
        </label>
        <div className="flex items-center gap-2">
          <div className="flex-1 flex items-center bg-inset border border-edge-dim rounded-lg px-3 py-2 focus-within:border-accent">
            <span className="text-xs text-fg-muted select-none">@</span>
            <input
              id="account-handle"
              aria-label="Handle"
              value={handleDraft}
              onChange={(e) => { setHandleDraft(e.target.value); setHandleSaved(false); }}
              className="flex-1 text-xs bg-transparent text-fg focus:outline-none ml-0.5"
            />
          </div>
          <button
            onClick={() => void saveHandle()}
            disabled={handleSaving || handleDraft.trim().length === 0}
            className="text-xs font-medium px-3 py-2 rounded-lg bg-accent text-on-accent hover:brightness-110 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {handleSaving ? 'Saving…' : 'Save'}
          </button>
        </div>
        {/* Plain words for status, never glyphs. */}
        {handleError && <p className="text-[10px] text-red-500">{handleError}</p>}
        {handleSaved && !handleError && <p className="text-[10px] text-fg-muted">Saved</p>}
      </section>

      <hr className="border-edge-dim" />

      {/* Sign out */}
      <button
        onClick={() => void signOut()}
        className="w-full text-xs font-medium py-2.5 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
      >
        Sign out
      </button>

      <hr className="border-edge-dim" />

      {/* Danger zone */}
      <section className="space-y-2">
        <h4 className="text-[10px] font-medium text-red-500 uppercase tracking-wider">Danger zone</h4>
        {!deleteExpanded ? (
          <button
            onClick={() => setDeleteExpanded(true)}
            className="w-full text-xs font-medium py-2.5 rounded-lg border border-red-500/50 text-red-500 hover:bg-red-500/10 transition-colors"
          >
            Delete account
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-[11px] text-fg-dim leading-relaxed">
              Deletes your account and everything attached to it — likes, reviews, install history. This cannot be undone.
            </p>
            <label htmlFor="account-delete-confirm" className="block text-[10px] text-fg-muted">
              Type <span className="font-semibold text-fg">delete</span> to confirm
            </label>
            <input
              id="account-delete-confirm"
              aria-label="Type delete to confirm"
              value={deleteConfirm}
              onChange={(e) => setDeleteConfirm(e.target.value)}
              className="w-full text-xs bg-inset border border-edge-dim rounded-lg px-3 py-2 text-fg focus:outline-none focus:border-red-500"
            />
            <div className="flex gap-2">
              <button
                onClick={() => { setDeleteExpanded(false); setDeleteConfirm(''); setDeleteError(null); }}
                className="flex-1 text-xs font-medium py-2.5 rounded-lg border border-edge-dim text-fg-2 hover:bg-inset transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => void confirmDelete()}
                disabled={deleteConfirm.trim() !== 'delete' || deleting}
                className="flex-1 text-xs font-medium py-2.5 rounded-lg bg-red-500 text-white hover:brightness-110 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {deleting ? 'Deleting…' : 'Delete my account'}
              </button>
            </div>
            {deleteError && <p className="text-[10px] text-red-500">{deleteError}</p>}
          </div>
        )}
      </section>
    </>
  );
}
