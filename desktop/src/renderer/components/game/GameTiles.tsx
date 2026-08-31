// Picker tile art (spec §5.5) — four marks, tokens only, no game-owned palette.
//
// Each is a 48x36 SVG drawn from three theme values: `--inset` for the tile's
// own furniture, `--fg-muted` for the neutral player, `--accent` for YOU. That
// is the same you-vs-them language chat uses (§5.5), so the picker teaches the
// board's colour rule before the player opens a game.
//
// Deliberately flat and small: these sit four-up in a 400px pane. A tile that
// tries to be an illustration becomes noise at this size.

const BOX = { width: 48, height: 36, viewBox: '0 0 48 36' } as const;

export function ConnectFourTile() {
  // Four discs in a row, the last one yours — the win condition as the mark.
  return (
    <svg {...BOX} aria-hidden="true">
      <rect x="2" y="6" width="44" height="24" rx="4" fill="var(--inset)" />
      {[10, 20, 30].map((cx) => (
        <circle key={cx} cx={cx} cy="18" r="5" fill="var(--fg-muted)" opacity="0.55" />
      ))}
      <circle cx="40" cy="18" r="5" fill="var(--accent)" />
    </svg>
  );
}

export function ChessTile() {
  // Three squares of a board plus one piece. Not a knight glyph — a glyph at
  // 12px is a smudge, and the checker pattern reads as "chess" on its own.
  return (
    <svg {...BOX} aria-hidden="true">
      <rect x="6" y="4" width="36" height="28" rx="3" fill="var(--inset)" />
      <rect x="6" y="4" width="18" height="14" fill="var(--fg-muted)" opacity="0.28" />
      <rect x="24" y="18" width="18" height="14" fill="var(--fg-muted)" opacity="0.28" />
      <circle cx="15" cy="11" r="4.5" fill="var(--fg-muted)" opacity="0.7" />
      <circle cx="33" cy="25" r="4.5" fill="var(--accent)" />
    </svg>
  );
}

export function FlappyTile() {
  // Two pipes and a gap, with the mascot's position as the accent dot. The
  // real game flies the theme's mascot (§5.1); the tile can't, so it stands in
  // with the same accent mark every other tile uses for "you".
  return (
    <svg {...BOX} aria-hidden="true">
      <rect x="30" y="0" width="10" height="12" rx="2" fill="var(--fg-muted)" opacity="0.55" />
      <rect x="30" y="24" width="10" height="12" rx="2" fill="var(--fg-muted)" opacity="0.55" />
      <rect x="2" y="30" width="44" height="6" rx="2" fill="var(--inset)" />
      <circle cx="14" cy="16" r="5" fill="var(--accent)" />
    </svg>
  );
}

export function TwentyFortyEightTile() {
  // The value ramp itself is the mark — four tiles climbing from neutral to
  // accent, which is exactly what the board does as you merge (§5.2).
  return (
    <svg {...BOX} aria-hidden="true">
      <rect x="4" y="4" width="18" height="13" rx="2" fill="var(--fg-muted)" opacity="0.25" />
      <rect x="26" y="4" width="18" height="13" rx="2" fill="var(--accent)" opacity="0.4" />
      <rect x="4" y="19" width="18" height="13" rx="2" fill="var(--accent)" opacity="0.7" />
      <rect x="26" y="19" width="18" height="13" rx="2" fill="var(--accent)" />
    </svg>
  );
}
