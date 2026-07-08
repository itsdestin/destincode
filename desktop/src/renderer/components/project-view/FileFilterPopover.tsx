// FileFilterPopover — the anchored dropdown behind the sliders icon in the
// Project View search pill. Hosts ALL file filter/sort controls (type filter,
// sort, and — Artifacts tab only — the "Show deleted" toggle) so the seg-row
// stays a single clean pill instead of a strip of mixed dropdowns and chips
// (design feedback 2026-07-08).
//
// Anchored popover, NOT a modal: styled with .layer-surface per the overlay
// conventions (dropdowns/context menus skip the scrim), closed by ESC via the
// shared LIFO stack. Click-outside closing is owned by the PARENT (ProjectView
// listens on the wrapper that contains both the trigger button and this
// popover) — owning it here would race the trigger's own click and re-toggle.
import React from 'react';
import { useEscClose } from '../../hooks/use-esc-close';
import type { FileTypeGroup } from '../../../shared/artifacts/categorization';
import type { FileSortKey } from './tabs/FilesTab';

const TYPE_OPTIONS: { value: 'all' | FileTypeGroup; label: string }[] = [
  { value: 'all', label: 'All types' },
  { value: 'document', label: 'Documents' },
  { value: 'image', label: 'Images' },
  { value: 'sheet', label: 'Spreadsheets' },
  { value: 'code', label: 'Code & configs' },
];
const SORT_OPTIONS: { value: FileSortKey; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Recent' },
  { value: 'type', label: 'Type' },
];

// Single-select chip — same rounded-full language as the seg control and the
// marketplace filter chips.
function Chip({ active, onClick, children }: {
  active: boolean; onClick(): void; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={`px-2.5 py-1 rounded-full text-[12px] transition-colors ${
        active
          ? 'bg-accent text-on-accent'
          : 'bg-inset text-fg-2 hover:text-fg border border-edge hover:border-edge-dim'
      }`}
    >
      {children}
    </button>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] tracking-wider text-fg-muted uppercase">{label}</span>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>{children}</div>
    </div>
  );
}

export function FileFilterPopover({
  typeFilter, onTypeFilter,
  sortBy, onSortBy,
  hideCode, onHideCode,
  showDeleted, onShowDeleted,
  showDeletedAvailable,
  onClose,
}: {
  typeFilter: 'all' | FileTypeGroup;
  onTypeFilter(v: 'all' | FileTypeGroup): void;
  sortBy: FileSortKey;
  onSortBy(v: FileSortKey): void;
  // Hide code & configs — ON by default (the default view is documents-first;
  // non-developers shouldn't wade through source files to find their docs).
  hideCode: boolean;
  onHideCode(v: boolean): void;
  showDeleted: boolean;
  onShowDeleted(v: boolean): void;
  // "Show deleted" only makes sense for the tracked Artifacts tab (All files
  // has nothing tracked to un-hide) — the parent gates it by active tab.
  showDeletedAvailable: boolean;
  onClose(): void;
}) {
  // ESC pops this popover ahead of the Project View's own close handler —
  // registered later, so the shared LIFO stack handles the ordering.
  useEscClose(true, onClose);

  // Sort is a preference, not a filter, so "Clear" only resets the filters —
  // back to their DEFAULTS, which for hideCode is ON.
  const filtersActive =
    typeFilter !== 'all' || !hideCode || (showDeletedAvailable && showDeleted);
  const clear = () => {
    onTypeFilter('all');
    onHideCode(true);
    if (showDeletedAvailable) onShowDeleted(false);
  };

  return (
    <div
      className="layer-surface absolute right-0 top-full mt-2 w-[264px] p-3 flex flex-col gap-3 z-30"
      role="dialog"
      aria-label="File filters"
    >
      <div className="flex items-center justify-between">
        <span className="text-[12.5px] font-medium text-fg">Filters</span>
        {filtersActive && (
          <button
            type="button"
            className="text-[11.5px] text-fg-2 hover:text-fg transition-colors"
            onClick={clear}
          >
            Clear
          </button>
        )}
      </div>
      <Group label="Type">
        {TYPE_OPTIONS.map((o) => (
          <Chip key={o.value} active={typeFilter === o.value} onClick={() => onTypeFilter(o.value)}>
            {o.label}
          </Chip>
        ))}
      </Group>
      <Group label="Sort by">
        {SORT_OPTIONS.map((o) => (
          <Chip key={o.value} active={sortBy === o.value} onClick={() => onSortBy(o.value)}>
            {o.label}
          </Chip>
        ))}
      </Group>
      <Group label="Visibility">
        {/* Default-ON. When the "Code & configs" TYPE filter is selected the
            parent suspends this (the two together would always show nothing). */}
        <Chip active={hideCode} onClick={() => onHideCode(!hideCode)}>
          Hide code & configs
        </Chip>
        {showDeletedAvailable && (
          <Chip active={showDeleted} onClick={() => onShowDeleted(!showDeleted)}>
            Show deleted
          </Chip>
        )}
      </Group>
    </div>
  );
}
