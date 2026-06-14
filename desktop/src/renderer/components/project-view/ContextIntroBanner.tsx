// ContextIntroBanner — a one-time, dismiss-forever explainer that mounts at the
// top of the Context tab. It teaches a non-technical user, in one plain-language
// paragraph, what "context" files are. Once dismissed it never returns (there is
// intentionally NO "show again" affordance — the user removed it).
//
// Persistence: the dismissed state is stored under the localStorage key
// `pv-context-intro-dismissed` (value '1'). On first render we read that key so a
// previously-dismissed banner stays hidden across reloads, and we mirror it in
// local state so clicking the × hides the banner immediately without a reload.
import React, { useState } from 'react';

// localStorage key for the dismiss-forever flag. Kept in sync with the prototype
// (docs/superpowers/prototypes/2026-06-14-project-view-redesign.html).
const INTRO_DISMISSED_KEY = 'pv-context-intro-dismissed';

// Defensive reads/writes: localStorage exists in the renderer, but wrap in
// try/catch so an unexpected access failure can never throw during render.
function readDismissed(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(INTRO_DISMISSED_KEY) === '1';
  } catch {
    return false;
  }
}

function persistDismissed(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(INTRO_DISMISSED_KEY, '1');
  } catch {
    /* ignore — banner still hides via local state below */
  }
}

// Inline info-circle glyph (an "i", matching ContextTab's InfoIcon). Inline so
// the banner doesn't add a lucide import to the project-view subtree.
function InfoIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function ContextIntroBanner() {
  // Initialize from localStorage so a previously-dismissed banner never flashes
  // on mount; the local state also lets the × hide it instantly without reload.
  const [dismissed, setDismissed] = useState<boolean>(() => readDismissed());

  if (dismissed) return null;

  return (
    <div className="layer-surface relative flex gap-3 p-3.5 pr-9 mb-4">
      <span className="shrink-0 text-fg-dim mt-px">
        <InfoIcon />
      </span>
      <div className="min-w-0">
        {/* Uppercase micro-label / eyebrow, consistent with the design language. */}
        <div className="text-[10px] tracking-wider text-fg-muted uppercase mb-1">About context</div>
        {/* One plain-language paragraph — no jargon, no glyphs. */}
        <p className="text-[12.5px] text-fg-2 leading-relaxed">
          These are the notes and rules YouCoded reads to understand how you want it to work. Some
          load every time you chat, some only in certain folders or situations. Open any file to see
          or edit what shapes Claude&rsquo;s behavior here.
        </p>
      </div>
      {/* × dismiss — persists the flag AND hides immediately via local state. */}
      <button
        type="button"
        className="absolute top-2 right-2 w-6 h-6 rounded-md inline-flex items-center justify-center text-fg-muted hover:text-fg hover:bg-well transition-colors"
        title="Dismiss — won't show again"
        aria-label="Dismiss context intro"
        onClick={() => {
          persistDismissed();
          setDismissed(true);
        }}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
