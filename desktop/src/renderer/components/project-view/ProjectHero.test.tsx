// @vitest-environment jsdom
//
// Pins the hero's action collapse. The management actions (rename, the sync
// action, and the destructive one) moved off the card and behind a cog menu;
// only "New Conversation" stays visible. These tests exist so a later change
// can't quietly strand one of them with no entry point — which is exactly how
// Connect 4 became unreachable on narrow viewports.
//
// "Open in File Explorer" and "Open <owner>/<name> on GitHub" are NOT part of
// that collapse — they're inline links on the path/repo row instead, rendered
// at every width (2026-07-23), so they're covered separately below rather
// than through the cog-menu tests.
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
const baseStats = {
  artifacts: 1, files: 2, conversations: 3, contextFiles: 4, activeLabel: 'today',
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
    expect(screen.getByText('Remove from YouCoded')).toBeTruthy();
    expect(screen.getByText('New Conversation')).toBeTruthy();
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
    expect(screen.queryByText('Remove from YouCoded')).toBeNull();
  });

  it('collapses rename and remove into the cog menu', () => {
    renderHero();
    openCog();
    const labels = menuLabels();
    expect(labels).toContain('Rename');
    expect(labels).toContain('Remove from YouCoded');
  });

  // 'Open in File Explorer' / 'Open <owner>/<name> on GitHub' used to be cog
  // rows too — they're gone from the menu because the path/repo row (below)
  // covers the same actions at every width, cog included.
  it('does not duplicate the path/repo links in the cog menu', () => {
    renderHero({ repo: { webUrl: 'https://github.com/a/b', owner: 'a', name: 'b' } });
    openCog();
    const labels = menuLabels();
    expect(labels.some(l => /File Explorer/.test(l))).toBe(false);
    expect(labels.some(l => /GitHub|repository/.test(l))).toBe(false);
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

// The path/repo row is NOT gated by useNarrowViewport — unlike the old
// "Open in File Explorer" / "Open repo" buttons (desktop-only / hidden below
// 640px), these links must stay reachable at every width. Covered at both
// widths on purpose; see the file-header note.
describe.each([
  ['desktop', false],
  ['narrow', true],
])('ProjectHero path/repo links (%s)', (_label, narrow) => {
  beforeEach(() => setViewport(narrow));

  it('opens the file explorer when the path is clicked', () => {
    renderHero();
    fireEvent.click(screen.getByTitle('Open in File Explorer'));
    expect((window as any).claude.shell.openPath).toHaveBeenCalledWith('/home/d/proj');
  });

  it('renders no repo link when the project has no web URL', () => {
    renderHero();
    expect(screen.queryByTitle(/on GitHub$/)).toBeNull();
  });

  it('opens the repo on GitHub when the repo slug is clicked', () => {
    renderHero({ repo: { webUrl: 'https://github.com/a/b', owner: 'a', name: 'b' } });
    fireEvent.click(screen.getByTitle('Open a/b on GitHub'));
    expect((window as any).claude.shell.openExternal).toHaveBeenCalledWith('https://github.com/a/b');
  });
});
