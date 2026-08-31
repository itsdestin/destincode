// desktop/tests/chess-engine.test.ts
//
// Chess's rules module (spec §5.3). The RULES are chess.js's job — these tests
// do not re-derive them, they pin the CONTRACT this app depends on:
//
//   1. `applyMove` returns null for an illegal move instead of throwing or
//      half-applying it. Both clients call it on every move that arrives over
//      the socket, so "returns null" IS the anti-cheat (`chess-room.ts` is a
//      relay and validates nothing).
//   2. The four rules people notice when they are wrong — castling, en passant,
//      promotion, and the endings — actually come through the wrapper.
import { describe, it, expect } from 'vitest';
import {
  applyMove,
  colorForSeat,
  isPromotion,
  kingSquare,
  legalTargets,
  load,
  outcomeOf,
  readPosition,
  seatForColor,
  startingPlay,
  turnSeatOf,
  type ChessPlay,
} from '../src/renderer/game/chess';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

/** Play a list of from/to moves, failing loudly on the first illegal one. */
function playAll(moves: Array<[string, string, ('q' | 'r' | 'b' | 'n')?]>): ChessPlay {
  let play = startingPlay();
  for (const [from, to, promotion] of moves) {
    const next = applyMove(play.fen, promotion ? { from, to, promotion } : { from, to });
    expect(next, `${from}${to} should be legal`).not.toBeNull();
    play = next!.play;
  }
  return play;
}

describe('the opening position', () => {
  it('starts from the standard position with white to move', () => {
    const play = startingPlay();
    expect(play.fen).toBe(START);
    expect(play.lastMove).toBeNull();
    expect(play.checkSquare).toBeNull();
    expect(play.over).toBeNull();
    // Seat 0 created the room and plays white, so seat 0 moves first.
    expect(turnSeatOf(play)).toBe(0);
    expect(colorForSeat(0)).toBe('w');
    expect(colorForSeat(1)).toBe('b');
    expect(seatForColor('w')).toBe(0);
    expect(seatForColor('b')).toBe(1);
  });

  it('reads all 32 pieces off a FEN', () => {
    const pieces = readPosition(START);
    expect(Object.keys(pieces)).toHaveLength(32);
    expect(pieces['e1']).toEqual({ type: 'k', color: 'w' });
    expect(pieces['d8']).toEqual({ type: 'q', color: 'b' });
    expect(pieces['e4']).toBeUndefined();
  });

  it('offers a knight its two opening squares and a blocked bishop none', () => {
    expect(legalTargets(START, 'b1').sort()).toEqual(['a3', 'c3']);
    expect(legalTargets(START, 'c1')).toEqual([]);
    // An empty square and a nonsense square both come back empty rather than
    // throwing — this is called straight off a click handler.
    expect(legalTargets(START, 'e4')).toEqual([]);
    expect(legalTargets(START, 'zz')).toEqual([]);
  });
});

describe('legal and illegal moves', () => {
  it('applies a legal move and records where it came from', () => {
    const next = applyMove(START, { from: 'e2', to: 'e4' })!;
    expect(next.san).toBe('e4');
    expect(next.play.lastMove).toEqual({ from: 'e2', to: 'e4' });
    expect(readPosition(next.play.fen)['e4']).toEqual({ type: 'p', color: 'w' });
    expect(turnSeatOf(next.play)).toBe(1);
  });

  it('REJECTS an illegal move rather than applying it', () => {
    // A pawn cannot go three squares.
    expect(applyMove(START, { from: 'e2', to: 'e5' })).toBeNull();
    // Moving the other side's piece on your turn.
    expect(applyMove(START, { from: 'e7', to: 'e5' })).toBeNull();
    // Moving from an empty square.
    expect(applyMove(START, { from: 'e4', to: 'e5' })).toBeNull();
    // A piece that exists but has no such move.
    expect(applyMove(START, { from: 'a1', to: 'a5' })).toBeNull();
  });

  it('rejects a move that would leave your own king in check', () => {
    // White king e1, white bishop e2, black rook e8: the bishop is pinned.
    const fen = '4r3/8/8/8/8/8/4B3/4K3 w - - 0 1';
    expect(applyMove(fen, { from: 'e2', to: 'd3' })).toBeNull();
  });

  it('survives junk instead of trusting it — this is the wire guard', () => {
    // Everything here is something a hostile or broken peer could send.
    expect(applyMove(START, { from: 'nope', to: 'alsonope' })).toBeNull();
    expect(applyMove(START, {} as never)).toBeNull();
    expect(applyMove(START, null as never)).toBeNull();
    expect(applyMove('not a fen', { from: 'e2', to: 'e4' })).toBeNull();
    expect(load('not a fen')).toBeNull();
    expect(readPosition('not a fen')).toEqual({});
  });
});

describe('the rules people notice when they are wrong', () => {
  it('castles kingside, moving the rook too', () => {
    const fen = 'r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1';
    const next = applyMove(fen, { from: 'e1', to: 'g1' })!;
    expect(next.san).toBe('O-O');
    const pieces = readPosition(next.play.fen);
    expect(pieces['g1']).toEqual({ type: 'k', color: 'w' });
    expect(pieces['f1']).toEqual({ type: 'r', color: 'w' });
    expect(pieces['e1']).toBeUndefined();
    expect(pieces['h1']).toBeUndefined();
  });

  it('captures en passant, removing the pawn that is not on the target square', () => {
    // 1.e4 e6 2.e5 d5 — white's e5 pawn may now take on d6.
    const play = playAll([['e2', 'e4'], ['e7', 'e6'], ['e4', 'e5'], ['d7', 'd5']]);
    const next = applyMove(play.fen, { from: 'e5', to: 'd6' })!;
    expect(next.san).toBe('exd6');
    const pieces = readPosition(next.play.fen);
    expect(pieces['d6']).toEqual({ type: 'p', color: 'w' });
    // THE POINT of en passant: the captured pawn was on d5, not on d6.
    expect(pieces['d5']).toBeUndefined();
  });

  it('will not promote without being told what to promote to', () => {
    const fen = '8/P6k/8/8/8/8/8/K7 w - - 0 1';
    expect(isPromotion(fen, 'a7', 'a8')).toBe(true);
    // This is WHY the board shows a picker instead of defaulting to a queen:
    // chess.js refuses the move outright when the piece is not named.
    expect(applyMove(fen, { from: 'a7', to: 'a8' })).toBeNull();

    const queened = applyMove(fen, { from: 'a7', to: 'a8', promotion: 'q' })!;
    expect(readPosition(queened.play.fen)['a8']).toEqual({ type: 'q', color: 'w' });

    // Under-promotion is a real move people make, so it has to work.
    const knighted = applyMove(fen, { from: 'a7', to: 'a8', promotion: 'n' })!;
    expect(knighted.san).toBe('a8=N');
    expect(readPosition(knighted.play.fen)['a8']).toEqual({ type: 'n', color: 'w' });
  });

  it('does not call an ordinary move a promotion', () => {
    expect(isPromotion(START, 'e2', 'e4')).toBe(false);
    expect(isPromotion('not a fen', 'e2', 'e4')).toBe(false);
  });
});

describe('how a game ends', () => {
  it('detects checkmate and names the winner by seat', () => {
    // Fool's mate: 1.f3 e5 2.g4 Qh4#. Black (seat 1) wins.
    const play = playAll([['f2', 'f3'], ['e7', 'e5'], ['g2', 'g4'], ['d8', 'h4']]);
    expect(play.over).toEqual({ reason: 'checkmate', winner: 'b' });
    expect(outcomeOf(play)).toEqual({ winnerSeat: 1 });
    // The mated king is the one flagged as in check.
    expect(play.checkSquare).toBe('e1');
  });

  it('detects stalemate as a draw, not a loss', () => {
    const play = applyMove('7k/8/6K1/8/8/8/8/5Q2 w - - 0 1', { from: 'f1', to: 'f7' })!.play;
    expect(play.over).toEqual({ reason: 'stalemate', winner: null });
    expect(outcomeOf(play)).toEqual({ draw: true });
    expect(play.checkSquare).toBeNull();
  });

  it('detects a draw by insufficient material', () => {
    // Black's king takes white's last rook: two bare kings cannot mate, so the
    // game is over even though neither player is stuck or in check.
    const play = applyMove('8/8/8/8/8/8/2k5/K1R5 b - - 0 1', { from: 'c2', to: 'c1' })!.play;
    expect(play.over).toEqual({ reason: 'insufficient-material', winner: null });
    expect(outcomeOf(play)).toEqual({ draw: true });
  });

  it('reports check without ending the game', () => {
    const play = playAll([['e2', 'e4'], ['f7', 'f6'], ['d1', 'h5']]);
    expect(play.checkSquare).toBe('e8');
    expect(play.over).toBeNull();
    expect(outcomeOf(play)).toBeNull();
  });

  it('finds either king for the check highlight', () => {
    const game = load(START)!;
    expect(kingSquare(game, 'w')).toBe('e1');
    expect(kingSquare(game, 'b')).toBe('e8');
    // The defensive branch: a position with no such king answers null rather
    // than throwing. Only reachable by tearing a board apart on purpose, which
    // is exactly what an untrusted FEN could amount to.
    game.remove('e8');
    expect(kingSquare(game, 'b')).toBeNull();
  });
});
