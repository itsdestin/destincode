import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import BrailleSpinner from '../BrailleSpinner';
import { GameConnection } from '../../state/game-types';
import { mergeFriends, statusLabel } from './friends-data';
import type { FriendRow, RequestsPayload } from '../../state/marketplace-api-client';

// Local mirror of the renderer/main ApiResult shape (useIpc.ts declares it but
// doesn't export it — keeping a copy avoids importing across that boundary).
type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; message: string };

interface Props {
  connection: GameConnection;
  incognito?: boolean;
  onToggleIncognito?: () => void;
}

// Classify the lobby error so the hint matches the actual cause.
// Tone rules for this screen (Destin's direction):
//  - no jargon, no "error codes" in the user-facing hint
//  - don't catastrophize — most of these resolve themselves in seconds
//  - tell the user what *they* can do, not what the code is doing
// The raw code stays in the headline string (from the reducer) for
// debugging, but the hint below it is always plain language.
function classifyPartyError(msg: string | null): { hint: string } {
  // Note: the not-signed-in case is no longer an error — it's handled by the
  // SignInScreen gate in GameLobby (identity comes from the marketplace sign-in,
  // not the gh CLI), so there's no "sign in from a terminal" branch here anymore.
  const text = (msg ?? '').toLowerCase();
  if (text.includes('code 1011') || text.includes('code 500') || text.includes('code 1012') || text.includes('code 1013')) {
    return { hint: 'The game server is taking a breather. This usually fixes itself in a minute.' };
  }
  if (text.includes('code 1006') || text.includes('code 1015') || text.includes('lost the connection') || text.includes('lost connection')) {
    return { hint: "Looks like the internet hiccuped. We'll keep trying — you can also hit Retry." };
  }
  if (text.includes('code 4000')) {
    return { hint: 'Something got mixed up signing in. Try reloading the app.' };
  }
  return { hint: "Hang tight — we'll keep trying in the background." };
}

function ErrorScreen({ connection }: { connection: GameConnection }) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const { hint } = classifyPartyError(state.partyError);
  // Track retries so we can offer a harder reload after repeated failures —
  // partysocket reconnect can fail forever if e.g. the host name is bad or the
  // user is rate-limited. After 2 manual retries we surface "Reload app" too.
  const [retryCount, setRetryCount] = useState(0);
  const [retrying, setRetrying] = useState(false);

  const handleRetry = () => {
    setRetryCount(n => n + 1);
    setRetrying(true);
    connection.reconnectLobby();
    // Re-arm after a short window so the spinner clears whether or not we
    // reconnect. PARTY_CONNECTED will swap the screen out from under us.
    setTimeout(() => setRetrying(false), 4000);
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-8">
      <div className="w-16 h-16 rounded-full bg-red-900/30 flex items-center justify-center">
        <span className="text-2xl">!</span>
      </div>
      <p className="text-sm text-red-400 text-center">{state.partyError}</p>
      <p className="text-xs text-fg-muted text-center max-w-xs">{hint}</p>
      <div className="flex gap-2 mt-1 items-center">
        <button
          onClick={handleRetry}
          disabled={retrying}
          className="text-xs text-[#66AAFF] hover:text-[#88CCFF] transition-colors disabled:opacity-50"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
        {retryCount >= 2 && (
          <button
            onClick={() => window.location.reload()}
            className="text-xs text-amber-400 hover:text-amber-300 transition-colors"
            title="Hard reload the renderer — drops all in-memory state"
          >
            Reload app
          </button>
        )}
        <button
          onClick={() => dispatch({ type: 'CLEAR_CHALLENGE' })}
          className="text-xs text-fg-muted hover:text-fg-2 transition-colors"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

// Per-friend "…" row menu. Manages its own open + block-confirm state and
// closes on outside click (anchored popover pattern from MarketplaceAuthChip —
// no Scrim because it's anchored, not centered). Block is consequence-gated:
// the menu item swaps the popover to a plain-language confirm BEFORE acting
// (Destin's standing rule for destructive/hard-to-reverse actions).
function FriendRowMenu({ onUnfriend, onBlock }: { onUnfriend: () => void; onBlock: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmingBlock, setConfirmingBlock] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setConfirmingBlock(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const close = () => { setOpen(false); setConfirmingBlock(false); };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="More"
        aria-label="Friend options"
        className="text-fg-muted hover:text-fg-2 px-1 transition-colors"
      >
        ⋯
      </button>
      {open && (
        <div
          role="menu"
          className="layer-surface absolute right-0 top-full mt-1 min-w-[220px] rounded-md p-1.5 text-xs shadow-md"
          // z-index 62 = one above L2 popup content (61), same as the
          // MarketplaceAuthChip popover — clears any L1 drawer overlap.
          style={{ zIndex: 62 }}
        >
          {confirmingBlock ? (
            <div className="flex flex-col gap-2 p-1">
              <p className="text-fg-2 leading-snug">
                Blocking removes this friend, cancels pending requests, and hides you
                from each other. You can unblock later in Settings → Account.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => { onBlock(); close(); }}
                  className="flex-1 bg-red-600 hover:bg-red-500 text-white font-medium rounded py-1 transition-colors"
                >
                  Block
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmingBlock(false)}
                  className="flex-1 bg-inset hover:bg-edge text-fg-2 rounded py-1 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => { onUnfriend(); close(); }}
                className="w-full text-left px-2 py-1 rounded text-fg-2 hover:text-fg hover:bg-inset transition-colors"
              >
                Unfriend
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => setConfirmingBlock(true)}
                className="w-full text-left px-2 py-1 rounded text-red-400 hover:bg-inset transition-colors"
              >
                Block
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// The lobby is the friends list now (spec §6): add-by-handle, incoming/outgoing
// requests, and challenge buttons gated to online friends. Presence relays only
// ONLINE FRIENDS, so onlineUsers is merged onto the server friends list to light
// up "Online" / "In game" and the Challenge button.
function FriendsScreen({ connection, incognito, onToggleIncognito }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const [joinCode, setJoinCode] = useState('');

  const [friends, setFriends] = useState<FriendRow[] | null>(null);
  const [requests, setRequests] = useState<RequestsPayload | null>(null);
  const [addHandle, setAddHandle] = useState('');
  // Add-friend inline feedback: plain sentence + tone (ok=green, else red).
  const [addFeedback, setAddFeedback] = useState<{ text: string; ok: boolean } | null>(null);
  // Per-row error strings keyed by request/friend id (rendered under the row).
  const [rowError, setRowError] = useState<Record<string, string>>({});

  // Fetch both lists in parallel; called on mount and after every mutation.
  const refresh = useCallback(async () => {
    const [fr, rq] = await Promise.all([
      window.claude.social.listFriends(),
      window.claude.social.listRequests(),
    ]);
    if (fr.ok) setFriends(fr.value);
    if (rq.ok) setRequests(rq.value);
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Refresh when presence shows an online user who ISN'T a known friend yet — a
  // request I sent was just accepted (the server pokes visibility ahead of my
  // list refetch). friendIdsRef avoids re-running purely on the friends array
  // reference changing, so this can't tight-loop; it settles once the new friend
  // lands in the list. Self can appear in onlineUsers, so exclude it by tag.
  const friendIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    friendIdsRef.current = new Set((friends ?? []).map(f => f.id));
  }, [friends]);
  useEffect(() => {
    const hasUnknownOnline = state.onlineUsers.some(
      u => u.name !== state.username && !friendIdsRef.current.has(u.id),
    );
    if (hasUnknownOnline) void refresh();
  }, [state.onlineUsers, state.username, refresh]);

  // Shared mutation runner for accept/decline/cancel/unfriend/block: on failure
  // stash a plain sentence under the row; on success clear it and refresh.
  const runMutation = useCallback(async (
    fn: () => Promise<ApiResult<unknown>>,
    key: string,
    fallback = 'Something went wrong. Try again.',
  ) => {
    const res = await fn();
    if (!res.ok) {
      setRowError(prev => ({ ...prev, [key]: res.message || fallback }));
      return;
    }
    setRowError(prev => { const next = { ...prev }; delete next[key]; return next; });
    await refresh();
  }, [refresh]);

  // Add a friend by exact handle. Maps the Worker's status codes to human copy.
  const submitAddFriend = useCallback(async () => {
    const handle = addHandle.trim();
    if (!handle) return;
    const res = await window.claude.social.sendRequest(handle);
    if (res.ok) {
      setAddFeedback({
        text: res.value.status === 'friends' ? `You're now friends with @${handle}` : 'Request sent',
        ok: true,
      });
      setAddHandle('');
      await refresh();
      return;
    }
    // 404 = unknown or blocked handle (no enumeration oracle — same message).
    // 429 = daily request cap. 400 = a validation reason the server phrases well
    // ("that's you"). Anything else falls back to the server message.
    const text =
      res.status === 404 ? 'No one has that handle' :
      res.status === 429 ? 'Daily request limit reached — try tomorrow' :
      res.status === 400 ? (res.message || "That request can't be sent") :
      (res.message || 'Could not send the request. Try again.');
    setAddFeedback({ text, ok: false });
  }, [addHandle, refresh]);

  const merged = mergeFriends(friends ?? [], state.onlineUsers);
  const incoming = requests?.incoming ?? [];
  const outgoing = requests?.outgoing ?? [];
  const loaded = friends !== null;
  const isEmpty = loaded && merged.length === 0 && incoming.length === 0 && outgoing.length === 0;

  return (
    <div className="flex flex-col gap-0">
      {/* Player info bar */}
      <div className="px-3 py-2 border-b border-edge flex items-center justify-between">
        <div className="flex items-center gap-2">
          {/* Show green only when actually connected — not just non-incognito */}
          <div className={`w-2 h-2 rounded-full ${incognito || !state.connected ? 'bg-fg-faint' : 'bg-green-400'}`} />
          <span className="text-sm font-medium text-fg">{state.username}</span>
          {incognito && <span className="text-[10px] text-fg-muted">Incognito</span>}
        </div>
        {onToggleIncognito && (
          <button
            onClick={onToggleIncognito}
            className={`text-[10px] px-1.5 py-0.5 rounded-sm transition-colors ${
              incognito
                ? 'bg-inset text-fg-2 hover:bg-edge'
                : 'text-fg-muted hover:text-fg-2'
            }`}
            title={incognito ? 'Go online — appear to friends' : 'Go incognito — hide from friends'}
          >
            {incognito ? 'Go Online' : 'Go Incognito'}
          </button>
        )}
      </div>

      {/* Incoming challenge — challengeFrom is account identity: .id is the
          stable key passed to respondToChallenge, .name the visible tag, and
          .handle is now carried so we can render @handle alongside. */}
      {state.challengeFrom && (
        <div className="px-3 py-2 border-b border-edge bg-indigo-950/50">
          <p className="text-sm text-fg mb-2">
            <span className="font-medium text-[#66AAFF]">{state.challengeFrom.name}</span>
            {state.challengeFrom.handle && (
              <span className="text-fg-muted text-xs ml-1">@{state.challengeFrom.handle}</span>
            )}
            <span> wants to play!</span>
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => {
                connection.respondToChallenge(state.challengeFrom!.id, true);
                connection.joinGame(state.challengeCode!);
                dispatch({ type: 'CLEAR_CHALLENGE' });
              }}
              className="flex-1 bg-green-600 hover:bg-green-500 text-white text-xs font-medium rounded-lg py-1.5 transition-colors"
            >
              Accept
            </button>
            <button
              onClick={() => { connection.respondToChallenge(state.challengeFrom!.id, false); dispatch({ type: 'CLEAR_CHALLENGE' }); }}
              className="flex-1 bg-inset hover:bg-edge text-fg-2 text-xs font-medium rounded-lg py-1.5 transition-colors"
            >
              Decline
            </button>
          </div>
        </div>
      )}

      {/* Challenge declined notification */}
      {state.challengeDeclinedBy && (
        <div className="px-3 py-2 border-b border-edge">
          <p className="text-xs text-fg-dim">
            <span className="text-fg-2">{state.challengeDeclinedBy.name}</span> declined your challenge.
            <button onClick={() => dispatch({ type: 'CLEAR_CHALLENGE' })} className="text-[#66AAFF] ml-1">Dismiss</button>
          </p>
        </div>
      )}

      {/* Create / Join by room code — kept for playing with someone you'd rather
          share a one-off code with than add as a friend (challenge covers the
          friends path). */}
      <div className="px-3 py-3 border-b border-edge flex flex-col gap-2">
        <button
          onClick={() => connection.createGame()}
          className="w-full bg-accent hover:bg-accent text-on-accent text-sm font-medium rounded-lg py-2 transition-colors"
        >
          Create Game
        </button>
        <div className="flex gap-2">
          <input
            type="text"
            value={joinCode}
            onChange={(e) => setJoinCode(e.target.value.toUpperCase())}
            placeholder="Room code"
            maxLength={6}
            className="flex-1 bg-well border border-edge rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-fg-dim transition-colors uppercase tracking-widest"
          />
          <button
            onClick={() => { if (joinCode.trim()) connection.joinGame(joinCode.trim()); }}
            disabled={!joinCode.trim()}
            className="bg-inset hover:bg-edge disabled:opacity-40 disabled:cursor-not-allowed text-fg text-sm font-medium rounded-lg px-3 py-2 transition-colors"
          >
            Join
          </button>
        </div>
      </div>

      {/* Incoming friend requests */}
      {incoming.length > 0 && (
        <div className="px-3 py-2 border-b border-edge">
          <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-2">Friend requests</div>
          <ul className="flex flex-col gap-2">
            {incoming.map((req) => (
              <li key={req.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-2 truncate flex-1 min-w-0">
                    {req.from.display_name}
                    {req.from.handle && <span className="text-fg-muted ml-1">@{req.from.handle}</span>}
                  </span>
                  <button
                    onClick={() => runMutation(() => window.claude.social.acceptRequest(req.id), req.id, "Couldn't accept — try again")}
                    className="text-[10px] text-green-400 hover:text-green-300 transition-colors shrink-0"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => runMutation(() => window.claude.social.declineRequest(req.id), req.id, "Couldn't decline — try again")}
                    className="text-[10px] text-fg-muted hover:text-fg-2 transition-colors shrink-0"
                  >
                    Decline
                  </button>
                </div>
                {rowError[req.id] && <p className="text-xs text-red-400">{rowError[req.id]}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Add a friend by handle */}
      <div className="px-3 py-3 border-b border-edge flex flex-col gap-2">
        <div className="text-[10px] uppercase tracking-wider text-fg-muted">Add a friend</div>
        <div className="flex gap-2">
          <input
            type="text"
            value={addHandle}
            // Handles are lowercase — normalize as the user types so the exact-match
            // lookup on the Worker doesn't 404 on a stray capital.
            onChange={(e) => setAddHandle(e.target.value.toLowerCase())}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitAddFriend(); }}
            placeholder="friend's handle"
            className="flex-1 bg-well border border-edge rounded-lg px-3 py-2 text-sm text-fg placeholder-fg-muted outline-none focus:border-fg-dim transition-colors"
          />
          <button
            onClick={() => void submitAddFriend()}
            disabled={!addHandle.trim()}
            className="bg-inset hover:bg-edge disabled:opacity-40 disabled:cursor-not-allowed text-fg text-sm font-medium rounded-lg px-3 py-2 transition-colors"
          >
            Send request
          </button>
        </div>
        {addFeedback && (
          <p className={`text-xs ${addFeedback.ok ? 'text-green-400' : 'text-red-400'}`}>{addFeedback.text}</p>
        )}
      </div>

      {/* Friends list */}
      {merged.length > 0 && (
        <div className="px-3 py-2 border-b border-edge">
          <div className="text-[10px] uppercase tracking-wider text-fg-muted mb-2">Friends ({merged.length})</div>
          <ul className="flex flex-col gap-2">
            {merged.map((row) => (
              <li key={row.id} className="flex flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-2 truncate flex-1 min-w-0">
                    {row.name}
                    {row.handle && <span className="text-fg-muted ml-1">@{row.handle}</span>}
                  </span>
                  {/* Challenge only when the friend is actually online (has a live
                      presence entry). row.id is the account id challengePlayer wants. */}
                  {row.online && (
                    <button
                      onClick={() => connection.challengePlayer(row.id)}
                      className="text-[10px] text-[#66AAFF] hover:text-[#88CCFF] transition-colors shrink-0"
                    >
                      Challenge
                    </button>
                  )}
                  <FriendRowMenu
                    onUnfriend={() => runMutation(() => window.claude.social.unfriend(row.id), row.id, "Couldn't unfriend — try again")}
                    onBlock={() => runMutation(() => window.claude.social.block(row.id), row.id, "Couldn't block — try again")}
                  />
                </div>
                {/* Plain-word status — never glyphs (workspace rule). */}
                <span className="text-[10px] text-fg-muted">{statusLabel(row, Date.now())}</span>
                {rowError[row.id] && <p className="text-xs text-red-400">{rowError[row.id]}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Sent (outgoing) requests — dim, collapsed-feeling */}
      {outgoing.length > 0 && (
        <div className="px-3 py-2 border-b border-edge">
          <div className="text-[10px] uppercase tracking-wider text-fg-faint mb-2">Sent requests</div>
          <ul className="flex flex-col gap-1">
            {outgoing.map((req) => (
              <li key={req.id} className="flex flex-col gap-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-fg-dim truncate flex-1 min-w-0">
                    @{req.to.handle ?? req.to.display_name}
                  </span>
                  <button
                    onClick={() => runMutation(() => window.claude.social.cancelRequest(req.id), req.id, "Couldn't cancel — try again")}
                    className="text-[10px] text-fg-muted hover:text-fg-2 transition-colors shrink-0"
                  >
                    Cancel
                  </button>
                </div>
                {rowError[req.id] && <p className="text-xs text-red-400">{rowError[req.id]}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Empty state — no friends and no requests in either direction */}
      {isEmpty && (
        <div className="px-3 py-6">
          <p className="text-xs text-fg-faint text-center leading-relaxed">
            No friends yet. Ask a friend for their handle and add them above.
          </p>
        </div>
      )}
    </div>
  );
}

function JoiningScreen({ connection }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setTimedOut(true), 120_000);
    return () => clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (timedOut) {
      connection.leaveGame();
      dispatch({ type: 'RETURN_TO_LOBBY' });
    }
  }, [timedOut, connection, dispatch]);

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-4 py-8">
      <div className="flex flex-col items-center gap-3">
        <p className="text-xs text-fg-muted uppercase tracking-wider">Joining Room</p>
        <p className="text-lg font-mono font-bold text-fg tracking-widest">{state.roomCode}</p>
      </div>

      <div className="flex flex-col items-center gap-2">
        <BrailleSpinner size="lg" />
        <p className="text-sm text-fg-dim">Connecting...</p>
      </div>

      <button
        onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
        className="text-sm text-fg-muted hover:text-fg-2 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

function WaitingScreen({ connection }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const code = state.roomCode ?? '';
  const [copied, setCopied] = useState(false);

  const copyCode = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-6 px-4 py-8">
      <div className="flex flex-col items-center gap-3">
        <p className="text-xs text-fg-muted uppercase tracking-wider">Room Code</p>
        <div className="flex gap-1.5">
          {code.split('').map((ch, i) => (
            <span
              key={i}
              className="w-9 h-10 flex items-center justify-center bg-inset border border-edge rounded-lg text-lg font-mono font-bold text-fg"
            >
              {ch}
            </span>
          ))}
        </div>
        <button
          onClick={copyCode}
          className="text-xs text-[#66AAFF] hover:text-[#88CCFF] transition-colors"
        >
          {copied ? 'Copied!' : 'Copy Code'}
        </button>
      </div>

      <div className="flex flex-col items-center gap-2">
        <BrailleSpinner size="lg" />
        <p className="text-sm text-fg-dim">Waiting for opponent...</p>
      </div>

      <button
        onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
        className="text-sm text-fg-muted hover:text-fg-2 transition-colors"
      >
        Cancel
      </button>
    </div>
  );
}

// Shown when the user isn't signed in to the marketplace. Games use the
// marketplace GitHub identity as the player tag, so there's nothing to connect
// with until they sign in — a clean gate, not an error. The button launches the
// in-app browser sign-in (no terminal / gh CLI needed); the lobby hook reacts to
// the sign-in flipping and connects automatically once it completes.
function SignInScreen() {
  const { signInPending, signInError, startSignIn } = useAccount();

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-8">
      <div className="w-16 h-16 rounded-full bg-inset flex items-center justify-center">
        <span className="text-2xl">🎮</span>
      </div>
      <p className="text-sm text-fg text-center">Sign in to play</p>
      <p className="text-xs text-fg-muted text-center max-w-xs">
        Games use your GitHub name as your player tag.
      </p>
      <button
        onClick={() => { void startSignIn(); }}
        disabled={signInPending}
        className="bg-accent hover:bg-accent text-on-accent text-sm font-medium rounded-lg px-4 py-2 transition-colors disabled:opacity-50"
      >
        {signInPending ? 'Signing in…' : 'Sign in with GitHub'}
      </button>
      {/* knowledge-debt #6: surface a failed sign-in instead of silently swallowing it. */}
      {signInError && !signInPending && (
        <p className="text-xs text-red-400 text-center max-w-xs">Sign-in failed: {signInError}. Try again.</p>
      )}
    </div>
  );
}

export default function GameLobby({ connection, incognito, onToggleIncognito }: Props) {
  const state = useGameState();
  const { signedIn } = useAccount();
  // Sign-in gate comes BEFORE the error/spinner branches — not being signed in
  // isn't a failure or a slow connection, it's a prerequisite. Incognito keeps
  // its own UI (you don't need to sign in to stay intentionally disconnected).
  if (!incognito && !signedIn) return <SignInScreen />;
  if (state.partyError && !incognito) return <ErrorScreen connection={connection} />;
  if (state.screen === 'joining') return <JoiningScreen connection={connection} />;
  if (state.screen === 'waiting') return <WaitingScreen connection={connection} />;
  // Show connecting spinner while the platform layer opens the presence socket
  // (setup screen, not incognito). The slow-connect hint that used to live here
  // was tied to the retired PartyKit client's HTTP probe — removed with it
  // (Task 7). A real socket failure surfaces via PARTY_ERROR → ErrorScreen above.
  if (!state.connected && !incognito) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-4 px-4 py-8">
        <BrailleSpinner size="lg" />
        <p className="text-sm text-fg-dim">Connecting…</p>
      </div>
    );
  }
  return <FriendsScreen connection={connection} incognito={incognito} onToggleIncognito={onToggleIncognito} />;
}
