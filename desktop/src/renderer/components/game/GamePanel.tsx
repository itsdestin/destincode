import { useGameState, useGameDispatch } from '../../state/game-context';
import GameLobby from './GameLobby';
import ConnectFourBoard from './ConnectFourBoard';
import GameChat from './GameChat';
import GameOverlay from './GameOverlay';
import { GameConnection } from '../../state/game-types';

interface Props {
  connection: GameConnection;
  incognito?: boolean;
  onToggleIncognito?: () => void;
}

export default function GamePanel({ connection, incognito, onToggleIncognito }: Props) {
  const state = useGameState();
  const dispatch = useGameDispatch();
  const isPlaying = state.screen === 'playing' || state.screen === 'game-over';

  return (
    // Fills the framed-shell's drawer-pane slot (see ChatView). The pane's own
    // chrome — width, rounded corners, top/bottom chrome-height margins, and the
    // chrome-glass frame around it — comes from .drawer-pane in globals.css, so
    // this root only sets the interior surface (bg-inset, matching the artifact
    // drawer's aside) and fills its container. It no longer carries the old
    // w-80 / border-l / bg-panel slide-out styling.
    <div className="h-full flex flex-col overflow-hidden bg-inset">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-edge">
        <span className="text-sm font-semibold text-fg">Connect 4</span>
        <button
          onClick={() => {
            if (state.screen !== 'lobby' && state.screen !== 'setup') {
              connection.leaveGame();
              dispatch({ type: 'RETURN_TO_LOBBY' });
            }
            dispatch({ type: 'TOGGLE_PANEL' });
          }}
          className="text-fg-muted hover:text-fg-2 transition-colors"
        >
          ✕
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto flex flex-col">
        {isPlaying ? (
          <div className="relative flex flex-col flex-1">
            <ConnectFourBoard connection={connection} />
            <GameChat connection={connection} />
            {state.screen === 'game-over' && (
              <GameOverlay connection={connection} />
            )}
          </div>
        ) : (
          <GameLobby connection={connection} incognito={incognito} onToggleIncognito={onToggleIncognito} />
        )}
      </div>
    </div>
  );
}
