import React, { useEffect, useState } from 'react';
import FavoriteStar from './FavoriteStar';

const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface Props {
  installed: boolean;
  installing: boolean;
  favorited: boolean;
  onInstall: () => void;
  onToggleFavorite: () => void;
}

/**
 * Three-state corner affordance for marketplace tiles.
 *   not installed  → download arrow (click installs)
 *   installing     → braille spinner (click disabled)
 *   installed      → FavoriteStar (click toggles favorite)
 *
 * All three states share the same top-right coordinates so swapping between
 * them does not shift surrounding card content.
 */
export default function InstallFavoriteCorner({
  installed, installing, favorited, onInstall, onToggleFavorite,
}: Props) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!installing) return;
    const id = setInterval(() => setFrame(f => (f + 1) % BRAILLE_FRAMES.length), 80);
    return () => clearInterval(id);
  }, [installing]);

  if (installed) {
    return (
      <FavoriteStar
        corner
        size="sm"
        filled={favorited}
        onToggle={onToggleFavorite}
      />
    );
  }

  if (installing) {
    return (
      <span
        role="status"
        aria-label="Installing"
        className="absolute top-1.5 right-1.5 bg-panel/80 backdrop-blur-sm p-1 rounded-md text-accent font-mono text-sm leading-none select-none"
      >
        {BRAILLE_FRAMES[frame]}
      </span>
    );
  }

  // Not installed — download affordance.
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onInstall(); }}
      aria-label="Install"
      title="Install"
      className="absolute top-1.5 right-1.5 bg-panel/80 backdrop-blur-sm p-1 rounded-md text-fg-dim hover:text-fg transition-colors"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </button>
  );
}
