// @vitest-environment jsdom
// Pins the Update action end-to-end (marketplace overhaul Task 1).
//
// WHY this test exists: the word "Update" was rendered as a plain <span> on
// every card and nowhere else in the app — no click handler, no button, no
// route to `mp.update()`. The main process could update a plugin or a theme;
// a user could not. These tests assert that every surface that SAYS "Update"
// (marketplace card, detail overlay for skills AND themes, the Library
// "Updates" tab) actually calls through, and that a failure shows the real
// message the updater returned instead of a guessed cause.

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent, waitFor } from '@testing-library/react';
import MarketplaceCard from '../src/renderer/components/marketplace/MarketplaceCard';
import MarketplaceDetailOverlay from '../src/renderer/components/marketplace/MarketplaceDetailOverlay';
import LibraryScreen from '../src/renderer/components/library/LibraryScreen';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider } from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { AccountProvider } from '../src/renderer/state/account-context';
import type { SkillEntry } from '../src/shared/types';

// The marketplace row under test: installed at 1.0.0, published at 2.0.0, so
// the provider's version compare flags it as updatable.
const skillRow = (): SkillEntry => ({
  id: 'x',
  displayName: 'Example Plugin',
  description: 'An example',
  tagline: 'An example',
  author: 'Tester',
  category: 'productivity',
  prompt: '/x',
  source: 'marketplace',
  type: 'plugin',
  visibility: 'published',
  version: '2.0.0',
  components: null,
  lifeArea: [],
  tags: [],
} as any);

const themeRow = () => ({
  slug: 'golden-sunbreak',
  name: 'Golden Sunbreak',
  description: 'Warm',
  author: 'Tester',
  version: '2.0.0',
  installed: true,
} as any);

let claudeStub: any;

function setupWindowClaude() {
  (globalThis as any).window = (globalThis as any).window ?? {};
  claudeStub = {
    skills: {
      listMarketplace: vi.fn().mockResolvedValue([skillRow()]),
      list: vi.fn().mockResolvedValue([skillRow()]),
      getFavorites: vi.fn().mockResolvedValue([]),
      getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }),
      install: vi.fn().mockResolvedValue({}),
      uninstall: vi.fn().mockResolvedValue({}),
      setFavorite: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({ ok: true }),
      publish: vi.fn().mockResolvedValue({ prUrl: '' }),
      getChips: vi.fn().mockResolvedValue([]),
      setChips: vi.fn().mockResolvedValue(undefined),
      setOverride: vi.fn().mockResolvedValue(undefined),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
    marketplace: {
      // Installed at 1.0.0 for both kinds → updateAvailable is true.
      getPackages: vi.fn().mockResolvedValue({
        x: { version: '1.0.0', source: 'marketplace' },
        'theme:golden-sunbreak': { version: '1.0.0', source: 'marketplace' },
      }),
    },
    account: {
      start: vi.fn(),
      poll: vi.fn(),
      signedIn: vi.fn().mockResolvedValue(false),
      user: vi.fn().mockResolvedValue(null),
      signOut: vi.fn().mockResolvedValue(undefined),
      updateProfile: vi.fn().mockResolvedValue({ ok: true }),
      setHandle: vi.fn().mockResolvedValue({ ok: true }),
      deleteAccount: vi.fn().mockResolvedValue({ ok: true }),
    },
    marketplaceApi: {
      install: vi.fn().mockResolvedValue({ ok: true }),
      myThumb: vi.fn().mockResolvedValue({ ok: false }),
      thumb: vi.fn().mockResolvedValue({ ok: false }),
      comment: vi.fn().mockResolvedValue({ ok: false }),
      comments: vi.fn().mockResolvedValue({ ok: false }),
      likeTheme: vi.fn().mockResolvedValue({ ok: false }),
      report: vi.fn().mockResolvedValue({ ok: false }),
    },
    theme: {
      list: vi.fn().mockResolvedValue([]),
      marketplace: {
        list: vi.fn().mockResolvedValue([themeRow()]),
        install: vi.fn().mockResolvedValue(undefined),
        uninstall: vi.fn().mockResolvedValue(undefined),
        update: vi.fn().mockResolvedValue({ ok: true }),
      },
    },
    appearance: {
      getFavoriteThemes: vi.fn().mockResolvedValue([]),
      favoriteTheme: vi.fn().mockResolvedValue(undefined),
    },
  };
  (globalThis as any).window.claude = claudeStub;
}

async function renderWithProviders(ui: React.ReactElement) {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(
      <AccountProvider pollIntervalMs={10}>
        <SkillProvider>
          <MarketplaceProvider>
            <MarketplaceStatsProvider>{ui}</MarketplaceStatsProvider>
          </MarketplaceProvider>
        </SkillProvider>
      </AccountProvider>,
    );
  });
  return result!;
}

describe('the Update action is wired to mp.update()', () => {
  beforeEach(() => {
    setupWindowClaude();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('the card Update label is a button that calls update()', async () => {
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={() => {}} installed updateAvailable />,
    );
    const btn = screen.getByRole('button', { name: 'Update' });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalledWith('x'));
  });

  it('clicking Update does not also open the detail overlay', async () => {
    const onOpen = vi.fn();
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={onOpen} installed updateAvailable />,
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('a theme card updates through the theme path', async () => {
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'theme', entry: themeRow() }} onOpen={() => {}} installed updateAvailable />,
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
    await waitFor(() =>
      expect(claudeStub.theme.marketplace.update).toHaveBeenCalledWith('golden-sunbreak'),
    );
  });

  it('shows the real failure message, not a guess', async () => {
    claudeStub.skills.update.mockResolvedValueOnce({
      ok: false,
      error: "fatal: couldn't find remote ref abc123",
    });
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={() => {}} installed updateAvailable />,
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
    await waitFor(() => expect(screen.getByText(/couldn't find remote ref/i)).toBeTruthy());
  });

  it('the compact card renders Update as a button too', async () => {
    await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: skillRow() }} onOpen={() => {}} installed updateAvailable compact />,
    );
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Update' })); });
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalledWith('x'));
  });

  it('the skill detail overlay offers Update beside Uninstall', async () => {
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'Update' });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalledWith('x'));
  });

  it('the theme detail overlay offers Update — no uninstall-then-reinstall dance', async () => {
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'theme', slug: 'golden-sunbreak' }} onClose={() => {}} />,
    );
    const btn = screen.getByRole('button', { name: 'Update' });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() =>
      expect(claudeStub.theme.marketplace.update).toHaveBeenCalledWith('golden-sunbreak'),
    );
  });

  it('the Library Updates tab can actually update', async () => {
    await renderWithProviders(<LibraryScreen onExit={() => {}} initialTab="updates" />);
    const buttons = screen.getAllByRole('button', { name: 'Update' });
    expect(buttons.length).toBeGreaterThan(0);
    await act(async () => { fireEvent.click(buttons[0]); });
    await waitFor(() => expect(claudeStub.skills.update).toHaveBeenCalled());
  });
});
