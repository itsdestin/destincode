// Sticky filter bar — type switch, vibe chips, meta chips, search.
//
// At ≥ 640px: the Type switch + chips render inline, search on the right.
// At < 640px: only the search pill (with its docked filters trigger) renders in
//   the sticky bar; tapping the trigger opens a bottom-anchored FilterSheet that
//   hosts the same groups stacked vertically. State shape and toggle logic are
//   unchanged — the sheet is just a different layout container.
//
// P-1 (2026-08-26): Plugins/Themes is "pick one" so it is a SegmentedTabs row
// (with an explicit All), not two chips drawn like the pick-any chips after it;
// the search field is the app's shared SearchFilterPill at both widths.
//
// Active count for the Filters button: (type ? 1 : 0) + vibes.size + meta.size.
// The query is excluded since it's already visible in the search input.

import React, { useState } from "react";
import { Scrim, OverlayPanel } from "../overlays/Overlay";
import { Button, FilterChip, SearchFilterPill, SegmentedTabs, SegmentedTabLabel, PaletteIcon } from "../ui";
import { CATALOG_ITEM_TYPES, CATALOG_TYPE_LABEL, catalogType, type CatalogItemType } from "../../../shared/catalog-types";
import { typeIcon } from "./type-icons";
import { useMarketplace } from "../../state/marketplace-context";
import { useEscClose } from "../../hooks/use-esc-close";
import { useNarrowViewport } from "../../hooks/use-narrow-viewport";

// Marketplace overhaul (2026-08-27, decision #1): the type switch names the
// five installable kinds plus themes. "skill" used to mean "any plugin"; it
// now means an actual skill, and "plugin" is the bundle.
export type TypeChip = CatalogItemType | "theme";
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

// The Type switch always shows a selection (a tab row can't be "nothing lit"
// the way the old chips were), so "All" stands in for "no type filter".
// Round 2 (Destin, 2026-08-27): the switch is the SAME pill as the Library's Plugins |
// Themes switcher — icon + label + count, variant="pill" — so the two surfaces read as one
// control. Counts are registry sizes (what you can browse), the Library's are installed.
// Overhaul: one segment per kind — Plugins · Skills · Specialists · Tools ·
// Prompts · Themes — each counting every row of that kind, INCLUDING the
// ones that live inside a bundle (that is what picking a type is for:
// "grouped when browsing, split when looking for something specific").
// "All" counts only what the grouped grid shows (bundles + standalone items
// + themes), so the two numbers say what you will actually see.
function useTypeTabs(active: string) {
  const mp = useMarketplace();
  const counts: Record<CatalogItemType, number> = { plugin: 0, skill: 0, specialist: 0, tool: 0, prompt: 0 };
  let grouped = 0;
  for (const s of mp.skillEntries) {
    counts[catalogType(s.catalog)] += 1;
    if (!s.catalog?.partOf) grouped += 1;
  }
  const themes = mp.themeEntries.length;
  return [
    { id: "all", label: <SegmentedTabLabel icon={null} text="All" count={grouped + themes} active={active === "all"} /> },
    ...CATALOG_ITEM_TYPES.map((t) => ({
      id: t,
      label: <SegmentedTabLabel icon={typeIcon(t)} text={CATALOG_TYPE_LABEL[t].many} count={counts[t]} active={active === t} />,
    })),
    { id: "theme", label: <SegmentedTabLabel icon={<PaletteIcon />} text="Themes" count={themes} active={active === "theme"} /> },
  ];
}

interface Props {
  value: FilterState;
  onChange(next: FilterState): void;
}

export default function MarketplaceFilterBar({ value, onChange }: Props) {
  const compact = useNarrowViewport();
  const [sheetOpen, setSheetOpen] = useState(false);
  const typeTabs = useTypeTabs(value.type ?? "all");

  const toggleMulti = (key: "vibes" | "meta", v: any) => {
    const next = { ...value, vibes: new Set(value.vibes), meta: new Set(value.meta) };
    const set = next[key] as Set<any>;
    if (set.has(v)) set.delete(v); else set.add(v);
    onChange(next);
  };
  // Maps a Type tab id back onto FilterState.type. "all" → null keeps
  // isActive() / activeFilterCount() exactly as they were: no type filter.
  // (The old chip toggle — click the lit chip to clear — had no other callers;
  // the All tab is that clear action now.)
  const setTypeTab = (id: string) => {
    onChange({ ...value, type: id === "all" ? null : (id as TypeChip) });
  };

  if (compact) {
    const count = activeFilterCount(value);
    return (
      <>
        {/* P-1 #2: the shared SearchFilterPill (same shape as the file browsers
            and the wide bar below) — magnifier, rounded pill, and the sliders
            trigger docked inside with its active-count badge. Replaces a
            hand-rolled InputGroup + icon button that drew the same thing. */}
        <div className="layer-surface sticky top-0 z-20 p-2">
          <SearchFilterPill
            value={value.query}
            onChange={(q) => onChange({ ...value, query: q })}
            placeholder="Search…"
            inputAriaLabel="Search the marketplace"
            activeFilters={count}
            filterOpen={sheetOpen}
            onToggleFilter={() => setSheetOpen(true)}
            filterLabel="Filters"
          />
        </div>
        {sheetOpen && (
          <FilterSheet
            value={value}
            onChange={onChange}
            onClose={() => setSheetOpen(false)}
            toggleMulti={toggleMulti}
            setTypeTab={setTypeTab}
          />
        )}
      </>
    );
  }

  // Wide layout.
  return (
    <div className="layer-surface sticky top-0 z-20 flex flex-wrap items-center gap-2 p-3">
      {/* P-1 #1: pick-one Type switch, visually distinct from the pick-any
          chips that follow. Same position as the old Plugins/Themes chips. */}
      <SegmentedTabs
        variant="pill"
        tabs={typeTabs}
        value={value.type ?? "all"}
        onChange={setTypeTab}
        aria-label="Type"
      />
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
        {/* P-1 #2: the same SearchFilterPill as the narrow bar, minus the
            sliders trigger — the chips beside it ARE the filters, so passing no
            onToggleFilter omits the button entirely. w-56 (was w-48) pays for
            the magnifier so the placeholder still fits. */}
        <SearchFilterPill
          value={value.query}
          onChange={(q) => onChange({ ...value, query: q })}
          placeholder="Search…"
          inputAriaLabel="Search the marketplace"
          className="w-full sm:w-56"
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
  value, onChange, onClose, toggleMulti, setTypeTab,
}: {
  value: FilterState;
  onChange(next: FilterState): void;
  onClose(): void;
  toggleMulti(key: 'vibes' | 'meta', v: any): void;
  setTypeTab(id: string): void;
}) {
  // FilterSheet pushes onto the EscClose LIFO stack — closes top-down ahead of
  // MarketplaceScreen's own ESC handler without a gate change in the screen.
  useEscClose(true, onClose);
  const typeTabs = useTypeTabs(value.type ?? "all");

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
            {/* P-1 #1: same pick-one switch as the wide bar. Overhaul: seven
                segments no longer fit a phone — the row scrolls sideways and
                bleeds to the sheet's edges (§4.8) instead of being clipped. */}
            <div className="w-full -mx-4 px-4 overflow-x-auto" style={{ width: 'calc(100% + 2rem)' }}>
              <SegmentedTabs
                variant="pill"
                tabs={typeTabs}
                value={value.type ?? "all"}
                onChange={setTypeTab}
                aria-label="Type"
              />
            </div>
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

// P-9 #1 (2026-08-27): the pick-any chip is the shared <FilterChip> now — this
// bar's local Chip was extracted verbatim so the skills drawer could draw the
// same control. Kept as a one-line alias so the JSX below reads unchanged;
// tests/filter-chip.test.tsx pins that the recipe rendered here is identical.
function Chip({ active, onClick, children }: { active: boolean; onClick(): void; children: React.ReactNode }) {
  return <FilterChip active={active} onClick={onClick}>{children}</FilterChip>;
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
