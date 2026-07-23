// One expandable card in the review timeline (mockup ledger 11/12): the
// uncommitted card and every commit card share this shell so the two states
// cannot drift apart visually.
import React from 'react';

export function GitReviewCard({
  accent, expanded, onToggle, headerLeft, headerRight, children,
}: {
  /** accent border marks the pinned Uncommitted card */
  accent?: boolean;
  expanded: boolean;
  onToggle: () => void;
  headerLeft: React.ReactNode;
  headerRight?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className={`rounded-lg border ${accent ? 'border-accent' : 'border-edge'} bg-well overflow-hidden`}>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-inset transition-colors"
      >
        <span className={`text-fg-muted text-[10px] transition-transform ${expanded ? 'rotate-90' : ''}`}>▸</span>
        {headerLeft}
        {headerRight}
      </button>
      {expanded && <div className="px-3 pb-3">{children}</div>}
    </div>
  );
}
