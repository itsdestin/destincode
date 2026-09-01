// @vitest-environment jsdom
// desktop/tests/chess-board.test.tsx
//
// The two halves of "chess is playable": the board that takes the clicks, and
// the client that carries them to the other player.
//
// The board's job is to make ONLY legal moves reachable — every illegal click
// has to be a no-op, because a board that offers a move the rules refuse is a
// board that desyncs the two players. The client's job is to assume the other
// side is lying: `chess-room.ts` is a relay, so a move off the wire is applied
// only if chess.js agrees it is legal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, renderHook, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// One mock serves both subjects: ChessBoard and useChessGame read the game
// state through the same context module.
const h = vi.hoisted(() => ({ state: {} as Record<string, unknown>, dispatch: vi.fn() }));
vi.mock('../src/renderer/state/game-context', () => ({
  useGameState: () => h.state,
  useGameDispatch: () => h.dispatch,
}));

import ChessBoard from '../src/renderer/components/game/ChessBoard';
import { useChessGame } from '../src/renderer/hooks/useChessGame';
import { __setPartySocketFactory } from '../src/renderer/game/party-client';
import { applyMove, startingPlay, type ChessPlay } from '../src/renderer/game/chess';
import type { GameConnection } from '../src/renderer/state/game-types';

const START = startingPlay();

function setState(over: Record<string, unknown> = {}) {
  h.state = {
    username: 'me',
    screen: 'playing',
    seat: 0,
    turnSeat: 0,
    play: START,
    opponent: 'Jake',
    opponentDisconnected: false,
    outcome: null,
    chatMessages: [],
    ...over,
  };
}

function conn(): GameConnection {
  return {
    joinGame: vi.fn(), makeMove: vi.fn(), sendChat: vi.fn(), requestRematch: vi.fn(),
    leaveGame: vi.fn(), challengePlayer: vi.fn(), respondToChallenge: vi.fn(),
    reconnectLobby: vi.fn(),
  };
}

/** Squares are buttons labelled "e2, white pawn" — find one by its prefix. */
const square = (name: string) => screen.getByRole('button', { name: new RegExp(`^${name},`) });

beforeEach(() => { h.dispatch.mockClear(); setState(); });
afterEach(() => { cleanup(); __setPartySocketFactory(null); });

describe('the board only lets you make legal moves', () => {
  it('draws all 64 squares', () => {
    render(<ChessBoard connection={conn()} />);
    expect(screen.getAllByRole('button')).toHaveLength(64);
  });

  it('picking up a piece shows exactly its legal moves', () => {
    render(<ChessBoard connection={conn()} />);
    fireEvent.click(square('e2'));
    expect(square('e3')).toHaveAccessibleName(/legal move/);
    expect(square('e4')).toHaveAccessibleName(/legal move/);
    // A pawn cannot go three squares, and the square beside it is not a move.
    expect(square('e5')).not.toHaveAccessibleName(/legal move/);
    expect(square('d3')).not.toHaveAccessibleName(/legal move/);
  });

  it('sends the move when you click one of its dots', () => {
    const c = conn();
    render(<ChessBoard connection={c} />);
    fireEvent.click(square('e2'));
    fireEvent.click(square('e4'));
    expect(c.makeMove).toHaveBeenCalledWith({ from: 'e2', to: 'e4' });
  });

  it('does nothing at all on an illegal click', () => {
    const c = conn();
    render(<ChessBoard connection={c} />);
    fireEvent.click(square('e2'));
    fireEvent.click(square('e5'));       // not a legal target
    expect(c.makeMove).not.toHaveBeenCalled();
    // And the piece is put back down rather than left half-picked-up.
    expect(square('e2')).toHaveAttribute('aria-pressed', 'false');
  });

  it('will not pick up the opponent\'s piece', () => {
    const c = conn();
    render(<ChessBoard connection={c} />);
    fireEvent.click(square('e7'));
    expect(square('e7')).toHaveAttribute('aria-pressed', 'false');
    expect(square('e6')).not.toHaveAccessibleName(/legal move/);
  });

  it('is inert when it is not your turn', () => {
    setState({ turnSeat: 1 });
    const c = conn();
    render(<ChessBoard connection={c} />);
    fireEvent.click(square('e2'));
    expect(square('e2')).toHaveAttribute('aria-pressed', 'false');
    expect(c.makeMove).not.toHaveBeenCalled();
  });

  it('is inert once the game is over', () => {
    // Fool's mate — black has already won, so nothing more can be played.
    let play = START;
    for (const [from, to] of [['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]) {
      play = applyMove(play.fen, { from: from!, to: to! })!.play;
    }
    setState({ play, turnSeat: 0 });
    const c = conn();
    render(<ChessBoard connection={c} />);
    fireEvent.click(square('e2'));
    expect(c.makeMove).not.toHaveBeenCalled();
  });

  it('clicking the picked-up square puts the piece back down', () => {
    render(<ChessBoard connection={conn()} />);
    fireEvent.click(square('e2'));
    expect(square('e2')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(square('e2'));
    expect(square('e2')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('the picked-up square is unmistakable (deck step S-2)', () => {
  // The reported problem was that a single 25%-accent wash was the whole cue,
  // so the legal-move dots "read as causeless". Three stacked cues replace it;
  // this pins the two that survive a light theme.
  it('carries a full-strength ring as well as a wash', () => {
    render(<ChessBoard connection={conn()} />);
    fireEvent.click(square('e2'));
    const picked = square('e2');
    expect(picked.querySelector('.ring-accent')).not.toBeNull();
    expect(picked.innerHTML).toContain('bg-accent/35');
  });

  it('does not mark any other square as picked up', () => {
    render(<ChessBoard connection={conn()} />);
    fireEvent.click(square('e2'));
    const pressed = screen.getAllByRole('button')
      .filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
  });
});

describe('promotion asks instead of assuming a queen', () => {
  // White pawn on a7, one square from promoting. chess.js refuses a promoting
  // move that does not name the piece, so the board HAS to ask.
  const READY: ChessPlay = { ...START, fen: '7k/P7/8/8/8/8/8/K7 w - - 0 1' };

  it('opens the picker instead of sending the move', () => {
    setState({ play: READY });
    const c = conn();
    render(<ChessBoard connection={c} />);
    fireEvent.click(square('a7'));
    fireEvent.click(square('a8'));
    expect(c.makeMove).not.toHaveBeenCalled();
    expect(screen.getByText('Promote to')).toBeInTheDocument();
  });

  it('sends the piece you chose — including an under-promotion', () => {
    setState({ play: READY });
    const c = conn();
    render(<ChessBoard connection={c} />);
    fireEvent.click(square('a7'));
    fireEvent.click(square('a8'));
    fireEvent.click(screen.getByRole('button', { name: 'Promote to knight' }));
    expect(c.makeMove).toHaveBeenCalledWith({ from: 'a7', to: 'a8', promotion: 'n' });
  });

  it('cancelling sends nothing', () => {
    setState({ play: READY });
    const c = conn();
    render(<ChessBoard connection={c} />);
    fireEvent.click(square('a7'));
    fireEvent.click(square('a8'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(c.makeMove).not.toHaveBeenCalled();
    expect(screen.queryByText('Promote to')).toBeNull();
  });
});

describe('the board says what state the game is in', () => {
  const play = (fen: string, over: Partial<ChessPlay> = {}) =>
    ({ ...START, fen, ...over }) as ChessPlay;

  it('names whose turn it is', () => {
    render(<ChessBoard connection={conn()} />);
    expect(screen.getByText('your turn')).toBeInTheDocument();
    cleanup();
    setState({ turnSeat: 1 });
    render(<ChessBoard connection={conn()} />);
    expect(screen.getByText("Jake's turn")).toBeInTheDocument();
  });

  it('says Check without ending the game', () => {
    let p = START;
    for (const [from, to] of [['e2', 'e4'], ['f7', 'f6'], ['d1', 'h5']]) {
      p = applyMove(p.fen, { from: from!, to: to! })!.play;
    }
    setState({ play: p, turnSeat: 1 });
    render(<ChessBoard connection={conn()} />);
    expect(screen.getByText(/^Check —/)).toBeInTheDocument();
  });

  it('names checkmate, stalemate and each kind of draw distinctly', () => {
    const cases: Array<[ChessPlay['over'], string]> = [
      [{ reason: 'checkmate', winner: 'b' }, 'Checkmate'],
      [{ reason: 'stalemate', winner: null }, 'Stalemate — draw'],
      [{ reason: 'insufficient-material', winner: null }, 'Draw — not enough pieces to mate'],
      [{ reason: 'threefold-repetition', winner: null }, 'Draw — same position three times'],
      [{ reason: 'fifty-move', winner: null }, 'Draw — fifty moves without a capture'],
    ];
    for (const [over, text] of cases) {
      cleanup();
      setState({ play: play(START.fen, { over }) });
      render(<ChessBoard connection={conn()} />);
      expect(screen.getByText(text), text).toBeInTheDocument();
    }
  });

  it('warns when the opponent has dropped out', () => {
    setState({ opponentDisconnected: true });
    render(<ChessBoard connection={conn()} />);
    expect(screen.getByText(/dropped out/)).toBeInTheDocument();
  });
});

describe('the board sits the way the player does', () => {
  it('puts white at the bottom for seat 0 and black at the bottom for seat 1', () => {
    render(<ChessBoard connection={conn()} />);
    // Reading order is top-left first: a8 for white, h1 for black.
    expect(screen.getAllByRole('button')[0]).toHaveAccessibleName(/^a8,/);
    cleanup();
    setState({ seat: 1, turnSeat: 1 });
    render(<ChessBoard connection={conn()} />);
    expect(screen.getAllByRole('button')[0]).toHaveAccessibleName(/^h1,/);
  });

  it('lets seat 1 move the black pieces and not the white ones', () => {
    setState({ seat: 1, turnSeat: 1, play: applyMove(START.fen, { from: 'e2', to: 'e4' })!.play });
    const c = conn();
    render(<ChessBoard connection={c} />);
    fireEvent.click(square('e7'));
    fireEvent.click(square('e5'));
    expect(c.makeMove).toHaveBeenCalledWith({ from: 'e7', to: 'e5' });
  });
});

// ── The client ──────────────────────────────────────────────────────────────

/** Stands in for the real PartySocket so the hook can be driven message by
 *  message. Implements only the five members PartyClient actually calls. */
class FakeSocket {
  static last: FakeSocket | null = null;
  private listeners: Record<string, Array<(e: unknown) => void>> = {};
  sent: Array<Record<string, unknown>> = [];
  readyState = 1;
  closed = false;
  constructor(readonly options: { party?: string; room?: string; query?: Record<string, unknown> }) {
    FakeSocket.last = this;
  }
  addEventListener(type: string, cb: (e: unknown) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.closed = true; }
  emit(msg: unknown) {
    for (const cb of this.listeners['message'] ?? []) cb({ data: JSON.stringify(msg) });
  }
}

/** The play carried by the most recent GAME_START / GAME_STATE dispatch. */
function lastPlay(): ChessPlay | null {
  for (let i = h.dispatch.mock.calls.length - 1; i >= 0; i--) {
    const a = h.dispatch.mock.calls[i]![0] as { type: string; play?: ChessPlay };
    if (a.type === 'GAME_START' || a.type === 'GAME_STATE') return a.play ?? null;
  }
  return null;
}

function startGame() {
  // 'waiting', not 'lobby': the hook deliberately tears its socket down on a
  // return to the lobby, which would close the room mid-test.
  setState({ screen: 'waiting', play: null, seat: null, turnSeat: null });
  __setPartySocketFactory(FakeSocket as never);
  const statusUpdate = vi.fn();
  const challenge = vi.fn();
  const hook = renderHook(() => useChessGame(statusUpdate, challenge));
  act(() => { hook.result.current.challengePlayer('account-1', 'chess'); });
  act(() => { FakeSocket.last!.emit({ type: 'player-joined', username: 'Jake' }); });
  return { hook, challenge, socket: FakeSocket.last! };
}

describe('the client does not trust the wire', () => {
  it('connects to chess\'s own party and challenges by account id', () => {
    const { socket, challenge } = startGame();
    expect(socket.options.party).toBe('chess');
    expect(challenge).toHaveBeenCalledWith('account-1', 'chess', expect.any(String));
    // Seat 0 created the room, so it plays white and the game opens on its turn.
    expect(h.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'GAME_START', seat: 0, turnSeat: 0 }),
    );
    expect(lastPlay()!.fen).toBe(START.fen);
  });

  it('IGNORES an illegal move that arrives over the socket', () => {
    const { socket } = startGame();
    const before = h.dispatch.mock.calls.length;
    // It is white's move, so any black move is illegal — and a relay room will
    // happily forward it. The board must not take it.
    act(() => { socket.emit({ type: 'move', username: 'Jake', move: { from: 'e7', to: 'e5' } }); });
    act(() => { socket.emit({ type: 'move', username: 'Jake', move: { from: 'e2', to: 'e9' } }); });
    act(() => { socket.emit({ type: 'move', username: 'Jake', move: { nonsense: true } }); });
    expect(h.dispatch.mock.calls.length).toBe(before);
    expect(lastPlay()!.fen).toBe(START.fen);
  });

  it('accepts a legal move from the opponent and advances the turn', () => {
    const { hook, socket } = startGame();
    act(() => { hook.result.current.makeMove({ from: 'e2', to: 'e4' }); });
    expect(socket.sent.at(-1)).toEqual({
      type: 'move', username: 'me', move: { from: 'e2', to: 'e4' },
    });
    act(() => { socket.emit({ type: 'move', username: 'Jake', move: { from: 'e7', to: 'e5' } }); });
    expect(lastPlay()!.lastMove).toEqual({ from: 'e7', to: 'e5' });
    expect(h.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'GAME_STATE', turnSeat: 0 }),
    );
  });

  it('will not send an illegal move of its own either', () => {
    const { hook, socket } = startGame();
    act(() => { hook.result.current.makeMove({ from: 'e2', to: 'e5' }); });
    act(() => { hook.result.current.makeMove('not a move' as never); });
    expect(socket.sent.filter((m) => m.type === 'move')).toHaveLength(0);
  });

  it('records the outcome when a move ends the game', () => {
    const { hook, socket } = startGame();
    // Fool's mate: white walks into it, black delivers it over the wire.
    act(() => { hook.result.current.makeMove({ from: 'f2', to: 'f3' }); });
    act(() => { socket.emit({ type: 'move', username: 'Jake', move: { from: 'e7', to: 'e5' } }); });
    act(() => { hook.result.current.makeMove({ from: 'g2', to: 'g4' }); });
    act(() => { socket.emit({ type: 'move', username: 'Jake', move: { from: 'd8', to: 'h4' } }); });
    expect(h.dispatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'GAME_STATE', outcome: { winnerSeat: 1 } }),
    );
  });

  it('a reconnecting opponent does not reset the position', () => {
    const { hook, socket } = startGame();
    act(() => { hook.result.current.makeMove({ from: 'e2', to: 'e4' }); });
    const moved = lastPlay()!.fen;
    act(() => { socket.emit({ type: 'player-joined', username: 'Jake', reconnect: true }); });
    expect(h.dispatch).toHaveBeenLastCalledWith({ type: 'OPPONENT_RECONNECTED', username: 'Jake' });
    expect(lastPlay()!.fen).toBe(moved);
  });
});
