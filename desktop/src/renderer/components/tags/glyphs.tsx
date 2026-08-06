// src/renderer/components/tags/glyphs.tsx
//
// The three glyphs the tag/note surfaces share. Extracted 2026-07-31 when the
// close prompt's rebuilt summary needed the same mirrored tag mark the Resume
// Browser card already drew inline — two hand-copied `d` attributes is exactly
// the drift the shared-primitive rule exists to stop.
//
// All three are 24-viewBox, stroke-based, and take their size from `className`
// so a caller can render w-3 or w-4 without the path changing shape.

/** Tag, MIRRORED so the wide punched end sits on the RIGHT. The mirror matters
 *  where the glyph sits at a container's right edge (the Resume Browser card's
 *  icon cluster): the point should aim back into the content, not off the
 *  panel. Kept mirrored everywhere so the mark is one recognisable shape. */
export function TagGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <g transform="translate(24,0) scale(-1,1)">
        <path d="M3 12.5V4.5A1.5 1.5 0 014.5 3h8l8.5 8.5a1.5 1.5 0 010 2.1l-6.9 6.9a1.5 1.5 0 01-2.1 0L3 12.5z" />
        <circle cx="7.75" cy="7.75" r="1.25" />
      </g>
    </svg>
  );
}

/** A lined page with a folded corner — "there is a note here", as an OBJECT.
 *  Replaced the notebook-and-pencil glyph, which read as "edit this note" and
 *  collided with the pencil that actually edits. */
export function NotePageGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h4" />
    </svg>
  );
}

/** Pencil — "edit this". */
export function PencilGlyph({ className = '' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5" />
      <path d="M17.586 3.586a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  );
}
