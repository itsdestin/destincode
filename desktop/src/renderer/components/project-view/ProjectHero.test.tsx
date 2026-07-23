// @vitest-environment jsdom
//
// Pins the hero's action collapse. The management actions (rename, reveal,
// open repo, the sync action, and the destructive one) moved off the card and
// behind a cog menu; only "New Conversation" stays visible. These tests exist
// so a later change can't quietly strand one of them with no entry point —
// which is exactly how Connect 4 became unreachable on narrow viewports.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, within } from '@testing-library/react';
import { ProjectHero } from './ProjectHero';

vi.mock('../../platform', () => ({ getPlatform: () => 'electron' }));

// The collapse is narrow-ONLY, so every test has to state which width it's
// describing. jsdom has no matchMedia at all, so useNarrowViewport would throw
// on the optional-call fallback path without this.
function setViewport(narrow: boolean) {
  (window as any).matchMedia = (query: string) => ({
    matches: narrow,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  });
}

const baseProject = { path: '/home/d/proj', name: 'proj' } as any;
// 2026-07-23: `artifacts` dropped from HeroStats when the Artifacts tab merged
// into Files — this fixture no longer carries it (see ProjectHero.tsx).
const baseStats = {
  files: 2, conversations: 3, contextFiles: 4, activeLabel: 'today',
};

function renderHero(over: Record<string, any> = {}) {
  const props = {
    project: baseProject,
    displayName: null,
    stats: baseStats,
    repo: null,
    onOpenSwitcher: vi.fn(),
    onNewConversation: vi.fn(),
    sync: null,
    onTurnOnSync: vi.fn(),
    onSyncNow: vi.fn(),
    onRenamed: vi.fn(),
    canRemove: true,
    onRemove: vi.fn(),
    ...over,
  };
  return { props, ...render(<ProjectHero {...(props as any)} />) };
}

const openCog = () => fireEvent.click(screen.getByLabelText('Project settings'));
const menuLabels = () =>
  within(screen.getByRole('menu')).getAllByRole('menuitem').map(b => b.textContent ?? '');

beforeEach(() => {
  cleanup();
  setViewport(true); // narrow by default; the desktop block opts out
  (window as any).claude = {
    shell: { openPath: vi.fn(), openExternal: vi.fn() },
    folders: { rename: vi.fn().mockResolvedValue(undefined) },
    syncSpaces: {},
  };
});

// The collapse is a narrow-viewport accommodation, NOT a redesign. Desktop has
// the room for every action and must keep them one click away.
describe('ProjectHero on desktop', () => {
  beforeEach(() => setViewport(false));

  it('shows the management actions inline, with no cog', () => {
    renderHero();
    expect(screen.queryByLabelText('Project settings')).toBeNull();
    expect(screen.getByText('Rename')).toBeTruthy();
    expect(screen.getByText('Open in File Explorer')).toBeTruthy();
    expect(screen.getByText('Remove from YouCoded')).toBeTruthy();
    expect(screen.getByText('New Conversation')).toBeTruthy();
  });

  it('keeps Open repo as a visible button', () => {
    renderHero({ repo: { webUrl: 'https://github.com/a/b', owner: 'a', name: 'b' } });
    expect(screen.getByText('Open repo')).toBeTruthy();
  });

  it('keeps the sync action inline in the status strip', () => {
    renderHero({
      canRemove: false,
      sync: { dot: { color: 'green' }, spaceId: 'project:x', lastSynced: null, errorMessage: null, stopped: false },
    });
    expect(screen.getByText('Sync now')).toBeTruthy();
  });
});

describe('ProjectHero action collapse (narrow)', () => {
  it('keeps New Conversation on the card and nothing else', () => {
    renderHero();
    expect(screen.getByText('New Conversation')).toBeTruthy();
    // The old always-visible management buttons are gone from the card body.
    expect(screen.queryByText('Rename')).toBeNull();
    expect(screen.queryByText('Open in File Explorer')).toBeNull();
    expect(screen.queryByText('Remove from YouCoded')).toBeNull();
  });

  it('collapses rename, reveal and remove into the cog menu', () => {
    renderHero();
    openCog();
    const labels = menuLabels();
    expect(labels).toContain('Rename');
    expect(labels).toContain('Open in File Explorer');
    expect(labels).toContain('Remove from YouCoded');
  });

  it('offers Open repo only when the project has a web URL', () => {
    renderHero();
    openCog();
    expect(menuLabels().some(l => /GitHub|repository/.test(l))).toBe(false);
    cleanup();

    renderHero({ repo: { webUrl: 'https://github.com/a/b', owner: 'a', name: 'b' } });
    openCog();
    expect(menuLabels().some(l => l.includes('a/b'))).toBe(true);
  });

  // One sync ACTION per sync state — the strip itself is status-only now, so if
  // the menu doesn't carry the action there is no way to trigger it at all.
  it.each([
    ['green', 'sp', 'Sync now'],
    ['red', 'sp', 'Try syncing again'],
    ['gray', null, 'Turn on sync for this project'],
  ])('offers the %s-state sync action', (color, spaceId, label) => {
    renderHero({
      canRemove: false,
      sync: { dot: { color }, spaceId, lastSynced: null, errorMessage: null, stopped: false },
    });
    openCog();
    expect(menuLabels()).toContain(label);
  });

  it('routes the sync action to onSyncNow with the space id', () => {
    const onSyncNow = vi.fn();
    renderHero({
      onSyncNow, canRemove: false,
      sync: { dot: { color: 'green' }, spaceId: 'project:x', lastSynced: null, errorMessage: null, stopped: false },
    });
    openCog();
    fireEvent.click(screen.getByText('Sync now'));
    expect(onSyncNow).toHaveBeenCalledWith('project:x');
  });

  it('swaps the name heading for a field when renaming', () => {
    renderHero();
    expect(screen.queryByLabelText('Project nickname')).toBeNull();
    openCog();
    fireEvent.click(screen.getByText('Rename'));
    expect(screen.getByLabelText('Project nickname')).toBeTruthy();
  });

  // Stop-syncing arms an inline confirm rather than acting from the menu row —
  // the consequence copy is too long to live in a menu.
  it('arms the stop-syncing confirm instead of stopping immediately', () => {
    renderHero({
      canRemove: false,
      sync: { dot: { color: 'green' }, spaceId: 'project:proj', lastSynced: null, errorMessage: null, stopped: false },
    });
    openCog();
    fireEvent.click(screen.getByText('Stop syncing'));
    expect(screen.getByText(/no longer sync between them/)).toBeTruthy();
    expect(screen.getByText('Cancel')).toBeTruthy();
  });

  it('closes the menu after choosing an item', () => {
    renderHero();
    openCog();
    expect(screen.getByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByText('Rename'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
