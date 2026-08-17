// src/renderer/components/tags/TagChip.tsx
import type { TagRecord } from '../../../shared/tags';

// A colored, plain-word tag chip (no status glyphs — per user preference). The
// color is a slot key (e.g. 'tag-blue') → var(--tag-blue). Uses the standard
// `bg-panel` surface with colored text and matching tinted border.
export function TagChip({ tag, onRemove, className = '' }: {
  tag: Pick<TagRecord, 'label' | 'color'>;
  onRemove?: () => void;
  className?: string;
}) {
  const c = `var(--${tag.color})`;
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-[1px] rounded-sm text-3xs leading-none bg-panel border ${className}`}
      style={{
        color: c,
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
