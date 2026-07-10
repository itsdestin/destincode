export type GameScreen = 'setup' | 'lobby' | 'waiting' | 'joining' | 'playing' | 'game-over';
export type PlayerColor = 'red' | 'yellow';

// Identity is the ACCOUNT now (spec §3): display name is the visible tag,
// account id is the stable key (display names aren't unique). Replaces the old
// GitHub-login-keyed OnlineUser from the retired PartyKit global lobby.
export interface OnlineUser {
  id: string;
  name: string;            // display_name from the account
  handle: string | null;
  status: 'idle' | 'in-game';
}

export interface ChatMessage {
  from: string;
  text: string;
  timestamp: number;
}

export interface GameState {
  connected: boolean;
  partyError: string | null;
  username: string | null;
  onlineUsers: OnlineUser[];
  screen: GameScreen;
  roomCode: string | null;
  myColor: PlayerColor | null;
  opponent: string | null;
  board: number[][];
  turn: PlayerColor;
  lastMove: { col: number; row: number } | null;
  winner: PlayerColor | 'draw' | null;
  winLine: [number, number][] | null;
  chatMessages: ChatMessage[];
  panelOpen: boolean;
  /** Incoming challenge from another player (account identity: id is the stable
   * key, name is the visible tag; handle is carried through for the Task 8
   * friends UI to render @handle in the challenge banner). */
  challengeFrom: { id: string; name: string; handle: string | null } | null;
  /** Room code from incoming challenge */
  challengeCode: string | null;
  /** Outgoing challenge was declined (account identity, handle included — see
   * challengeFrom). */
  challengeDeclinedBy: { id: string; name: string; handle: string | null } | null;
  /** Whether this player has requested a rematch */
  rematchRequested: boolean;
  /** Opponent disconnected during game */
  opponentDisconnected: boolean;
}

export type GameAction =
  | { type: 'PARTY_CONNECTED'; username: string }
  | { type: 'PARTY_DISCONNECTED'; code?: number; reason?: string }
  | { type: 'PARTY_ERROR'; message: string }
  | { type: 'PARTY_ERROR_CLEARED' }
  | { type: 'PRESENCE_UPDATE'; online: OnlineUser[] }
  | { type: 'USER_JOINED'; user: OnlineUser }
  | { type: 'USER_LEFT'; id: string }
  | { type: 'USER_STATUS'; id: string; status: 'idle' | 'in-game' }
  | { type: 'ROOM_CREATED'; code: string; color: PlayerColor }
  | { type: 'JOINING_GAME'; code: string }
  | { type: 'GAME_START'; board: number[][]; you: PlayerColor; opponent: string }
  | { type: 'GAME_STATE'; board: number[][]; turn: PlayerColor; lastMove: { col: number; row: number }; winner?: PlayerColor | 'draw'; winLine?: [number, number][] }
  | { type: 'CHAT_MESSAGE'; from: string; text: string }
  | { type: 'OPPONENT_DISCONNECTED' }
  | { type: 'OPPONENT_RECONNECTED'; username: string }
  | { type: 'ROOM_FULL' }
  | { type: 'TOGGLE_PANEL' }
  | { type: 'RETURN_TO_LOBBY' }
  | { type: 'RESET' }
  | { type: 'CHALLENGE_RECEIVED'; from: { id: string; name: string; handle: string | null }; gameType: string; code: string }
  | { type: 'CHALLENGE_ACCEPTED'; by: { id: string; name: string; handle: string | null } }
  | { type: 'CHALLENGE_DECLINED'; by: { id: string; name: string; handle: string | null } }
  | { type: 'CHALLENGE_FAILED'; target: string }
  | { type: 'CLEAR_CHALLENGE' }
  | { type: 'REMATCH_REQUESTED' };

export interface GameConnection {
  // createGame was removed 2026-07-09 with the manual room-code UI (Destin:
  // challenges are the only game entry now). Room codes REMAIN the internal
  // capability token for PartyKit rooms — challengePlayer generates one and
  // joinGame consumes the code received with an accepted challenge.
  /** Join a game room by code — the code arrives with an incoming challenge. */
  joinGame: (code: string) => void;
  makeMove: (column: number) => void;
  sendChat: (text: string) => void;
  requestRematch: () => void;
  leaveGame: () => void;
  /** target is the challenged player's ACCOUNT ID (spec §3). */
  challengePlayer: (target: string) => void;
  /** `from` is the challenger's ACCOUNT ID (spec §3). */
  respondToChallenge: (from: string, accept: boolean) => void;
  /** Force a fresh presence socket — used by the ErrorScreen Retry button when
   * the platform-layer socket has dropped and needs a clean reconnect. */
  reconnectLobby: () => void;
}

export function createInitialGameState(): GameState {
  return {
    connected: false,
    partyError: null,
    username: null,
    onlineUsers: [],
    screen: 'setup',
    roomCode: null,
    myColor: null,
    opponent: null,
    board: [],
    turn: 'red',
    lastMove: null,
    winner: null,
    winLine: null,
    chatMessages: [],
    panelOpen: false,
    challengeFrom: null,
    challengeCode: null,
    challengeDeclinedBy: null,
    rematchRequested: false,
    opponentDisconnected: false,
  };
}
