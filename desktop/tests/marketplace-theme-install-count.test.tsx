// @vitest-environment jsdom
// marketplace-theme-install-count.test.tsx
// Task 22: a theme card must show its download count. MarketplaceCard read the
// count out of stats.plugins only — which holds nothing for a theme — so the
// number was always 0 and the whole row was hidden. /stats now reports
// themes[slug].installs; this pins that the card reads it.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import MarketplaceCard from '../src/renderer/components/marketplace/MarketplaceCard';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import {
  MarketplaceStatsProvider,
  __resetStatsCacheForTests,
} from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';

function setupWindowClaude() {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    skills: {
      listMarketplace: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
      getFavorites: vi.fn().mockResolvedValue([]),
      getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }),
      install: vi.fn().mockResolvedValue({}),
      uninstall: vi.fn().mockResolvedValue({}),
      setFavorite: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({}),
      publish: vi.fn().mockResolvedValue({ prUrl: '' }),
      getChips: vi.fn().mockResolvedValue([]),
      setChips: vi.fn().mockResolvedValue(undefined),
      setOverride: vi.fn().mockResolvedValue(undefined),
      getCuratedDefaults: vi.fn().mockResolvedValue([]),
    },
    marketplace: { getPackages: vi.fn().mockResolvedValue({}) },
    account: { signedIn: vi.fn().mockResolvedValue(false) },
    marketplaceApi: { install: vi.fn().mockResolvedValue({ ok: true }) },
    theme: {
      marketplace: {
        list: vi.fn().mockResolvedValue([]),
        install: vi.fn().mockResolvedValue({ status: 'installed' }),
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

// The stats provider fetches GET /stats with the browser's own fetch.
function mockStats(body: object) {
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: vi.fn().mockResolvedValue(body),
  });
}

const sampleTheme = {
  slug: 'ocean-depths',
  name: 'Ocean Depths',
  description: 'Deep blue',
  author: 'Tester',
  version: '1.0.0',
  manifestUrl: 'https://example.com/manifest.json',
  installed: false,
} as any;

async function renderCard() {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(
      <SkillProvider>
        <MarketplaceProvider>
          <MarketplaceStatsProvider>
            <MarketplaceCard item={{ kind: 'theme', entry: sampleTheme }} onOpen={() => {}} />
          </MarketplaceStatsProvider>
        </MarketplaceProvider>
      </SkillProvider>
    );
  });
  return result!;
}

describe('MarketplaceCard theme download count', () => {
  beforeEach(() => {
    __resetStatsCacheForTests();
    setupWindowClaude();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the theme's install count from stats.themes", async () => {
    mockStats({
      generated_at: Date.now(),
      plugins: {},
      themes: { 'ocean-depths': { likes: 3, installs: 412 } },
    });
    const { getByTitle, getByText } = await renderCard();
    // The count renders as a download arrow whose title is the pluralised words.
    expect(getByTitle('412 installs')).toBeTruthy();
    expect(getByText('412')).toBeTruthy();
  });

  it('shows nothing when the theme has no installs yet', async () => {
    mockStats({
      generated_at: Date.now(),
      plugins: {},
      themes: { 'ocean-depths': { likes: 3, installs: 0 } },
    });
    const { queryByTitle } = await renderCard();
    expect(queryByTitle('0 installs')).toBeNull();
  });

  it('survives an older Worker that reports no installs field at all', async () => {
    mockStats({
      generated_at: Date.now(),
      plugins: {},
      themes: { 'ocean-depths': { likes: 3 } },
    });
    const { queryByTitle, getByText } = await renderCard();
    expect(queryByTitle('0 installs')).toBeNull();
    // The likes half still renders, so the card is not blank.
    expect(getByText('3 likes')).toBeTruthy();
  });
});
