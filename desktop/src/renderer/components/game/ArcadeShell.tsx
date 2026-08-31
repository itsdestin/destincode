// The arcade shell (spec §4) — what the games pane shows around a game.
//
// Its whole job is routing plus the states nobody plans for: the picker, one
// game's screen, the back path, and the degraded/empty cases (§6.5, §6.6).
// It owns NO game rules and imports no game logic — the four games reach it
// only through `game-registry.ts`, which is the point of the slot (§3).
//
// STEP 1 SCOPE. Flappy and 2048 render their leaderboard (the Step 1
// deliverable for a solo game); Chess renders a fixed position at its proposed
// default width so sizing and the two-player contrast can be judged; Connect 4
// keeps its real challenge-a-friend flow, rethemed. The playfields and the
// state split land in Step 2 — this file should not need to change for them.

import { useEffect, useState } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { useAccount } from '../../state/account-context';
import { useTheme } from '../../state/theme-context';
import { GameConnection } from '../../state/game-types';
import { GAMES, type GameDefinition } from './game-registry';
import ArcadePicker, { type ArcadeStatus } from './ArcadePicker';
import Leaderboard, { type LeaderboardRow } from './Leaderboard';
import ChessBoard, { type PieceTreatment } from './ChessBoard';
import GameLobby from './GameLobby';
import ConnectFourBoard from './ConnectFourBoard';
import GameChat from './GameChat';
import GameOverlay from './GameOverlay';
import { Button, LoadingState } from '../ui';

interface Props {
  connection: GameConnection;
  incognito?: boolean;
  onToggleIncognito?: () => void;
}

/** The arcade's own data. Served by the `arcade.*` channels, which are
 *  registered in mock-only.ts as deliberately unbuilt — Step 2 replaces the
 *  fake with real Worker endpoints and this hook does not change. */
function useArcadeData(gameId: string | null) {
  const [statuses, setStatuses] = useState<Record<string, ArcadeStatus> | null>(null);
  const [board, setBoard] = useState<{ rows: LeaderboardRow[]; staleNote?: string } | null>(null);

  useEffect(() => {
    let live = true;
    const api = (window.claude as unknown as { arcade?: { status: () => Promise<Record<string, ArcadeStatus>> } }).arcade;
    // No arcade backend outside the workbench yet. Resolving to an empty map
    // rather than throwing means the picker still renders — every tile just
    // falls back to its quiet "not played yet" / "no friends online" line,
    // which is honest rather than broken.
    if (!api) { setStatuses({}); return; }
    void api.status().then((v) => { if (live) setStatuses(v); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    if (!gameId) { setBoard(null); return; }
    let live = true;
    const api = (window.claude as unknown as {
      arcade?: { leaderboard: (id: string) => Promise<{ rows: LeaderboardRow[]; staleNote?: string }> };
    }).arcade;
    if (!api) { setBoard({ rows: [] }); return; }
    setBoard(null);
    void api.leaderboard(gameId).then((v) => { if (live) setBoard(v); });
    return () => { live = false; };
  }, [gameId]);

  return { statuses, board };
}

export default function ArcadeShell({ connection, incognito, onToggleIncognito }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const { signedIn, startSignIn } = useAccount();
  const [openGame, setOpenGame] = useState<GameDefinition | null>(null);
  const { applyGameDefaultWidth } = useTheme();

  // §4.3: a game opens at ITS default width the first time — chess wants 520px
  // where the picker wants 420. This is a no-op once the user has dragged the
  // pane even once, because their width then wins permanently; the "have they
  // resized?" fact is the presence of the stored key, not a value comparison,
  // so dragging to exactly the default still counts as a choice.
  useEffect(() => {
    if (openGame) applyGameDefaultWidth(openGame.defaultPaneWidth);
  }, [openGame, applyGameDefaultWidth]);
  const { statuses, board } = useArcadeData(openGame?.kind === 'solo' ? openGame.id : null);

  // A challenge arriving while the picker is open must land on the game it is
  // FOR — otherwise Accept drops the player into the wrong board. Until the
  // reducer carries the game (§3.1 item 3), Connect 4 is the only thing that
  // can be challenged, so route there and leave a marker for Step 2.
  useEffect(() => {
    if (state.challengeFrom && !openGame) {
      setOpenGame(GAMES.find((g) => g.id === 'connect-four') ?? null);
    }
  }, [state.challengeFrom, openGame]);

  const inPlay = state.screen === 'playing' || state.screen === 'game-over';

  const leave = () => {
    if (state.screen !== 'lobby' && state.screen !== 'setup') {
      connection.leaveGame();
      dispatch({ type: 'RETURN_TO_LOBBY' });
    }
    setOpenGame(null);
  };

  return (
    // Fills GamePanel's root, which owns the pane surface and (since §4.3) the
    // resize handle. This layer is routing + chrome only.
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <ArcadeHeader
        title={openGame?.name ?? 'Games'}
        // Back only exists once you are inside a game. On the picker the only
        // control is close — a back arrow that goes nowhere is a dead affordance.
        onBack={openGame ? leave : undefined}
        onClose={() => { if (openGame) leave(); dispatch({ type: 'TOGGLE_PANEL' }); }}
      />

      {/* `overflow-y-auto` for the list-shaped screens (picker, leaderboard);
          `overflow-hidden` while a game is open, so the board keeps its size
          and the chat below it can fill the remaining height instead of
          growing into an unbounded scroll container. */}
      <div className={`flex-1 min-h-0 flex flex-col ${openGame?.kind === 'versus' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        {!openGame && (
          statuses === null
            ? <LoadingState what="games" />
            : (
              <ArcadePicker
                statuses={statuses}
                onPick={setOpenGame}
                signedIn={!!signedIn}
                onSignIn={() => { void startSignIn(); }}
              />
            )
        )}

        {openGame?.kind === 'solo' && (
          <div className="flex flex-col">
            {/* G-4: one primary per view — Play is it. */}
            <div className="px-3 pt-3">
              <Button variant="primary" size="md" className="w-full" onClick={() => { /* Step 2 */ }}>
                Play
              </Button>
              <p className="text-2xs text-fg-muted leading-relaxed pt-2">{openGame.blurb}</p>
            </div>
            {board === null
              ? <LoadingState what="the board" />
              : (
                <Leaderboard
                  game={openGame}
                  rows={board.rows}
                  staleNote={board.staleNote}
                  // Signed out, a solo best is real but unranked (§4.2).
                  unpublishedBest={!signedIn ? statuses?.[openGame.id]?.bestScore : undefined}
                  onSignIn={() => { void startSignIn(); }}
                />
              )}
          </div>
        )}

        {openGame?.id === 'chess' && (
          <ChessBoard treatment={chessTreatment()} legalMoves={['e5', 'd4', 'c4']} selected="f3" />
        )}

        {openGame?.id === 'connect-four' && (
          inPlay ? (
            <div className="relative flex flex-col flex-1 min-h-0">
              <ConnectFourBoard connection={connection} />
              <GameChat connection={connection} />
              {state.screen === 'game-over' && <GameOverlay connection={connection} />}
            </div>
          ) : (
            <GameLobby connection={connection} incognito={incognito} onToggleIncognito={onToggleIncognito} />
          )
        )}
      </div>
    </div>
  );
}

/** SETTLED: 'outline' (deck step G-8). `?chess=disc|fill` still renders the two
 *  rejected treatments so a future review can re-open the question against the
 *  same position — it is a workbench switch, never a user setting. */
function chessTreatment(): PieceTreatment {
  if (typeof location === 'undefined') return 'outline';
  const v = new URLSearchParams(location.search).get('chess');
  return v === 'disc' || v === 'fill' ? v : 'outline';
}

function ArcadeHeader({ title, onBack, onClose }: { title: string; onBack?: () => void; onClose: () => void }) {
  return (
    <div className="flex items-center gap-1 px-2 py-2 border-b border-edge shrink-0">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          aria-label="Back to games"
          className="w-7 h-7 flex items-center justify-center rounded-md text-fg-muted hover:text-fg-2 hover:bg-inset transition-colors"
        >
          {/* Chevron, not a glyph character — a text arrow inherits the theme
              font and lands at a different size in every community pack. */}
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M10 3L5 8l5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}
      <span className={`text-sm font-semibold text-fg flex-1 min-w-0 truncate ${onBack ? '' : 'pl-1'}`}>{title}</span>
      <button
        type="button"
        onClick={onClose}
        aria-label="Close games"
        className="w-7 h-7 flex items-center justify-center rounded-md text-fg-muted hover:text-fg-2 hover:bg-inset transition-colors"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
