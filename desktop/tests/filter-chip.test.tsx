// @vitest-environment jsdom
// FilterChip — the app's one pick-any filter pill (UI review P-9 #1, 2026-08-27).
//
// Extracted from MarketplaceFilterBar's local Chip so the skills drawer could
// stop drawing its own 12px chips. Two things are pinned here:
//   1. The recipe is the Marketplace's ORIGINAL, verbatim — the extraction must
//      not repaint the marketplace bar. The strings below were copied from the
//      pre-extraction Chip; if they change, the marketplace changed with them.
//   2. The skills drawer actually renders it (its chips AND its Favorites
//      toggle), so no surface quietly grows its own chip recipe again. (The
//      marketplace bar stopped using chips in the 2026-08-28 overhaul round 2.)
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import { readFileSync } from 'fs';
import { join } from 'path';
import { FilterChip } from '../src/renderer/components/ui/FilterChip';
import { stripComments, RENDERER } from './helpers/guard-scope';

vi.mock('../src/renderer/state/marketplace-context', () => ({
  useMarketplace: () => ({ skillEntries: [], themeEntries: [] }),
}));
// Force the WIDE layout so the chip row itself renders (narrow hides it in a sheet).
vi.mock('../src/renderer/hooks/use-narrow-viewport', () => ({
  useNarrowViewport: () => false,
  NARROW_VIEWPORT_QUERY: '(max-width: 639.98px)',
}));

import MarketplaceFilterBar, { emptyFilter } from '../src/renderer/components/marketplace/MarketplaceFilterBar';

afterEach(cleanup);

// The Marketplace's pre-extraction Chip recipe, verbatim.
const ACTIVE = 'px-3 py-1 rounded-full text-sm transition-colors bg-accent text-on-accent';
const INACTIVE = 'px-3 py-1 rounded-full text-sm transition-colors bg-inset text-fg-2 hover:text-fg border border-edge hover:border-edge-dim';

describe('FilterChip', () => {
  it('is a checkbox that reports its state and toggles on click', () => {
    const onClick = vi.fn();
    render(<FilterChip active={false} onClick={onClick}>Work</FilterChip>);
    const chip = screen.getByRole('checkbox', { name: 'Work' });
    expect(chip.getAttribute('aria-checked')).toBe('false');
    expect(chip.getAttribute('type')).toBe('button');
    fireEvent.click(chip);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders the Marketplace recipe verbatim in both states', () => {
    render(
      <>
        <FilterChip active onClick={() => {}}>On</FilterChip>
        <FilterChip active={false} onClick={() => {}}>Off</FilterChip>
      </>,
    );
    expect(screen.getByRole('checkbox', { name: 'On' }).className).toBe(ACTIVE);
    expect(screen.getByRole('checkbox', { name: 'Off' }).className).toBe(INACTIVE);
  });

  it('takes an aria-label for chips whose visible text carries a glyph', () => {
    render(<FilterChip active={false} onClick={() => {}} aria-label="Favorites only">★ Favorites only</FilterChip>);
    expect(screen.getByRole('checkbox', { name: 'Favorites only' })).toBeTruthy();
  });
});

describe('MarketplaceFilterBar after the extraction', () => {
  // Marketplace overhaul round 2 (Destin, 2026-08-28: "keep the container to a
  // single row … collapse the other filter toggles into dropdowns"): the bar's
  // Vibe and Meta chips became two pick-one dropdowns, so the marketplace no
  // longer renders FilterChip at all. The recipe itself is still pinned above
  // and the skills drawer still consumes it (test below).
  it('draws no pick-any chips — Vibe and Show are dropdowns', () => {
    render(<MarketplaceFilterBar value={emptyFilter()} onChange={() => {}} />);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.getByLabelText('Vibe')).toBeTruthy();
    expect(screen.getByLabelText('Show')).toBeTruthy();
  });

  it('no longer carries a chip recipe of its own', () => {
    const src = stripComments(readFileSync(join(RENDERER, 'components', 'marketplace', 'MarketplaceFilterBar.tsx'), 'utf8'));
    expect(src).not.toContain('bg-accent text-on-accent');
    expect(src).not.toContain('rounded-full text-sm');
  });

  it('the skills drawer draws its chips with FilterChip too, not a local recipe', () => {
    const src = stripComments(readFileSync(join(RENDERER, 'components', 'CommandDrawer.tsx'), 'utf8'));
    expect(src).toContain('<FilterChip');
    // The retired drawer recipe: 12px chips with their own border pair, and the
    // Favorites toggle's third "on" colour.
    expect(src).not.toContain('text-xs px-2 py-0.5 rounded-full');
    expect(src).not.toContain('bg-accent/20 text-accent border-accent/50');
    expect(src).not.toContain('ml-auto');
  });
});
