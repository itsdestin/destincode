import { useEffect, useRef, useCallback } from 'react';
import { useGameDispatch, useGameState } from '../state/game-context';
import { PartyClient } from '../game/party-client';
import { createBoard, dropPiece, checkWin, checkDraw } from '../game/connect-four';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(): string {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

export function usePartyGame(
  lobbyStatusUpdate: (status: 'idle' | 'in-game') => void,
  lobbyChallenge: (target: string, gameType: string, code: string) => void,
) {
  const dispatch = useGameDispatch();
  const state = useGameState();
  // In-room player tag: state.username, frozen at PARTY_CONNECTED time. It
  // already carries the account display name (spec §3) because usePresence
  // dispatches PARTY_CONNECTED with display_name ?? login. SINGLE SOURCE —
  // GameChat's `from === state.username` own-message check and the lobby
  // self-filter compare against this same value, so own-message attribution
  // holds by construction even if the profile is renamed mid-session. Do NOT
  // re-source the tag from useAccount() here without also refreshing
  // state.username, or the two would diverge on a mid-session rename.
  const playerName = state.username;
  const clientRef = useRef<PartyClient | null>(null);
  const gameCodeRef = useRef<string | null>(null);
  const myColorRef = useRef<'red' | 'yellow' | null>(null);
  const boardRef = useRef<number[][]>([]);
  const turnRef = useRef<'red' | 'yellow'>('red');
  const rematchRequestedRef = useRef(false);
  const opponentRef = useRef<string | null>(null);

  // Clean up game connection on unmount
  useEffect(() => {
    return () => {
      clientRef.current?.close();
      clientRef.current = null;
    };
  }, []);

  // Auto-cleanup game room connection when forced back to lobby
  // (e.g., CHALLENGE_FAILED, CHALLENGE_DECLINED while on waiting screen)
  useEffect(() => {
    if (state.screen === 'lobby' && clientRef.current) {
      clientRef.current.close();
      clientRef.current = null;
      gameCodeRef.current = null;
      myColorRef.current = null;
      boardRef.current = [];
      turnRef.current = 'red';
      rematchRequestedRef.current = false;
      opponentRef.current = null;
      lobbyStatusUpdate('idle');
    }
  }, [state.screen, lobbyStatusUpdate]);

  const connectToRoom = useCallback((code: string, username: string) => {
    clientRef.current?.close();

    const client = new PartyClient({
      party: 'connectfour',
      room: code,
      username,
      onMessage: (data) => {
        switch (data.type) {
          case 'player-joined': {
            if (data.username === username) break;

            // If this is a reconnection of our known opponent, don't reset the board.
            // Check opponentRef regardless of data.reconnect — the server only sets
            // reconnect:true on broadcasts to OTHER players, not on the direct send
            // to the reconnecting player itself.
            if (opponentRef.current === data.username) {
              dispatch({ type: 'OPPONENT_RECONNECTED', username: data.username });
              break;
            }

            // New opponent joining — start the game
            const board = createBoard();
            boardRef.current = board;
            turnRef.current = 'red';
            opponentRef.current = data.username;
            dispatch({
              type: 'GAME_START',
              board,
              you: myColorRef.current!,
              opponent: data.username,
            });
            lobbyStatusUpdate('in-game');
            break;
          }

          case 'player-left': {
            if (data.username !== username) {
              dispatch({ type: 'OPPONENT_DISCONNECTED' });
            }
            break;
          }

          case 'room-full': {
            // Close the client to prevent partysocket auto-reconnect loop
            clientRef.current?.close();
            clientRef.current = null;
            dispatch({ type: 'ROOM_FULL' });
            break;
          }

          case 'move': {
            if (data.username === username) break;
            const playerNum = turnRef.current === 'red' ? 1 : 2;
            const result = dropPiece(boardRef.current, data.column, playerNum);
            if (!result) break;

            boardRef.current = result.board;
            const winLine = checkWin(result.board, { col: data.column, row: result.row });
            const isDraw = !winLine && checkDraw(result.board);
            const nextTurn = turnRef.current === 'red' ? 'yellow' : 'red';
            turnRef.current = nextTurn;

            if (winLine) {
              dispatch({
                type: 'GAME_STATE',
                board: result.board,
                turn: nextTurn,
                lastMove: { col: data.column, row: result.row },
                winner: nextTurn === 'red' ? 'yellow' : 'red',
                winLine: winLine as [number, number][],
              });
            } else if (isDraw) {
              dispatch({
                type: 'GAME_STATE',
                board: result.board,
                turn: nextTurn,
                lastMove: { col: data.column, row: result.row },
                winner: 'draw',
              });
            } else {
              dispatch({
                type: 'GAME_STATE',
                board: result.board,
                turn: nextTurn,
                lastMove: { col: data.column, row: result.row },
              });
            }
            break;
          }

          case 'chat': {
            if (data.username !== username) {
              dispatch({ type: 'CHAT_MESSAGE', from: data.username, text: data.text });
            }
            break;
          }

          case 'rematch': {
            if (rematchRequestedRef.current) {
              // Both players agreed — start new game
              const board = createBoard();
              boardRef.current = board;
              myColorRef.current = myColorRef.current === 'red' ? 'yellow' : 'red';
              turnRef.current = 'red';
              rematchRequestedRef.current = false;
              dispatch({
                type: 'GAME_START',
                board,
                you: myColorRef.current,
                opponent: data.username,
              });
            } else {
              // Opponent wants a rematch; we haven't agreed yet
              dispatch({ type: 'REMATCH_REQUESTED' });
            }
            break;
          }
        }
      },
    });

    clientRef.current = client;
    gameCodeRef.current = code;
  }, [dispatch, lobbyStatusUpdate]);

  // createGame (manual room creation for the old Create Game button) was
  // removed 2026-07-09 along with the room-code UI — challengePlayer below is
  // the only room-creating path now, and it generates its own code.
  const joinGame = useCallback((code: string) => {
    if (!playerName) return;
    myColorRef.current = 'yellow';
    rematchRequestedRef.current = false;
    opponentRef.current = null;
    dispatch({ type: 'JOINING_GAME', code });
    connectToRoom(code, playerName);
  }, [playerName, dispatch, connectToRoom]);

  const makeMove = useCallback((column: number) => {
    if (!clientRef.current || !playerName) return;
    const playerNum = turnRef.current === 'red' ? 1 : 2;
    const result = dropPiece(boardRef.current, column, playerNum);
    if (!result) return;

    boardRef.current = result.board;
    const winLine = checkWin(result.board, { col: column, row: result.row });
    const isDraw = !winLine && checkDraw(result.board);
    const mover = turnRef.current;
    const nextTurn = mover === 'red' ? 'yellow' : 'red';
    turnRef.current = nextTurn;

    clientRef.current.send({ type: 'move', username: playerName, column });

    if (winLine) {
      dispatch({
        type: 'GAME_STATE',
        board: result.board,
        turn: nextTurn,
        lastMove: { col: column, row: result.row },
        winner: mover,
        winLine: winLine as [number, number][],
      });
    } else if (isDraw) {
      dispatch({
        type: 'GAME_STATE',
        board: result.board,
        turn: nextTurn,
        lastMove: { col: column, row: result.row },
        winner: 'draw',
      });
    } else {
      dispatch({
        type: 'GAME_STATE',
        board: result.board,
        turn: nextTurn,
        lastMove: { col: column, row: result.row },
      });
    }
  }, [playerName, dispatch]);

  const sendChat = useCallback((text: string) => {
    if (!clientRef.current || !playerName) return;
    clientRef.current.send({ type: 'chat', username: playerName, text });
    dispatch({ type: 'CHAT_MESSAGE', from: playerName, text });
  }, [playerName, dispatch]);

  const requestRematch = useCallback(() => {
    if (!clientRef.current || !playerName) return;
    rematchRequestedRef.current = true;
    clientRef.current.send({ type: 'rematch', username: playerName });
    dispatch({ type: 'REMATCH_REQUESTED' });
  }, [playerName, dispatch]);

  const leaveGame = useCallback(() => {
    if (clientRef.current && playerName) {
      clientRef.current.send({ type: 'leave', username: playerName });
      clientRef.current.close();
      clientRef.current = null;
    }
    gameCodeRef.current = null;
    myColorRef.current = null;
    boardRef.current = [];
    turnRef.current = 'red';
    rematchRequestedRef.current = false;
    opponentRef.current = null;
    lobbyStatusUpdate('idle');
  }, [playerName, lobbyStatusUpdate]);

  // target is the challenged player's ACCOUNT ID (spec §3) — forwarded verbatim
  // to the presence layer via lobbyChallenge; the room itself still uses our
  // display-name tag.
  // Room codes REMAIN the internal capability token for PartyKit rooms — this
  // generates one and sends it with the challenge; the recipient's Accept joins
  // by it. Only the manual create/join-by-code UI was removed (2026-07-09,
  // Destin: friends/handles cover the real use case).
  const challengePlayer = useCallback((target: string) => {
    if (!playerName) return;
    const code = generateCode();
    myColorRef.current = 'red';
    rematchRequestedRef.current = false;
    opponentRef.current = null;
    dispatch({ type: 'ROOM_CREATED', code, color: 'red' });
    connectToRoom(code, playerName);
    lobbyChallenge(target, 'connect-four', code);
  }, [playerName, dispatch, connectToRoom, lobbyChallenge]);

  return { joinGame, makeMove, sendChat, requestRematch, leaveGame, challengePlayer };
}
