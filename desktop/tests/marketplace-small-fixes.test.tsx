// @vitest-environment jsdom
// Three small marketplace fixes that share these files (overhaul Task 3):
//   1. a theme preview whose image fails to load must not leave a blank box
//   2. rails must show that there is more to scroll (UI audit P-17 / #26)
//   3. the detail overlay's long description must render markdown, not print it

import React from 'react';
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen, fireEvent } from '@testing-library/react';
import MarketplaceCard from '../src/renderer/components/marketplace/MarketplaceCard';
import MarketplaceRail from '../src/renderer/components/marketplace/MarketplaceRail';
import MarketplaceDetailOverlay from '../src/renderer/components/marketplace/MarketplaceDetailOverlay';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider } from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import { AccountProvider } from '../src/renderer/state/account-context';
import type { SkillEntry } from '../src/shared/types';

const LONG_DESC = 'A **bold** claim.\n\n- first\n- second';

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
  version: '1.0.0',
  longDescription: LONG_DESC,
  components: null,
  lifeArea: [],
  tags: [],
} as any);

const themeRow = () => ({
  slug: 'devils-garden',
  name: "Devil's Garden",
  description: 'Dark and floral',
  author: 'Tester',
  version: '1.0.0',
  installed: true,
  preview: 'https://raw.githubusercontent.com/itsdestin/wecoded-themes/main/themes/devils-garden/preview.png',
  previewTokens: { canvas: '#221020', accent: '#c0392b', fg: '#eeeeee' },
} as any);

function setupWindowClaude() {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
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
    marketplace: { getPackages: vi.fn().mockResolvedValue({}) },
    account: {
      start: vi.fn(), poll: vi.fn(),
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

describe('marketplace small fixes', () => {
  beforeEach(() => {
    setupWindowClaude();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  // 1 — the blank theme previews (ROADMAP: Devil's Garden, Kuromi Dreamer).
  it('a theme preview that fails to load falls back to its colours, not a blank box', async () => {
    const { container } = await renderWithProviders(
      <MarketplaceCard item={{ kind: 'theme', entry: themeRow() }} onOpen={() => {}} installed />,
    );
    const img = container.querySelector('img[src*="preview.png"]') as HTMLImageElement;
    expect(img).toBeTruthy();
    await act(async () => { fireEvent.error(img); });
    expect(container.querySelector('img[src*="preview.png"]')).toBeNull();
    // The card still shows something in that band — the theme's own colours.
    expect(container.querySelector('[data-theme-swatches]')).toBeTruthy();
  });

  it('the compact theme row survives a failed preview too', async () => {
    const { container } = await renderWithProviders(
      <MarketplaceCard item={{ kind: 'theme', entry: themeRow() }} onOpen={() => {}} installed compact />,
    );
    const img = container.querySelector('img[src*="preview.png"]') as HTMLImageElement;
    await act(async () => { fireEvent.error(img); });
    expect(container.querySelector('img[src*="preview.png"]')).toBeNull();
  });

  // 2 — rails clip with no affordance at phone width (P-17 / audit #26).
  it('the rail says there is more to scroll in each direction', async () => {
    render(<MarketplaceRail title="Featured"><div>a</div><div>b</div></MarketplaceRail>);
    const list = screen.getByRole('list');
    // jsdom has no layout, so nothing overflows on mount → no fade.
    expect(list.getAttribute('data-fade')).toBe('none');

    // Fake the metrics of a rail whose content is wider than its box.
    Object.defineProperty(list, 'scrollWidth', { value: 1000, configurable: true });
    Object.defineProperty(list, 'clientWidth', { value: 300, configurable: true });
    list.scrollLeft = 0;
    act(() => { fireEvent.scroll(list); });
    expect(list.getAttribute('data-fade')).toBe('right');

    list.scrollLeft = 350;
    act(() => { fireEvent.scroll(list); });
    expect(list.getAttribute('data-fade')).toBe('both');

    list.scrollLeft = 700;
    act(() => { fireEvent.scroll(list); });
    expect(list.getAttribute('data-fade')).toBe('left');
  });

  // 3 — longDescription printed its markdown source instead of rendering it.
  it('the detail overlay renders the long description as markdown', async () => {
    const { container } = await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(container.querySelector('strong')?.textContent).toBe('bold');
    expect(container.querySelectorAll('li').length).toBe(2);
    // The literal source must not be on screen anywhere.
    expect(container.textContent).not.toContain('**bold**');
  });
});
