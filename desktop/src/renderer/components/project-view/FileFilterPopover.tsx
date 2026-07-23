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

const TYPE_OPTIONS: { value: FileTypeGroup; label: string }[] = [
  { value: 'document', label: 'Documents' },
  { value: 'image', label: 'Images' },
  { value: 'sheet', label: 'Spreadsheets' },
  { value: 'code', label: 'Code & configs' },
];
// Sort-by-Type was removed 2026-07-23 (Destin): the TYPE group below filters by
// type, so sorting by it too was a second, weaker way to do the same thing.
const SORT_OPTIONS: { value: FileSortKey; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'recent', label: 'Recent' },
];

// Filter chip — same rounded-full language as the seg control and the
// marketplace filter chips. `multi` switches the semantics from one-of-many
// (radio) to an independent toggle (aria-pressed), which is what the Type and
// Visibility groups actually are; only Sort is genuinely single-select.
function Chip({ active, onClick, multi, children }: {
  active: boolean; onClick(): void; multi?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role={multi ? undefined : 'radio'}
      aria-checked={multi ? undefined : active}
      aria-pressed={multi ? active : undefined}
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

function Group({ label, multi, children }: { label: string; multi?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[10px] tracking-wider text-fg-muted uppercase">{label}</span>
      <div className="flex flex-wrap gap-1.5" role={multi ? 'group' : 'radiogroup'} aria-label={label}>{children}</div>
    </div>
  );
}

export function FileFilterPopover({
  types, onTypesChange,
  sortBy, onSortBy,
  hideCode, onHideCode,
  showDeleted, onShowDeleted,
  showDeletedAvailable,
  onClose,
}: {
  // MULTI-SELECT as of 2026-07-23 (Destin: "so i can filter to Docs AND images").
  // An EMPTY set means "all types" — there is no 'all' sentinel member.
  types: ReadonlySet<FileTypeGroup>;
  onTypesChange(next: Set<FileTypeGroup>): void;
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
    types.size > 0 || !hideCode || (showDeletedAvailable && showDeleted);
  const clear = () => {
    onTypesChange(new Set());
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
      <Group label="Type" multi>
        {/* "All types" is the CLEARED state, not a member of the selection —
            picking it empties the set. The rest toggle independently. */}
        <Chip multi active={types.size === 0} onClick={() => onTypesChange(new Set())}>
          All types
        </Chip>
        {TYPE_OPTIONS.map((o) => (
          <Chip
            key={o.value}
            multi
            active={types.has(o.value)}
            onClick={() => {
              const next = new Set(types);
              if (next.has(o.value)) next.delete(o.value); else next.add(o.value);
              onTypesChange(next);
            }}
          >
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
      <Group label="Visibility" multi>
        {/* Default-ON. When the "Code & configs" TYPE filter is selected the
            parent suspends this (the two together would always show nothing). */}
        <Chip multi active={hideCode} onClick={() => onHideCode(!hideCode)}>
          Hide code & configs
        </Chip>
        {showDeletedAvailable && (
          <Chip multi active={showDeleted} onClick={() => onShowDeleted(!showDeleted)}>
            Show deleted
          </Chip>
        )}
      </Group>
    </div>
  );
}
