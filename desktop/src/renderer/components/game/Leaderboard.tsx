// Solo leaderboard (spec §6.1, §6.5, §6.6) — your best, ranked among friends.
//
// Two states carry more design weight than the populated one:
//
//  - YOU, ALONE (§6.5). The most common state early on. It must read as an
//    invitation, not a failure — so it shows the player's OWN score as a real
//    ranked row (they are #1 of 1, which is true) and puts the invitation
//    underneath as a next step, rather than replacing the board with "no data".
//
//  - STALE (§6.6). When the Worker is unreachable the board keeps showing what
//    it last knew, labelled. It never becomes an error screen, because the
//    leaderboard being down must never look like the game being down (§4.2).

import type { GameDefinition } from './game-registry';

export interface LeaderboardRow {
  accountId: string;
  name: string;
  handle: string | null;
  /** Already formatted for display — ranking is the Worker's job, not ours. */
  score: string;
  isYou: boolean;
}

interface Props {
  game: GameDefinition;
  rows: LeaderboardRow[];
  /** Set when the last fetch failed and these rows are from an earlier one.
   *  Human-readable and non-committal — we do not guess the cause. */
  staleNote?: string;
  /** Solo score not yet published because the player is signed out (§4.2). */
  unpublishedBest?: string;
  onSignIn?: () => void;
}

export default function Leaderboard({ game, rows, staleNote, unpublishedBest, onSignIn }: Props) {
  const label = game.scoring?.label ?? 'Score';
  const alone = rows.length === 1 && rows[0]!.isYou;

  // Signed out: there is no board to rank against, but there IS a personal
  // best worth showing. Showing a locked/empty board here would punish the
  // player for the exact choice §4.2 says is fine.
  if (rows.length === 0 && unpublishedBest !== undefined) {
    return (
      <div className="flex flex-col gap-2 px-3 py-3">
        <Eyebrow>{label}</Eyebrow>
        <div className="rounded-lg bg-well border border-edge-dim px-3 py-2.5 flex items-baseline justify-between gap-2">
          <span className="text-sm text-fg">Your best</span>
          <span className="text-sm font-medium text-fg tabular-nums">{unpublishedBest}</span>
        </div>
        <p className="text-2xs text-fg-muted leading-relaxed">
          Saved on this device. Sign in to rank it against your friends.
        </p>
        {onSignIn && (
          <button
            type="button"
            onClick={onSignIn}
            className="self-start text-2xs font-medium text-link hover:text-link-hover transition-colors"
          >
            Sign in
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>{label}</Eyebrow>
        {/* Stale is a NOTE, not an error: no destructive dot, no red. The board
            below is still true, just not fresh. */}
        {staleNote && <span className="text-3xs text-fg-muted">{staleNote}</span>}
      </div>

      <ol className="flex flex-col gap-1">
        {rows.map((row, i) => (
          <li
            key={row.accountId}
            // YOUR row is accent-filled; everyone else sits on the neutral
            // surface. Same you-vs-them language as the board and as chat
            // (§5.5) — so the rule is consistent everywhere it appears.
            className={`flex items-baseline gap-2 rounded-md px-3 py-2 ${
              // `well`, not `inset`: the games pane is itself bg-inset, so an
              // inset row was invisible against it (Step 1 capture).
              row.isYou ? 'bg-accent text-on-accent' : 'bg-well border border-edge-dim text-fg'
            }`}
          >
            <span className={`text-2xs tabular-nums w-4 shrink-0 ${row.isYou ? 'text-on-accent/70' : 'text-fg-muted'}`}>
              {i + 1}
            </span>
            <span className="text-sm truncate flex-1 min-w-0">
              {row.isYou ? 'You' : row.name}
              {!row.isYou && row.handle && <span className="text-fg-muted ml-1">@{row.handle}</span>}
            </span>
            <span className="text-sm font-medium tabular-nums shrink-0">{row.score}</span>
          </li>
        ))}
      </ol>

      {/* The invitation. Sits under a REAL ranked row, so the screen reads
          "you're on the board, now bring someone" — not "there is nothing
          here". */}
      {alone && (
        <p className="text-2xs text-fg-muted leading-relaxed">
          Just you so far. Add a friend and their best shows up here next to yours.
        </p>
      )}
    </div>
  );
}

// G-7: uppercase text-2xs fg-muted is the app's only section header.
function Eyebrow({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-2xs font-medium text-fg-muted tracking-wide uppercase">{children}</span>
  );
}
