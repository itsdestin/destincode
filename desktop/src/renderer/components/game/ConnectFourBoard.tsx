import { useState } from 'react';
import { useGameState, useGameDispatch } from '../../state/game-context';
import { GameConnection } from '../../state/game-types';
import { Button, StatusStrip } from '../ui';

const COLS = 7;
const ROWS = 6;

interface Props {
  connection: GameConnection;
}

function cellValue(board: number[][], col: number, row: number): number {
  // board[col][row], row 0 = bottom of the visual board
  if (!board[col]) return 0;
  return board[col][row] ?? 0;
}

function isWinCell(winLine: [number, number][] | null, col: number, row: number): boolean {
  if (!winLine) return false;
  return winLine.some(([c, r]) => c === col && r === row);
}

export default function ConnectFourBoard({ connection }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const [hoveredCol, setHoveredCol] = useState<number | null>(null);

  const isMyTurn = state.myColor !== null && state.turn === state.myColor;
  const isPlaying = state.screen === 'playing';
  const canMove = isMyTurn && isPlaying && !state.opponentDisconnected;

  const handleColClick = (col: number) => {
    if (!canMove) return;
    connection.makeMove(col);
  };

  // Ghost piece: find the lowest empty row in the hovered column
  const getGhostRow = (col: number): number | null => {
    if (!canMove || hoveredCol !== col || !state.board[col]) return null;
    for (let row = 0; row < ROWS; row++) {
      if (!state.board[col][row]) return row;
    }
    return null; // column full
  };

  return (
    <div className="flex flex-col gap-2 p-3">
      {/* Disconnect banner. Retheme (§5.4): was a hand-rolled red box
          (`bg-red-900/30` + `border-red-800/50` + `text-red-300`) — three raw
          Tailwind colours that are identical in every theme, and design rule 6
          says a waiting state is not a red box anyway. <StatusStrip busy> is
          the primitive for "what is this doing right now, plus the one action
          that resolves it", which is exactly this. */}
      {state.opponentDisconnected && (
        <StatusStrip
          tone="busy"
          detail="They have a moment to come back before the game is called."
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => { connection.leaveGame(); dispatch({ type: 'RETURN_TO_LOBBY' }); }}
            >
              Leave
            </Button>
          }
        >
          {state.opponent ?? 'Your opponent'} dropped out — waiting for them to reconnect
        </StatusStrip>
      )}

      {/* Turn indicator */}
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          {/* Retheme (spec §5.4/§5.5): YOU are the accent, your opponent is the
              neutral foreground — the same rule as chat, the chess board and the
              leaderboard. The old `red`/`yellow` was identical in all 11 themes,
              and naming the colour in the label ("You (red)") only worked while
              the discs really were red. */}
          <span className="w-3 h-3 rounded-full bg-accent" />
          <span className="text-fg-dim">You</span>
        </div>
        <div className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          canMove
            ? 'bg-inset/50 text-fg-2'
            : 'bg-inset text-fg-muted'
        }`}>
          {isPlaying ? (canMove ? 'Your turn' : `${state.opponent ?? 'Opponent'}'s turn`) : ''}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-fg-dim">{state.opponent ?? 'Opponent'}</span>
          <span className="w-3 h-3 rounded-full bg-fg-muted" />
        </div>
      </div>

      {/* Board. `w-full` + a 7:6 aspect ratio means it fills whatever width
          the pane is dragged to and stays the right shape, instead of the old
          fixed 36px cells that left the board marooned in the middle of the
          pane (Destin, G-7: "it just sits in the panel funny"). */}
      <div
        className="bg-inset border border-edge rounded-lg p-2 select-none w-full"
        onMouseLeave={() => setHoveredCol(null)}
      >
        <div className="flex gap-1 w-full" style={{ aspectRatio: `${COLS} / ${ROWS}` }}>
          {Array.from({ length: COLS }, (_, col) => {
            const isHovered = hoveredCol === col;
            const ghostRow = getGhostRow(col);

            return (
              <div
                key={col}
                className={`flex-1 min-w-0 flex flex-col gap-1 rounded-sm cursor-pointer transition-colors ${
                  canMove && isHovered ? 'bg-accent/15' : ''
                }`}
                onMouseEnter={() => setHoveredCol(col)}
                onClick={() => handleColClick(col)}
              >
                {/* Render rows top-down visually (ROWS-1 down to 0 in data) */}
                {Array.from({ length: ROWS }, (_, visualRow) => {
                  const dataRow = ROWS - 1 - visualRow;
                  const value = cellValue(state.board, col, dataRow);
                  const isWin = isWinCell(state.winLine, col, dataRow);
                  const isGhost = ghostRow === dataRow;

                  // Discs are OWNERSHIP, not colour: `mine` is whichever seat
                  // this player holds, so both players see their own pieces in
                  // the accent — exactly how chat renders "you" on both ends of
                  // a conversation. `ring-white` went with the blue board: a
                  // literal white ring is invisible on the light themes, so the
                  // win line rings in the accent instead.
                  const mine = state.myColor === 'red' ? 1 : 2;
                  // `flex-1` + `aspect-square`: the disc takes its size from
                  // the column, which takes its size from the pane.
                  let cellClass = 'flex-1 min-h-0 aspect-square rounded-full transition-all ';
                  if (isWin) {
                    cellClass += value === mine
                      ? 'bg-accent ring-2 ring-accent/50 animate-pulse'
                      : 'bg-fg-muted ring-2 ring-fg-muted/50 animate-pulse';
                  } else if (value === mine) {
                    cellClass += 'bg-accent';
                  } else if (value !== 0) {
                    cellClass += 'bg-fg-muted';
                  } else if (isGhost) {
                    cellClass += 'bg-accent/35';
                  } else {
                    // An empty hole must read as a HOLE — the surface behind the
                    // board showing through — so it takes `canvas` against an
                    // `inset` frame. The first pass had inset holes in a well
                    // frame, one step apart on the depth ladder, and the holes
                    // were nearly invisible in the dark themes.
                    cellClass += 'bg-canvas';
                  }

                  return <div key={dataRow} className={cellClass} />;
                })}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
