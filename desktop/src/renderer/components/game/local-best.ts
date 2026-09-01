// Your own best score per solo game, kept on THIS computer (spec §4.2).
//
// WHY this file exists: §4.2 promises "best scores persist locally; signing in
// publishes them to the leaderboard". The first pass kept them in React state
// inside the arcade panel, which meant they were forgotten the moment the panel
// closed — Destin scored 17 pipes, the game showed it, and it vanished from
// every screen that was supposed to report it.
//
// This is deliberately NOT the leaderboard. The board is the Worker's, ranked
// among friends, and needs an account. This is the number you get for playing,
// signed in or not, online or not.

const KEY_PREFIX = 'youcoded-game-best-';

/** Reads are wrapped because localStorage throws outright in some contexts
 *  (private windows, blocked site data) rather than returning null — an
 *  unreadable best must never take the game down with it. */
export function readBest(gameId: string): number | undefined {
  try {
    const raw = localStorage.getItem(KEY_PREFIX + gameId);
    if (raw === null) return undefined;
    const n = Number(raw);
    // A corrupt value is treated as "never played" rather than trusted — a NaN
    // reaching the ranking would render as "Your best: NaN".
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined;
  } catch {
    return undefined;
  }
}

/** Records a finished run. Returns the best AFTER the run, so callers do not
 *  have to re-read. A worse run never lowers your best. */
export function recordRun(gameId: string, score: number): number {
  const prev = readBest(gameId) ?? 0;
  const best = Math.max(prev, Math.max(0, Math.floor(score)));
  try {
    localStorage.setItem(KEY_PREFIX + gameId, String(best));
  } catch {
    // Storage full or blocked. The run still counted for this session; losing
    // the record is not worth interrupting the player over.
  }
  return best;
}

/** Every local best, for the picker — which needs them all at once. */
export function readAllBests(gameIds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of gameIds) {
    const b = readBest(id);
    if (b !== undefined) out[id] = b;
  }
  return out;
}
