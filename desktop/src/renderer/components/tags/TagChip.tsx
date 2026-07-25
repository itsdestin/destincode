// src/renderer/components/tags/TagChip.tsx
import React from 'react';
import type { TagRecord } from '../../../shared/tags';

// A colored, plain-word tag chip (no status glyphs — per user preference). The
// color is a slot key (e.g. 'tag-blue') → var(--tag-blue); color-mix tints the
// fill/border so it reads on any theme surface.
export function TagChip({ tag, onRemove, className = '' }: {
  tag: Pick<TagRecord, 'label' | 'color'>;
  onRemove?: () => void;
  className?: string;
}) {
  const c = `var(--${tag.color})`;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded-sm text-3xs leading-none border ${className}`}
      style={{
        color: c,
        backgroundColor: `color-mix(in srgb, ${c} 16%, transparent)`,
        borderColor: `color-mix(in srgb, ${c} 35%, transparent)`,
      }}
    >
      {tag.label}
      {onRemove && (
        <button
          onClick={(e) => { e.stopPropagation(); onRemove(); }}
          className="opacity-60 hover:opacity-100 leading-none"
          aria-label={`Remove ${tag.label}`}
        >×</button>
      )}
    </span>
  );
}
