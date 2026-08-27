// @vitest-environment jsdom
// SearchFilterPill — the sliders trigger is optional since P-1 #2 (the
// marketplace's wide bar uses the pill for search only; its filters are the
// chips beside it). Pins: no onToggleFilter → no trigger button rendered at
// all; with it → the trigger, its label, and the active-count badge as before.
import { describe, it, expect, afterEach, vi } from 'vitest';
import React from 'react';
import { render, cleanup } from '@testing-library/react';
import { SearchFilterPill } from '../src/renderer/components/ui/SearchFilterPill';

afterEach(cleanup);

describe('SearchFilterPill', () => {
  it('renders no trigger when onToggleFilter is absent', () => {
    const { container, getByLabelText } = render(
      <SearchFilterPill value="" onChange={() => {}} placeholder="Search…" inputAriaLabel="Search the marketplace" />,
    );
    expect(getByLabelText('Search the marketplace')).toBeTruthy();
    expect(container.querySelector('button')).toBeNull();
  });

  it('renders the trigger with its badge when onToggleFilter is given', () => {
    const onToggle = vi.fn();
    const { getByRole } = render(
      <SearchFilterPill
        value="" onChange={() => {}} placeholder="Search…" inputAriaLabel="Search"
        activeFilters={2} filterOpen={false} onToggleFilter={onToggle}
      />,
    );
    const btn = getByRole('button', { name: 'Filters (2 active)' });
    btn.click();
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(btn.textContent).toContain('2');
  });

  it('uses the caller-supplied idle label', () => {
    const { getByRole } = render(
      <SearchFilterPill
        value="" onChange={() => {}} placeholder="Search…" inputAriaLabel="Search"
        onToggleFilter={() => {}} filterLabel="Filters"
      />,
    );
    expect(getByRole('button', { name: 'Filters' })).toBeTruthy();
  });
});
