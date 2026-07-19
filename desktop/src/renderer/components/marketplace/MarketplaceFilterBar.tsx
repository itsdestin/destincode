// Sticky chip bar — type, vibe, meta, search.
//
// At ≥ 640px: chips render inline (current behavior).
// At < 640px: only the search input + a "Filters" button render in the sticky
//   bar; tapping the button opens a bottom-anchored FilterSheet that hosts the
//   same chip groups stacked vertically. State shape and toggle logic are
//   unchanged — the sheet is just a different layout container.
//
// Active count for the Filters button: (type ? 1 : 0) + vibes.size + meta.size.
// The query is excluded since it's already visible in the search input.

import React, { useState } from "react";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { Button, InputGroup, TextInput } from "../ui";
import { useEscClose } from "../../hooks/use-esc-close";
import { useNarrowViewport } from "../../hooks/use-narrow-viewport";

export type TypeChip = "skill" | "theme";
export type MetaChip = "new" | "popular" | "picks";

const VIBES = ["school", "work", "creative", "health", "personal", "finance", "home"] as const;
export type VibeChip = typeof VIBES[number];

export interface FilterState {
  type: TypeChip | null;
  vibes: Set<VibeChip>;
  meta: Set<MetaChip>;
  query: string;
}

export function emptyFilter(): FilterState {
  return { type: null, vibes: new Set(), meta: new Set(), query: "" };
}

export function isActive(f: FilterState): boolean {
  return f.type !== null || f.vibes.size > 0 || f.meta.size > 0 || f.query.trim().length > 0;
}

function activeFilterCount(f: FilterState): number {
  return (f.type !== null ? 1 : 0) + f.vibes.size + f.meta.size;
}

interface Props {
  value: FilterState;
  onChange(next: FilterState): void;
}

export default function MarketplaceFilterBar({ value, onChange }: Props) {
  const compact = useNarrowViewport();
  const [sheetOpen, setSheetOpen] = useState(false);

  const toggleMulti = (key: "vibes" | "meta", v: any) => {
    const next = { ...value, vibes: new Set(value.vibes), meta: new Set(value.meta) };
    const set = next[key] as Set<any>;
    if (set.has(v)) set.delete(v); else set.add(v);
    onChange(next);
  };
  const setType = (t: TypeChip) => {
    onChange({ ...value, type: value.type === t ? null : t });
  };

  if (compact) {
    const count = activeFilterCount(value);
    return (
      <>
        {/* Leading magnifier icon, borderless input, trailing filter button. This
            box was the PRECEDENT for the InputGroup primitive (change 77), so it
            now uses it rather than hand-rolling the shape. The one deliberate
            change: focus was `focus-within:ring-2 focus-within:ring-accent` and is
            now the wrapper's `focus-within:border-accent` — fields focus by border,
            never a ring (the ring belongs to buttons). */}
        <div className="layer-surface sticky top-0 z-20 p-2">
          <InputGroup size="md">
            <span className="pl-2.5 text-fg-muted shrink-0" aria-hidden>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </span>
            {/* pl-0 so the text sits next to the magnifier rather than a second
                indent — the wrapper's own gap-1 supplies the separation. */}
            <InputGroup.Field
              type="search"
              aria-label="Search the marketplace"
              placeholder="Search…"
              className="pl-0"
              value={value.query}
              onChange={(e) => onChange({ ...value, query: e.target.value })}
            />
            {/* Left hand-rolled on purpose: icon-only with an absolutely positioned
                count badge, which <Button> doesn't model. mr-1 dropped — the
                InputGroup wrapper already insets its action with pr-1. */}
            <button
              type="button"
              onClick={() => setSheetOpen(true)}
              className="shrink-0 relative p-2 rounded-md text-fg-2 hover:text-fg hover:bg-edge-dim"
              aria-label={count > 0 ? `Filters (${count} active)` : 'Filters'}
              title={count > 0 ? `Filters (${count} active)` : 'Filters'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <line x1="4" y1="6" x2="20" y2="6" />
                <line x1="6" y1="12" x2="18" y2="12" />
                <line x1="9" y1="18" x2="15" y2="18" />
              </svg>
              {count > 0 && (
                <span className="absolute -top-1 -right-1 min-w-[16px] h-[16px] px-1 rounded-full bg-accent text-on-accent text-[10px] font-medium leading-[16px] text-center">
                  {count}
                </span>
              )}
            </button>
          </InputGroup>
        </div>
        {sheetOpen && (
          <FilterSheet
            value={value}
            onChange={onChange}
            onClose={() => setSheetOpen(false)}
            toggleMulti={toggleMulti}
            setType={setType}
          />
        )}
      </>
    );
  }

  // Wide layout — unchanged from before the mobile redesign.
  return (
    <div className="layer-surface sticky top-0 z-20 flex flex-wrap items-center gap-2 p-3">
      <ChipGroup label="Type">
        <Chip active={value.type === "skill"} onClick={() => setType("skill")}>Plugins</Chip>
        <Chip active={value.type === "theme"} onClick={() => setType("theme")}>Themes</Chip>
      </ChipGroup>
      <Divider />
      <ChipGroup label="Vibe">
        {VIBES.map((v) => (
          <Chip key={v} active={value.vibes.has(v)} onClick={() => toggleMulti("vibes", v)}>
            {v[0].toUpperCase() + v.slice(1)}
          </Chip>
        ))}
      </ChipGroup>
      <Divider />
      <ChipGroup label="Meta">
        <Chip active={value.meta.has("new")} onClick={() => toggleMulti("meta", "new")}>New</Chip>
        <Chip active={value.meta.has("popular")} onClick={() => toggleMulti("meta", "popular")}>Popular</Chip>
        <Chip active={value.meta.has("picks")} onClick={() => toggleMulti("meta", "picks")}>Featured picks</Chip>
      </ChipGroup>
      <div className="w-full sm:w-auto sm:ml-auto">
        {/* The wide layout's search box — unified with the compact one above onto
            the shared FIELD surface. Same deliberate swap: focus ring → focus
            border. Only the width utilities survive as a layout extra. */}
        <TextInput
          type="search"
          size="md"
          aria-label="Search the marketplace"
          placeholder="Search…"
          value={value.query}
          onChange={(e) => onChange({ ...value, query: e.target.value })}
          className="w-full sm:w-48"
        />
      </div>
    </div>
  );
}

// Bottom-anchored sheet hosting the same chip groups stacked vertically. Built
// on the existing Scrim + OverlayPanel primitives so theme tokens (scrim color,
// blur, shadow, z-index) drive the look. Chip toggles update FilterState live —
// "Apply" is just a close affordance.
function FilterSheet({
  value, onChange, onClose, toggleMulti, setType,
}: {
  value: FilterState;
  onChange(next: FilterState): void;
  onClose(): void;
  toggleMulti(key: 'vibes' | 'meta', v: any): void;
  setType(t: TypeChip): void;
}) {
  // FilterSheet pushes onto the EscClose LIFO stack — closes top-down ahead of
  // MarketplaceScreen's own ESC handler without a gate change in the screen.
  useEscClose(true, onClose);

  const clearAll = () => {
    // Preserve the search query (it's still visible in the sticky bar) but
    // reset all chip selections.
    onChange({ ...emptyFilter(), query: value.query });
  };

  return (
    <>
      <Scrim layer={2} onClick={onClose} />
      <OverlayPanel
        layer={2}
        role="dialog"
        aria-modal
        aria-labelledby="marketplace-filter-sheet-title"
        className="fixed inset-x-2 max-h-[80vh] overflow-y-auto rounded-2xl flex flex-col"
        style={{ bottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <header className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-edge-dim bg-panel">
          <h2 id="marketplace-filter-sheet-title" className="text-base font-semibold text-fg">Filters</h2>
          <button
            type="button"
            onClick={clearAll}
            className="text-sm text-fg-2 hover:text-fg"
          >
            Clear all
          </button>
        </header>
        <div className="flex-1 flex flex-col gap-4 p-4">
          <SheetGroup label="Type">
            <Chip active={value.type === "skill"} onClick={() => setType("skill")}>Plugins</Chip>
            <Chip active={value.type === "theme"} onClick={() => setType("theme")}>Themes</Chip>
          </SheetGroup>
          <SheetGroup label="Vibe">
            {VIBES.map((v) => (
              <Chip key={v} active={value.vibes.has(v)} onClick={() => toggleMulti("vibes", v)}>
                {v[0].toUpperCase() + v.slice(1)}
              </Chip>
            ))}
          </SheetGroup>
          <SheetGroup label="Meta">
            <Chip active={value.meta.has("new")} onClick={() => toggleMulti("meta", "new")}>New</Chip>
            <Chip active={value.meta.has("popular")} onClick={() => toggleMulti("meta", "popular")}>Popular</Chip>
            <Chip active={value.meta.has("picks")} onClick={() => toggleMulti("meta", "picks")}>Featured picks</Chip>
          </SheetGroup>
        </div>
        <footer className="sticky bottom-0 z-10 px-4 py-3 border-t border-edge-dim bg-panel">
          <Button
            size="lg"
            type="button"
            onClick={onClose}
            className="w-full"
          >
            Apply
          </Button>
        </footer>
      </OverlayPanel>
    </>
  );
}

function SheetGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs uppercase tracking-wide text-fg-dim">{label}</h3>
      <div className="flex flex-wrap gap-2">{children}</div>
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={active}
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-sm transition-colors ${
        active
          ? "bg-accent text-on-accent"
          : "bg-inset text-fg-2 hover:text-fg border border-edge hover:border-edge-dim"
      }`}
    >
      {children}
    </button>
  );
}

function ChipGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5" aria-label={label}>
      {children}
    </div>
  );
}

function Divider() {
  return <span className="w-px h-5 bg-edge-dim mx-1" aria-hidden />;
}
