import React from 'react';
import { FOCUS_RING } from './Button';

/**
 * Tab rows (change 45, §1.8).
 *
 * One active-state recipe. Today Library tabs and BugReportPopup's Bug/Feature
 * share the active style but disagree on inactive (Library tints it bg-inset,
 * BugReport leaves it bare).
 *
 * DECIDED 2026-07-16: inactive is option B — transparent, hover reveals the
 * tint. Option A (always-tinted inactive) was rendered and not taken.
 *
 * Filters are NOT tabs — marketplace filter Chips stay chips (design rule 8).
 */

export type SegmentedTab = {
  id: string;
  label: React.ReactNode;
};

export type SegmentedTabsProps = {
  tabs: readonly SegmentedTab[];
  value: string;
  onChange: (id: string) => void;
  /** bare = a plain row (Library). contained = tabs share an inset trough and
   *  split the width evenly (BugReportPopup). */
  variant?: 'bare' | 'contained';
  'aria-label'?: string;
  className?: string;
};

const TAB_BASE = `px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${FOCUS_RING}`;
const TAB_ACTIVE = 'bg-accent text-on-accent';
const TAB_INACTIVE = 'text-fg-2 hover:bg-inset';

export function SegmentedTabs({
  tabs,
  value,
  onChange,
  variant = 'bare',
  className = '',
  'aria-label': ariaLabel,
}: SegmentedTabsProps) {
  const onKeyDown = (e: React.KeyboardEvent) => {
    const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
    if (delta === 0) return;
    e.preventDefault();
    const i = tabs.findIndex((t) => t.id === value);
    if (i === -1) return;
    onChange(tabs[(i + delta + tabs.length) % tabs.length].id);
  };

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={[
        variant === 'contained' ? 'flex gap-1 p-1 bg-inset/50 rounded-lg' : 'flex gap-2',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      {tabs.map((tab) => {
        const active = tab.id === value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={active}
            // Roving tabindex: the row is one tab stop, arrows move within it.
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(tab.id)}
            className={[
              TAB_BASE,
              active ? TAB_ACTIVE : TAB_INACTIVE,
              variant === 'contained' ? 'flex-1' : '',
            ]
              .filter(Boolean)
              .join(' ')}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}
