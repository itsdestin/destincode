// @vitest-environment jsdom
// marketplace-install-key-parity.test.tsx
//
// Bug: MarketplaceCard asked `installingIds` for a BARE marketplace id while
// marketplace-context records progress under `skill:<id>`. The two strings can
// never be equal, so a plugin install showed no "Installing…" state at all.
// Themes hid the bug because both sides already agreed on `theme:<slug>`.
//
// These tests pin the two halves together: the writer (the context) and every
// reader (the card, the detail overlay, the footer strip) must derive the key
// from the same helper — `installTrackingKey` in marketplace-context.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, fireEvent } from '@testing-library/react';
import MarketplaceCard from '../src/renderer/components/marketplace/MarketplaceCard';
import {
  MarketplaceProvider,
  installTrackingKey,
  useMarketplace,
} from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider } from '../src/renderer/state/marketplace-stats-context';
import { SkillProvider } from '../src/renderer/state/skill-context';
import type { SkillEntry } from '../src/shared/types';

// Held open so the install stays "in flight" while we assert on the card.
let releaseInstall: (() => void) | undefined;
let releaseThemeInstall: (() => void) | undefined;

function setupWindowClaude() {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    skills: {
      listMarketplace: vi.fn().mockResolvedValue([]),
      list: vi.fn().mockResolvedValue([]),
      getFavorites: vi.fn().mockResolvedValue([]),
      getFeatured: vi.fn().mockResolvedValue({ hero: [], rails: [] }),
      install: vi.fn(
        () => new Promise<any>(resolve => { releaseInstall = () => resolve({ status: 'installed', type: 'plugin' }); }),
      ),
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
        install: vi.fn(
          () => new Promise<any>(resolve => { releaseThemeInstall = () => resolve({ status: 'installed' }); }),
        ),
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

const sampleSkill: SkillEntry = {
  id: 'sample-skill',
  displayName: 'Sample Skill',
  description: 'A sample',
  tagline: 'Quick description',
  author: 'Tester',
  category: 'productivity',
  prompt: '/sample',
  source: 'marketplace',
  type: 'plugin',
  visibility: 'published',
  sourceType: 'url',
  sourceRef: 'https://github.com/o/r.git',
  components: null,
  lifeArea: [],
  tags: [],
} as any;

async function renderWithProviders(ui: React.ReactElement) {
  let result: ReturnType<typeof render> | undefined;
  await act(async () => {
    result = render(
      <SkillProvider>
        <MarketplaceProvider>
          <MarketplaceStatsProvider>{ui}</MarketplaceStatsProvider>
        </MarketplaceProvider>
      </SkillProvider>,
    );
  });
  return result!;
}

describe('install progress key parity', () => {
  beforeEach(() => {
    setupWindowClaude();
    releaseInstall = undefined;
    releaseThemeInstall = undefined;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    // Let any in-flight install settle so React isn't left updating after unmount.
    releaseInstall?.();
    releaseThemeInstall?.();
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows "Installing…" on a plugin card while its install is in flight', async () => {
    const { queryByLabelText, findByText } = await renderWithProviders(
      <MarketplaceCard item={{ kind: 'skill', entry: sampleSkill }} onOpen={() => {}} />,
    );

    const installBtn = queryByLabelText('Install');
    expect(installBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(installBtn!);
    });

    // The install promise is still pending — the card must say so.
    expect(await findByText('Installing…')).not.toBeNull();
  });

  // A theme card carries no Install button until it is installed (themes are
  // installed from the detail overlay), so the theme half is checked one level
  // down: the key the context marks must be the key the readers ask for.
  it('marks the same key the readers ask for, for both kinds', async () => {
    let seen: string[] = [];
    let api: any;

    function Probe() {
      const mp = useMarketplace();
      api = mp;
      seen = Array.from(mp.installingIds);
      return null;
    }

    await renderWithProviders(<Probe />);

    let pending: Promise<void>;
    await act(async () => {
      pending = api.installSkill('sample-skill');
    });
    expect(seen).toContain(installTrackingKey('skill', 'sample-skill'));
    await act(async () => { releaseInstall?.(); await pending; });

    await act(async () => {
      pending = api.installTheme('sample-theme');
    });
    expect(seen).toContain(installTrackingKey('theme', 'sample-theme'));
    await act(async () => { releaseThemeInstall?.(); await pending; });
  });

  // The shape of the key itself is load-bearing beyond the card:
  // InstallingFooterStrip splits on the `skill:` / `theme:` prefix to decide
  // which registry to look the display name up in. Bare ids would render as
  // raw slugs there.
  it('builds prefixed keys for both kinds', () => {
    expect(installTrackingKey('skill', 'sample-skill')).toBe('skill:sample-skill');
    expect(installTrackingKey('theme', 'sample-theme')).toBe('theme:sample-theme');
  });
});
