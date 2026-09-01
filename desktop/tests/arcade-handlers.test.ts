// desktop/tests/arcade-handlers.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createArcadeOps } from '../src/main/arcade-handlers';
import type { MarketplaceAuthStore } from '../src/main/marketplace-auth-store';

// The stale-board rule (spec §6.6) is the one piece of judgement in the main
// process's half of the arcade, and it is the piece a player notices: a
// leaderboard that empties itself on a network blip teaches them their scores
// were lost, which is alarming and untrue.

let signedOut = 0;
const store = (token: string | null): MarketplaceAuthStore => ({
  getToken: () => token,
  getUser: () => null,
  signOut: () => { signedOut += 1; },
} as unknown as MarketplaceAuthStore);

const boardBody = (best: number) => ({
  game: 'flappy',
  you: { id: 'you', display_name: 'You', handle: null, avatar_url: null, best_score: best, best_at: 1, rank: 1, is_you: true },
  entries: [{ id: 'you', display_name: 'You', handle: null, avatar_url: null, best_score: best, best_at: 1, rank: 1, is_you: true }],
});

const ok = (body: unknown) => ({
  ok: true, status: 200,
  text: async () => JSON.stringify(body),
  json: async () => body,
}) as unknown as Response;

const fail = (status: number, message: string) => ({
  ok: false, status,
  text: async () => JSON.stringify({ message }),
  json: async () => ({ message }),
}) as unknown as Response;

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  signedOut = 0;
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('arcade ops — reading a board', () => {
  it('returns a fresh board with cachedAt null', async () => {
    fetchMock.mockResolvedValueOnce(ok(boardBody(31)));
    const r = await createArcadeOps(store('tok')).leaderboard('flappy');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cachedAt).toBeNull();
    expect(r.value.board.entries[0]!.best_score).toBe(31);
  });

  it('serves the LAST board it held when a later fetch fails', async () => {
    const ops = createArcadeOps(store('tok'));
    fetchMock.mockResolvedValueOnce(ok(boardBody(31)));
    await ops.leaderboard('flappy');

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const r = await ops.leaderboard('flappy');
    expect(r.ok, 'an outage must not surface as an error').toBe(true);
    if (!r.ok) return;
    expect(r.value.board.entries[0]!.best_score).toBe(31);
    // Labelled with WHEN, so the renderer can say so. Never silently fresh.
    expect(typeof r.value.cachedAt).toBe('number');
  });

  it('reports the failure when it has never held a board', async () => {
    // Nothing remembered and nothing fetched: there is genuinely nothing to
    // show, and pretending otherwise would invent a board.
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const r = await createArcadeOps(store('tok')).leaderboard('flappy');
    expect(r.ok).toBe(false);
  });

  it('FORGETS the board on 401 rather than serving it to a signed-out user', async () => {
    const ops = createArcadeOps(store('tok'));
    fetchMock.mockResolvedValueOnce(ok(boardBody(31)));
    await ops.leaderboard('flappy');

    // Signed out server-side. Serving the remembered board here would show
    // someone who just signed out their friends' names.
    fetchMock.mockResolvedValueOnce(fail(401, 'expired'));
    const gone = await ops.leaderboard('flappy');
    expect(gone.ok).toBe(false);
    expect(gone.ok === false && gone.status).toBe(401);
    expect(signedOut, 'a 401 must clear the local session').toBe(1);

    // And the entry is really gone — a later outage has nothing to fall back to.
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    expect((await ops.leaderboard('flappy')).ok).toBe(false);
  });

  it('keeps a separate board per game', async () => {
    const ops = createArcadeOps(store('tok'));
    fetchMock.mockResolvedValueOnce(ok(boardBody(31)));
    await ops.leaderboard('flappy');
    fetchMock.mockRejectedValueOnce(new Error('down'));
    // A different game has never been fetched, so it has nothing remembered.
    expect((await ops.leaderboard('twenty-forty-eight')).ok).toBe(false);
  });

  it('clearCache drops everything, as sign-out requires', async () => {
    const ops = createArcadeOps(store('tok'));
    fetchMock.mockResolvedValueOnce(ok(boardBody(31)));
    await ops.leaderboard('flappy');
    ops.clearCache();
    fetchMock.mockRejectedValueOnce(new Error('down'));
    expect((await ops.leaderboard('flappy')).ok).toBe(false);
  });
});

describe('arcade ops — signed out', () => {
  it('never touches the network', async () => {
    const ops = createArcadeOps(store(null));
    const r = await ops.status();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(401);
    expect(fetchMock, 'signed out must not reach the Worker').not.toHaveBeenCalled();
  });
});

describe('arcade ops — publishing a run', () => {
  it('sends the game and score, and reports whether it became your best', async () => {
    fetchMock.mockResolvedValueOnce(ok({ ok: true, best: 31, best_at: 2, runs: 5, is_best: true }));
    const r = await createArcadeOps(store('tok')).submitScore('flappy', 31);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.is_best).toBe(true);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/games/scores');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ game: 'flappy', score: 31 });
  });

  it('a rejected submission is a value, not a throw', async () => {
    // The renderer does not await this — a throw here would surface as an
    // unhandled rejection while the player reads their score.
    fetchMock.mockResolvedValueOnce(fail(429, 'too many score submissions per hour'));
    const r = await createArcadeOps(store('tok')).submitScore('flappy', 31);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(429);
  });
});

describe('arcade ops — head-to-head records', () => {
  const recordRows = [
    { opponent_id: 'jake', game: 'chess', wins: 4, losses: 2, draws: 1, last_played_at: 1756600000 },
    { opponent_id: 'jake', game: 'connect-four', wins: 1, losses: 0, draws: 0, last_played_at: 1756500000 },
  ];

  it('returns the bare array the Worker sends, untouched', async () => {
    fetchMock.mockResolvedValueOnce(ok(recordRows));
    const r = await createArcadeOps(store('tok')).records();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(recordRows);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain('/games/records');
    // No game asked for means no filter at all. `?game=` would ask the Worker
    // for the game literally named "", which can never match anything.
    expect(String(url)).not.toContain('?');
    expect(init.method).toBe('GET');
  });

  it('narrows to one game via the query param', async () => {
    fetchMock.mockResolvedValueOnce(ok([recordRows[0]]));
    const r = await createArcadeOps(store('tok')).records('chess');
    expect(r.ok).toBe(true);
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/games/records?game=chess');
  });

  it('NEVER serves a remembered list — an outage returns the error', async () => {
    // The deliberate difference from leaderboard(): a records screen is opened
    // on purpose, and a stale "4-2" is a wrong fact about a friend, which is
    // worse than showing no number at all.
    const ops = createArcadeOps(store('tok'));
    fetchMock.mockResolvedValueOnce(ok(recordRows));
    expect((await ops.records()).ok).toBe(true);

    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const second = await ops.records();
    expect(second.ok, 'records must not fall back to a cached copy').toBe(false);
    expect(second.ok === false && second.message).toContain('network down');
  });

  it('signed out is a 401 with no network call', async () => {
    const r = await createArcadeOps(store(null)).records();
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 clears the local session, same as every other auth\'d op', async () => {
    fetchMock.mockResolvedValueOnce(fail(401, 'expired'));
    const r = await createArcadeOps(store('tok')).records();
    expect(r.ok).toBe(false);
    expect(signedOut).toBe(1);
  });

  it('an empty array is a real answer, not an error', async () => {
    // Nobody played anybody yet. That must render as "no records", not a fault.
    fetchMock.mockResolvedValueOnce(ok([]));
    const r = await createArcadeOps(store('tok')).records();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual([]);
  });
});
