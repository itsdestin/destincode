// The game slot (spec §3) — what a game declares about itself so the arcade
// shell never hardcodes a game's name, rules, or shape.
//
// STEP 1 SCOPE: this file carries the declaration only. `View` (the playfield)
// and the state split land in Step 2 — the shell is being designed first, and
// the slot's final shape depends on what that design needs. Nothing here
// imports a rules module, so adding a game to this list costs nothing yet.

import type React from 'react';
import { ConnectFourTile, ChessTile, FlappyTile, TwentyFortyEightTile } from './GameTiles';

export type GameKind = 'solo' | 'versus';

export interface GameDefinition {
  /** Stable id. NOTE: for Connect 4 this is 'connect-four' because that is the
   *  string already on the wire (usePartyGame.ts sends it today) — deliberately
   *  NOT the same as `party` below, which is the PartyKit party name. */
  id: string;
  name: string;
  kind: GameKind;
  /** One line under the name in the picker. Says what the game IS, not why it's
   *  fun — the tile has ~40 characters and the player already knows chess. */
  blurb: string;
  /** Picker tile art. Theme-token only — no game ships its own palette (§5.5). */
  Tile: React.ComponentType;
  /** Starting pane width in px. The user's resize wins and is remembered per
   *  game (§4.3) — this is only the first-open default. */
  defaultPaneWidth: number;
  /** Solo games only: how a run's result becomes a leaderboard number. */
  scoring?: { label: string; higherIsBetter: boolean };
  /** Versus games only: the PartyKit party that referees it. Distinct from `id`
   *  — the shipped party is spelled 'connectfour' (partykit.json) while the
   *  wire's gameType is 'connect-four'. Keeping both fields avoids a migration. */
  party?: string;
}

/** Registration order IS picker order. Solo games lead because they are the
 *  ones playable with nobody online — the picker must not open on two tiles
 *  that say "no friends online" (§4.1). */
export const GAMES: readonly GameDefinition[] = [
  {
    id: 'flappy',
    name: 'Flappy',
    kind: 'solo',
    blurb: 'Fly your theme\u2019s mascot through the gaps.',
    Tile: FlappyTile,
    defaultPaneWidth: 420,
    scoring: { label: 'Pipes cleared', higherIsBetter: true },
  },
  {
    id: 'twenty-forty-eight',
    name: '2048',
    kind: 'solo',
    blurb: 'Slide and merge. Put it down mid-move; nothing is lost.',
    Tile: TwentyFortyEightTile,
    defaultPaneWidth: 440,
    scoring: { label: 'Score', higherIsBetter: true },
  },
  {
    id: 'connect-four',
    name: 'Connect 4',
    kind: 'versus',
    blurb: 'Four in a row against a friend.',
    Tile: ConnectFourTile,
    defaultPaneWidth: 420,
    party: 'connectfour',
  },
  {
    id: 'chess',
    name: 'Chess',
    kind: 'versus',
    blurb: 'Full rules, refereed by the server.',
    Tile: ChessTile,
    // Widest default (§5.3): at 400px the squares are ~50px, which is
    // cramped and bad on touch. 520 puts them near 60px inside the pane's
    // padding without crowding the chat below.
    defaultPaneWidth: 520,
    party: 'chess',
  },
];

export function gameById(id: string): GameDefinition | undefined {
  return GAMES.find((g) => g.id === id);
}
