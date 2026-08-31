// Workbench fixture data for the arcade shell (spec §4.1, §6.1, §6.5, §6.6).
//
// STEP 1 ONLY. These back the `arcade.*` channels registered in mock-only.ts —
// there is no real backend yet, and the whole point of Step 1 is to settle the
// shell's shape before one is built. When the Worker endpoints land, these
// become the fixture the workbench keeps using and the MOCK_ONLY rows come off.
//
// The scenarios exist because the states that are hard to get right are the
// ones you never see by accident: a board with only you on it, a service that
// is down, a player who has never played.

import { JAKE_ID, JAKE_USERNAME } from './fake-party';

export interface ArcadeStatusFixture {
  bestScore?: string;
  friendsOnline?: string[];
  unavailable?: string;
}

export interface LeaderboardRowFixture {
  accountId: string;
  name: string;
  handle: string | null;
  score: string;
  isYou: boolean;
}

/** `default` — the ordinary case: you have played both solo games, one friend
 *  is online, everything is up. */
const DEFAULT_STATUS: Record<string, ArcadeStatusFixture> = {
  'flappy': { bestScore: '31 pipes' },
  'twenty-forty-eight': { bestScore: '12,480' },
  'connect-four': { friendsOnline: [JAKE_USERNAME] },
  'chess': { friendsOnline: [JAKE_USERNAME] },
};

/** `empty` — a brand-new install. Nothing played, nobody online. This is the
 *  state the picker MUST still read as inviting (§6.5): two of the four tiles
 *  are playable right now and the screen has to make that obvious. */
const EMPTY_STATUS: Record<string, ArcadeStatusFixture> = {
  'flappy': {},
  'twenty-forty-eight': {},
  'connect-four': { friendsOnline: [] },
  'chess': { friendsOnline: [] },
};

/** `refused` — the degraded case (§6.6). The versus service is unreachable and
 *  says so in the user's words; the solo games are untouched, which is the
 *  whole argument of §4.2 applied to an outage. */
const DEGRADED_STATUS: Record<string, ArcadeStatusFixture> = {
  'flappy': { bestScore: '31 pipes' },
  'twenty-forty-eight': { bestScore: '12,480' },
  'connect-four': { unavailable: "Can't reach the game server" },
  'chess': { unavailable: "Can't reach the game server" },
};

const YOU = { accountId: 'you', name: 'You', handle: 'destin', isYou: true };

const POPULATED_BOARD: Record<string, LeaderboardRowFixture[]> = {
  'flappy': [
    { accountId: 'mira', name: 'Mira', handle: 'mira', score: '58 pipes', isYou: false },
    { ...YOU, score: '31 pipes' },
    { accountId: JAKE_ID, name: JAKE_USERNAME, handle: 'jake', score: '19 pipes', isYou: false },
  ],
  'twenty-forty-eight': [
    { ...YOU, score: '12,480' },
    { accountId: JAKE_ID, name: JAKE_USERNAME, handle: 'jake', score: '9,216', isYou: false },
  ],
};

/** The state §6.5 calls the most common one early on: you, alone. It is a REAL
 *  ranked row (#1 of 1, which is true) rather than a "no data" panel — the
 *  screen has to read as an invitation, not a failure. */
const ALONE_BOARD: Record<string, LeaderboardRowFixture[]> = {
  'flappy': [{ ...YOU, score: '31 pipes' }],
  'twenty-forty-eight': [{ ...YOU, score: '12,480' }],
};

export type ArcadeScenario = 'default' | 'empty' | 'alone' | 'degraded';

export function arcadeStatusFor(scenario: ArcadeScenario): Record<string, ArcadeStatusFixture> {
  if (scenario === 'empty') return EMPTY_STATUS;
  if (scenario === 'degraded') return DEGRADED_STATUS;
  return DEFAULT_STATUS;
}

export function arcadeBoardFor(
  scenario: ArcadeScenario,
  gameId: string,
): { rows: LeaderboardRowFixture[]; staleNote?: string } {
  if (scenario === 'empty') return { rows: [] };
  if (scenario === 'alone') return { rows: ALONE_BOARD[gameId] ?? [] };
  if (scenario === 'degraded') {
    // Degraded does NOT clear the board — it labels it. A leaderboard that
    // empties itself when the network blips teaches the player their scores
    // were lost, which is both alarming and untrue.
    return { rows: POPULATED_BOARD[gameId] ?? [], staleNote: 'Last updated a few minutes ago' };
  }
  return { rows: POPULATED_BOARD[gameId] ?? [] };
}
