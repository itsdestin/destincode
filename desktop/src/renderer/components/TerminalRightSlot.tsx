import React from 'react';
import { SessionDrawer } from './SessionDrawer';
import { useActiveProject } from '../hooks/useActiveProject';

interface Props {
  sessionId: string;
  cwd?: string;
  /** The active game pane element, or null when no game panel is open. */
  gamePane: React.ReactNode;
  /** Whether the artifact drawer is open for this session. */
  drawerOpen: boolean;
  /** Whether the artifact drawer is in expand-in-place mode (game pane never expands). */
  expanded: boolean;
}

/**
 * Terminal-view right-slot overlay (Bug #2).
 *
 * The artifact drawer and game pane normally live inside ChatView's
 * framed-shell right slot. In terminal view ChatView is hidden
 * (visibility:hidden), so opening a panel there expanded the chrome-glass
 * cutout but showed no content. This renders a single framed-shell CLONE that
 * floats over the terminal, reusing the exact `.framed-shell > .drawer-pane`
 * chrome (framed margins, floating-pill variants, rounded corners) so the
 * panel looks identical to chat view.
 *
 * The container + empty chat-pane spacer are click-through (pointer-events
 * none in globals.css) so the terminal underneath stays interactive; only the
 * drawer-pane itself takes pointer events. ChatView gates its own copy on
 * `visible`, so exactly one instance of the drawer/game mounts at a time.
 */
export default function TerminalRightSlot({ sessionId, cwd, gamePane, drawerOpen, expanded }: Props) {
  const gameOpen = !!gamePane;
  // Resolve the project only when the artifact drawer (not the game pane) is open.
  const activeProject = useActiveProject(cwd, drawerOpen && !gameOpen);

  return (
    <div className="terminal-panel-shell">
      <div className={`framed-shell drawer-open${expanded && !gameOpen ? ' drawer-expanded' : ''}`}>
        {/* Transparent spacer standing in for the chat pane — pushes the
            drawer to the right and lets the terminal show through + stay
            interactive (click-through via CSS). */}
        <div className="chat-pane terminal-panel-spacer" />
        {gameOpen ? (
          <>
            <div className="frame-divider" />
            <div className="drawer-pane game-pane">{gamePane}</div>
          </>
        ) : (
          <>
            <div className="frame-divider" />
            <div className="drawer-pane">
              <SessionDrawer
                sessionId={sessionId}
                projectRoot={activeProject?.path ?? ''}
                projectId={activeProject?.id ?? ''}
                projectName={activeProject?.name ?? 'project'}
              />
            </div>
          </>
        )}
        <div className="frame-edge" />
      </div>
    </div>
  );
}
