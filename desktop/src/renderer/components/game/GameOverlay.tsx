import { useGameState, useGameDispatch } from '../../state/game-context';
import { GameConnection } from '../../state/game-types';
import { OverlayPanel } from '../overlays/Overlay';
import { Button } from '../ui';

interface Props {
  connection: GameConnection;
}

// End-of-game overlay. Renders as a small centered card so the final board
// stays visible around it — player should still see the winning line and
// piece layout while deciding Rematch vs. Back to Lobby. Glassmorphism
// refactor (see GLASSMORPHISM-REFACTOR-PLAN.md § GameOverlay) replaced the
// old full-screen scrim with this trimmed centered layer-surface card.
export default function GameOverlay({ connection }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();

  // The split (§3.1): the shell records an OUTCOME, not a winning colour, so
  // this reads the same for chess, Connect 4 and anything after them.
  const { outcome, seat } = state;
  const youWon = outcome != null && 'winnerSeat' in outcome && outcome.winnerSeat === seat;
  const draw = outcome != null && 'draw' in outcome;

  let headline = 'Draw!';
  let headlineClass = 'text-fg';

  if (outcome && !draw) {
    if (youWon) {
      headline = 'You Win!';
      // Retheme (§5.4): was `text-red-400`/`text-yellow-400`, picked to match
      // whichever disc you were playing. Now the winner's headline is the
      // accent for the same reason your discs are — it is YOUR result.
      headlineClass = 'text-accent';
    } else {
      headline = 'You Lose!';
      headlineClass = 'text-fg-dim';
    }
  }

  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-10">
      <OverlayPanel
        layer={2}
        className="flex flex-col items-center gap-4 px-6 py-5 pointer-events-auto"
      >
        <div className="flex flex-col items-center gap-1">
          <span className={`text-3xl font-black ${headlineClass}`}>{headline}</span>
          {outcome && !draw && (
            <span className="text-xs text-fg-muted">
              {youWon ? 'Congratulations!' : 'Better luck next time'}
            </span>
          )}
        </div>

        <div className="flex flex-col gap-2 w-40">
          {/* Rematch is the main action here, so it's the shared `primary` button.
              The old hand-rolled classes had `hover:bg-accent` on top of a
              `bg-accent` base — i.e. the hover did nothing. The primitive fades
              the fill on hover, so this button now actually responds to the cursor. */}
          <Button
            variant="primary"
            size="lg"
            onClick={() => { if (!state.rematchRequested) connection.requestRematch(); }}
            disabled={state.rematchRequested}
            className="w-full"
          >
            {state.rematchRequested ? 'Rematch Requested' : 'Rematch'}
          </Button>
          {/* Filled-grey (`bg-inset`) was a second, unofficial secondary style —
              it collapses into the primitive's outlined `secondary`. */}
          <Button
            variant="secondary"
            size="lg"
            onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
            className="w-full"
          >
            Back to Lobby
          </Button>
        </div>
      </OverlayPanel>
    </div>
  );
}
