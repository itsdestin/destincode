// @vitest-environment jsdom
// Pins that rows the installer physically cannot take never show an Install
// button (marketplace overhaul Task 21).
//
// WHY this test exists: the catalog lists things the app cannot install yet —
// Connections mirrored from the MCP registry (added through MCP settings, not as
// a plugin) and single-file rows. The installer answers both with "Unknown
// source type", so a green Install button on those cards was a button that could
// only ever fail. Showing where the item lives instead is the honest answer.
//
// The prompt case is the subtle one. A `type: "prompt"` row installs through the
// provider's prompt path — which tests/prompt-install-update.test.ts exercises
// end to end against the real config-store logic — but ONLY when the prompt text
// travels in the row. 193 mirrored "instructions" rows are prompt-typed pointers
// with no text; installing one would store an empty prompt.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act, screen } from '@testing-library/react';
import { isInstallableSource } from '../src/shared/catalog-types';
import MarketplaceCard from '../src/renderer/components/marketplace/MarketplaceCard';
import MarketplaceDetailOverlay from '../src/renderer/components/marketplace/MarketplaceDetailOverlay';
import { MarketplaceProvider } from '../src/renderer/state/marketplace-context';
import { MarketplaceStatsProvider } from '../src/renderer/state/marketplace-stats-context';
import { AccountProvider } from '../src/renderer/state/account-context';
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
    account: { signedIn: vi.fn().mockResolvedValue(false), user: vi.fn().mockResolvedValue(null), start: vi.fn(), poll: vi.fn(), signOut: vi.fn() },
    marketplaceApi: {
      install: vi.fn().mockResolvedValue({ ok: true }),
      myThumb: vi.fn().mockResolvedValue({ ok: false }),
      thumb: vi.fn().mockResolvedValue({ ok: false }),
      comment: vi.fn().mockResolvedValue({ ok: false }),
      comments: vi.fn().mockResolvedValue({ ok: false }),
      likeTheme: vi.fn().mockResolvedValue({ ok: false }),
      report: vi.fn().mockResolvedValue({ ok: false }),
    },
    theme: { list: vi.fn().mockResolvedValue([]), marketplace: { list: vi.fn().mockResolvedValue([]), install: vi.fn(), uninstall: vi.fn(), update: vi.fn() } },
    appearance: { getFavoriteThemes: vi.fn().mockResolvedValue([]) },
  };
}

async function renderWithProviders(ui: React.ReactElement) {
  await act(async () => {
    render(
      <AccountProvider pollIntervalMs={10}>
        <SkillProvider>
          <MarketplaceProvider>
            <MarketplaceStatsProvider>{ui}</MarketplaceStatsProvider>
          </MarketplaceProvider>
        </SkillProvider>
      </AccountProvider>,
    );
  });
}

const row = (sourceType: string, type: 'plugin' | 'prompt' = 'plugin', prompt = '/x') => ({
  id: 'x', type, displayName: 'X', description: 'd', tagline: 'd', category: 'development',
  prompt, source: 'marketplace', visibility: 'published', author: 'T', version: '1.0.0',
  components: null, lifeArea: [], tags: [],
  sourceType, sourceRef: 'mcp:x', repoUrl: 'https://github.com/o/r',
  catalog: { itemType: 'tool', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [] },
} as any);

describe('rows the installer cannot install', () => {
  beforeEach(() => { setupWindowClaude(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('isInstallableSource', () => {
    expect(isInstallableSource(row('url'))).toBe(true);
    expect(isInstallableSource(row('git-subdir'))).toBe(true);
    expect(isInstallableSource(row('local'))).toBe(true);
    expect(isInstallableSource(row('file', 'prompt', 'You are a Jetpack Compose expert…'))).toBe(true);
    expect(isInstallableSource(row('file', 'prompt', ''))).toBe(false);     // a prompt row with no text
    expect(isInstallableSource(row('mcp-registry'))).toBe(false);
    expect(isInstallableSource(row('file'))).toBe(false);
    expect(isInstallableSource({})).toBe(false);                            // unknown source
  });

  it('the card shows no install button for an mcp-registry row', async () => {
    await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: row('mcp-registry') }} onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('the compact card row shows no install button either', async () => {
    await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: row('mcp-registry') }} onOpen={() => {}} compact />);
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('the card still shows Install for a plugin from git', async () => {
    await renderWithProviders(<MarketplaceCard item={{ kind: 'skill', entry: row('url') }} onOpen={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeNull();
  });

  it('an INSTALLED item keeps Uninstall even though its scanned entry has no sourceType', async () => {
    // The hazard this guards: an installed plugin is described by the locally
    // scanned entry, which carries no sourceType at all. Testing installability
    // before installed-ness would strip Uninstall from every installed item on
    // the machine — and its favorite star on the card.
    const scanned = { ...row('mcp-registry'), catalog: undefined };
    delete (scanned as any).sourceType;
    (globalThis as any).window.claude.skills.listMarketplace.mockResolvedValue([scanned]);
    (globalThis as any).window.claude.skills.list.mockResolvedValue([scanned]);
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(screen.getByRole('button', { name: 'Uninstall' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Open source' })).toBeNull();
  });

  it('the detail overlay offers Open source instead, and says why', async () => {
    // The overlay looks its target up in the marketplace context, so the row has
    // to come back from listMarketplace rather than being handed in directly.
    (globalThis as any).window.claude.skills.listMarketplace.mockResolvedValue([row('mcp-registry')]);
    await renderWithProviders(
      <MarketplaceDetailOverlay target={{ kind: 'skill', id: 'x' }} onClose={() => {}} />,
    );
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open source' })).toBeTruthy();
    expect(screen.getByText(/isn't installable from here yet/i)).toBeTruthy();
  });
});
