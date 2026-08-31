// Reporting a finished versus match, so it can become a head-to-head record
// (games spec §6.2).
//
// HOW THE SERVER DECIDES. It never takes one player's word. Both clients send
// "here is how MY side ended"; only when the two agree does a row get written,
// and the settled record is then pushed to both over the presence socket
// (`game-record`, handled in usePresence.ts). If they disagree, or one never
// reports, nothing is written. That is the right direction to fail: this is the
// first thing the app records PERMANENTLY ABOUT ANOTHER PERSON, and a missing
// record is a far smaller harm than a wrong one.
//
// So there is deliberately no retry, no queue, and no "claim your win" button
// here. All this does is state, once, what this client saw.

import { useEffect, useRef } from 'react';
import type { GameState } from '../state/game-types';

/** What this client claims happened TO IT. The server's vocabulary. */
type Outcome = 'win' | 'loss' | 'draw';

/** `${roomCode}#${matchesStarted}` — see GameState.matchesStarted for why the
 *  room code alone will not do (a rematch reuses the room). Both clients derive
 *  the identical string from state they both hold, so neither has to send it to
 *  the other. */
export function matchIdOf(state: Pick<GameState, 'roomCode' | 'matchesStarted'>): string | null {
  if (!state.roomCode || state.matchesStarted < 1) return null;
  return `${state.roomCode}#${state.matchesStarted}`;
}

/** How the finished match looks from THIS seat. Null when the match has not
 *  ended, or when we somehow have no seat to judge from. */
export function outcomeFor(state: Pick<GameState, 'outcome' | 'seat'>): Outcome | null {
  if (!state.outcome) return null;
  if ('draw' in state.outcome) return 'draw';
  if (state.seat === null) return null;
  return state.outcome.winnerSeat === state.seat ? 'win' : 'loss';
}

/**
 * Sends this client's half of the result, exactly once per match.
 *
 * `gameId` is the game the shell currently has open — a match can only end
 * while its own game is on screen, so that is a sound source and keeps this
 * hook from having to learn the registry.
 */
export function useMatchReport(state: GameState, gameId: string | null): void {
  // Which match ids we have already spoken about. A ref, not state: re-running
  // must not re-render, and the whole point is that a second render of the same
  // finished match says nothing further.
  const reported = useRef(new Set<string>());

  useEffect(() => {
    if (!gameId || !state.opponentId) return;
    const matchId = matchIdOf(state);
    const outcome = outcomeFor(state);
    if (!matchId || !outcome) return;
    if (reported.current.has(matchId)) return;
    reported.current.add(matchId);

    // Fire and forget. Nothing on screen waits for this: the game has already
    // shown who won, and it is correct whether or not a record is ever written.
    // A rejection is swallowed rather than surfaced for the same reason — the
    // player did not ask for a record and cannot act on its absence.
    const social = (window.claude as { social?: { presenceSend?: (m: unknown) => Promise<unknown> } }).social;
    void social?.presenceSend?.({
      type: 'game-result',
      game: gameId,
      match_id: matchId,
      opponent: state.opponentId,
      outcome,
    })?.catch?.(() => { /* reporting a result is best-effort by design */ });
  }, [state, gameId]);
}
