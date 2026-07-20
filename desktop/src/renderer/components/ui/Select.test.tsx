// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Select } from './Select';
import { POPOVER_Z } from '../overlays/Overlay';

// WHY: testing-library does not auto-cleanup in vitest; without this each test
// accumulates DOM (including the portaled menus on document.body) and queries
// match stale renders from a previous test.
afterEach(cleanup);

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
];

function openMenu(getByRole: ReturnType<typeof render>['getByRole'], label: string) {
  fireEvent.click(getByRole('button', { name: label }));
}

describe('Select popover tier (z-index)', () => {
  it('defaults the menu to the L4 overlay z-index (100)', () => {
    const { getByRole } = render(
      <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Plain" />,
    );
    openMenu(getByRole, 'Plain');
    const menu = getByRole('listbox', { name: 'Plain' }).closest('[data-select-portal]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.zIndex).toBe('100');
  });

  it('renders the menu at POPOVER_Z when escapeHost is set (z-9000 host)', () => {
    // Pins the SessionStrip new-session fix: the provider/model Selects live in
    // the z-9000 SessionStrip dropdown, so their menus must escape above it or
    // they render behind the host and are unclickable. If this regresses, the
    // dropdowns silently vanish again.
    const { getByRole } = render(
      <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Hosted" escapeHost />,
    );
    openMenu(getByRole, 'Hosted');
    const menu = getByRole('listbox', { name: 'Hosted' }).closest('[data-select-portal]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.style.zIndex).toBe(String(POPOVER_Z));
  });
});

describe('Select portal marker', () => {
  it('marks the portaled menu with data-select-portal so hosts/other Selects can see it', () => {
    // The marker is what SessionStrip's outside-click exemption and the
    // cross-Select mousedown tolerance key off. Without it, clicking an option
    // closes the host menu (and unmounts the Select) before onChange fires.
    const { getByRole } = render(
      <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Marked" />,
    );
    openMenu(getByRole, 'Marked');
    expect(document.querySelector('[data-select-portal]')).not.toBeNull();
  });
});

describe('Select cross-portal mousedown tolerance', () => {
  it('does not close an open Select when the mousedown lands inside ANOTHER Select menu', () => {
    const { getByRole, queryByRole } = render(
      <>
        <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="First" />
        <Select options={OPTIONS} value="a" onChange={() => {}} aria-label="Second" />
      </>,
    );
    // Open the first Select, then open the second (its own menu portals out).
    openMenu(getByRole, 'First');
    openMenu(getByRole, 'Second');
    // A mousedown on the SECOND menu's option must NOT be treated as "outside"
    // by the first Select's listener (which would close it); both portals live
    // on document.body outside either trigger.
    const secondMenu = getByRole('listbox', { name: 'Second' });
    fireEvent.mouseDown(secondMenu);
    // The first Select's menu is still open (its listbox still present).
    expect(queryByRole('listbox', { name: 'First' })).not.toBeNull();
  });
});
