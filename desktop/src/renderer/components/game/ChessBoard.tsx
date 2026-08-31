// Chess board (spec §5.3, §5.5) — Step 1 renders a fixed position so the two
// questions the deck has to answer can actually be looked at:
//
//   1. SIZING. At the shipped 400px pane the squares are ~50px. This renders
//      at the proposed 520px default so the difference is visible, not argued.
//   2. TWO-PLAYER CONTRAST. This is the open question §5.5 refuses to settle
//      by analogy: chat tells you from the assistant with fill AND position,
//      but a board has no position cue — both players' pieces sit in the same
//      grid. So: your pieces are accent, theirs are neutral, and the squares
//      are two shades of the SAME surface family so they never compete with
//      the pieces for attention.
//
// Move input, legality and the PartyKit room are Step 2. Nothing here knows a
// rule; the position is a literal.

// MEASURED, Step 1 capture: fill alone DOES NOT separate the players on a
// board. The first pass used one solid glyph set with `accent` for you and
// `fg-muted` for them, reasoning from §5.5 that chat proves fill is enough.
// In the dark theme that renders #D4D4D4 against #898989 — two light greys,
// side by side in one grid, and they were not tellable apart even knowing
// which was which. Chat gets away with it because it ALSO has position
// (right-aligned vs left); a board has no such cue.
//
// DECIDED (Destin, deck step G-8, 2026-08-30): 'outline' — the chess
// convention. Your pieces are solid, your opponent's are hollow, so the two
// sides differ in SHAPE as well as shade and stay distinct on the themes whose
// accent is itself a grey (which is all four built-ins).
//
// The two rejected options are kept behind the parameter, not deleted, because
// this rule now governs every two-player game we add and the alternatives are
// the evidence for why:
//   'disc'  your piece sits on a filled accent disc — the strongest separation,
//           rejected as too busy (16 filled circles at the opening position).
//   'fill'  the original colour-only pass — REJECTED, and the reason this step
//           existed: in the dark theme both sides render as one light grey.
const SOLID: Record<string, string> = {
  k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟',
};
const OUTLINE: Record<string, string> = {
  k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙',
};

export type PieceTreatment = 'disc' | 'outline' | 'fill';

/** Ruy Lopez, a few moves in — a real position, so the board isn't a
 *  suspiciously tidy starting row. Lowercase = theirs, uppercase = yours. */
const POSITION: (string | null)[][] = [
  ['r', null, 'b', 'q', 'k', 'b', null, 'r'],
  ['p', 'p', 'p', 'p', null, 'p', 'p', 'p'],
  [null, null, 'n', null, null, 'n', null, null],
  [null, 'B', null, null, 'p', null, null, null],
  [null, null, null, null, 'P', null, null, null],
  [null, null, null, null, null, 'N', null, null],
  ['P', 'P', 'P', 'P', null, 'P', 'P', 'P'],
  ['R', 'N', 'B', 'Q', 'K', null, null, 'R'],
];

interface Props {
  /** How the two players' pieces are told apart. Settled: 'outline'. The other
   *  two stay reachable so the decision can be re-examined, never as a user
   *  setting — one rule per app, or the games stop teaching each other. */
  treatment?: PieceTreatment;
  /** Squares the player could move to — accent wash, not a second fill (§5.3). */
  legalMoves?: string[];
  /** Square under threat — the one place --destructive appears on a board. */
  inCheck?: string;
  /** Square the player has picked up. */
  selected?: string;
}

const FILES = 'abcdefgh';
const squareName = (r: number, c: number) => `${FILES[c]}${8 - r}`;

export default function ChessBoard({ treatment = 'outline', legalMoves = [], inCheck, selected }: Props) {
  return (
    // Centred in whatever height is left, for the same reason the Connect 4
    // board now fills its width: a fixed block pinned to the top of a tall pane
    // reads as abandoned rather than placed. In Step 2 the game chat takes the
    // lower half here as it does for Connect 4, and this becomes top-aligned —
    // which is why `justify-center` sits on the wrapper and not the board.
    <div className="p-3 flex-1 min-h-0 flex flex-col justify-center">
      {/* aspect-square + w-full: the board takes the pane's width and stays
          square at ANY pane width, which is what makes §4.3's per-game default
          a real lever rather than a number in a config. */}
      <div className="w-full aspect-square grid grid-cols-8 grid-rows-8 rounded-md overflow-hidden border border-edge">
        {POSITION.map((row, r) =>
          row.map((piece, c) => {
            const name = squareName(r, c);
            const dark = (r + c) % 2 === 1;
            const isLegal = legalMoves.includes(name);
            const isSelected = selected === name;
            const isCheck = inCheck === name;
            const yours = piece != null && piece === piece.toUpperCase();

            return (
              <div
                key={name}
                className={[
                  'relative flex items-center justify-center select-none',
                  // Two shades of one surface family (§5.5) — NOT two colours.
                  // `well` is the deepest cut and `inset` sits one step up, so
                  // the checker pattern reads without either square competing
                  // with a piece for attention.
                  // Two shades one step apart were nearly identical in dark
                  // (#1C1C1C vs #222222). The accent wash gives the dark
                  // square a tint that survives every theme without
                  // introducing a colour the theme does not own.
                  dark ? 'bg-well' : 'bg-inset',
                  dark ? '' : 'bg-accent/[0.07]',
                ].join(' ')}
              >
                {/* Highlights are WASHES over the square, never a third square
                    colour — so they stack on either shade without inventing a
                    fourth surface. */}
                {isSelected && <span className="absolute inset-0 bg-accent/25" aria-hidden="true" />}
                {isLegal && !piece && (
                  <span className="absolute w-[22%] h-[22%] rounded-full bg-accent/45" aria-hidden="true" />
                )}
                {isLegal && piece && (
                  <span className="absolute inset-0 ring-2 ring-inset ring-accent/55" aria-hidden="true" />
                )}
                {isCheck && <span className="absolute inset-0 bg-destructive/30" aria-hidden="true" />}

                {piece && <Piece code={piece} yours={yours} treatment={treatment} />}
              </div>
            );
          }),
        )}
      </div>

      {/* Plain-word legend. The board's colour rule is not self-evident the
          first time you see it, and one line is cheaper than a player
          discovering it by moving the wrong piece. */}
      <div className="flex items-center gap-4 pt-2">
        <LegendDot className="bg-accent" label="You" />
        <LegendDot className={treatment === 'outline' ? 'bg-fg-dim' : 'bg-fg-muted'} label="Opponent" />
      </div>
    </div>
  );
}

/** One piece, in whichever treatment is being trialled. */
function Piece({ code, yours, treatment }: { code: string; yours: boolean; treatment: PieceTreatment }) {
  const key = code.toLowerCase();
  const size = { fontSize: 'min(6.2vw, 32px)' };

  if (treatment === 'disc' && yours) {
    // The strongest separation available without inventing a colour: your piece
    // sits ON the accent, exactly as your chat bubble and your leaderboard row
    // do. `on-accent` is computed per theme to be legible on that accent
    // (theme-validator.ts), so this cannot go grey-on-grey in any pack.
    return (
      <span className="relative flex items-center justify-center w-[76%] h-[76%] rounded-full bg-accent">
        <span className="leading-none text-on-accent" style={size}>{SOLID[key]}</span>
      </span>
    );
  }
  if (treatment === 'outline') {
    // The chess convention: the two sets differ in SHAPE, not only in colour,
    // so they stay distinct even where a theme's accent is itself a grey.
    return (
      <span className={`relative leading-none ${yours ? 'text-fg' : 'text-fg-dim'}`} style={size}>
        {yours ? SOLID[key] : OUTLINE[key]}
      </span>
    );
  }
  return (
    <span className={`relative leading-none ${yours ? 'text-accent' : 'text-fg-muted'}`} style={size}>
      {SOLID[key]}
    </span>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${className}`} aria-hidden="true" />
      <span className="text-2xs text-fg-muted">{label}</span>
    </span>
  );
}
