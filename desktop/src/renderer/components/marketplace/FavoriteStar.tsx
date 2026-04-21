import React from 'react';

interface Props {
  filled: boolean;
  disabled?: boolean;
  disabledReason?: string;
  onToggle: () => void;
  size?: 'sm' | 'md';
  /** When true, the star is absolutely positioned to sit in the corner of a
   *  card. Default false for header/inline use. */
  corner?: boolean;
}

export default function FavoriteStar({
  filled, disabled = false, disabledReason, onToggle, size = 'md', corner = false,
}: Props) {
  const px = size === 'sm' ? 14 : 16;
  const positioning = corner
    ? 'absolute top-1.5 right-1.5 bg-panel/80 backdrop-blur-sm'
    : '';
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); if (!disabled) onToggle(); }}
      disabled={disabled}
      aria-label={filled ? 'Unfavorite' : 'Favorite'}
      aria-pressed={filled}
      title={disabled && disabledReason ? disabledReason : (filled ? 'Unfavorite' : 'Favorite')}
      className={`${positioning} p-1 rounded-md transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
        filled ? 'text-accent' : 'text-fg-dim hover:text-fg'
      }`}
    >
      <svg
        width={px} height={px} viewBox="0 0 24 24"
        fill={filled ? 'currentColor' : 'none'}
        stroke="currentColor" strokeWidth={filled ? 0 : 1.8}
        strokeLinejoin="round"
      >
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    </button>
  );
}
