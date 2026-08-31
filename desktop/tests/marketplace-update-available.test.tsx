// @vitest-environment jsdom
// Pins how the marketplace decides an item has an update (marketplace overhaul
// Task 1 Step 4, completed by Task 17).
//
// WHY this test exists: the only signal used to be the version number, which is
// whatever the author last typed into plugin.json. Half the catalog mirrors
// repos whose authors never bump it, so real changes went unannounced. Task 17
// records the exact commit each install landed on, and the catalog publishes the
// commit it currently lists — so "the code moved" is now visible even when the
// version did not. The two checks stay SEPARATE and are OR'd: a deliberate
// version bump and a silent repo change are different facts, and either one
// means there is something new to fetch.

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { MarketplaceProvider, useMarketplace } from '../src/renderer/state/marketplace-context';
import { SkillProvider } from '../src/renderer/state/skill-context';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'x', displayName: 'Example', description: 'd', tagline: 'd', author: 'T',
  category: 'productivity', prompt: '/x', source: 'marketplace', type: 'plugin',
  visibility: 'published', version: '1.0.0', components: null, lifeArea: [], tags: [],
  ...over,
} as any);

let packages: Record<string, any>;
let entries: any[];

function setupWindowClaude() {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    skills: {
      listMarketplace: vi.fn(async () => entries),
      list: vi.fn(async () => []),
      getFavorites: vi.fn(async () => []),
      getFeatured: vi.fn(async () => ({ hero: [], rails: [] })),
      install: vi.fn(), uninstall: vi.fn(), setFavorite: vi.fn(), update: vi.fn(),
      publish: vi.fn(), getChips: vi.fn(async () => []), setChips: vi.fn(),
      setOverride: vi.fn(), getCuratedDefaults: vi.fn(async () => []),
    },
    marketplace: { getPackages: vi.fn(async () => packages) },
    theme: { marketplace: { list: vi.fn(async () => []), install: vi.fn(), uninstall: vi.fn(), update: vi.fn() } },
    appearance: { getFavoriteThemes: vi.fn(async () => []) },
  };
}

let seen: Record<string, boolean> = {};
function Probe() {
  seen = useMarketplace().updateAvailable;
  return null;
}

async function readUpdateAvailable() {
  await act(async () => {
    render(<SkillProvider><MarketplaceProvider><Probe /></MarketplaceProvider></SkillProvider>);
  });
  return seen;
}

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

describe('updateAvailable: version OR commit', () => {
  beforeEach(() => { setupWindowClaude(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it('flags a newer version, as it always did', async () => {
    entries = [row({ version: '2.0.0' })];
    packages = { x: { version: '1.0.0', source: 'marketplace' } };
    expect((await readUpdateAvailable()).x).toBe(true);
  });

  it('flags a moved commit even when the version never changed', async () => {
    entries = [row({ catalog: { itemType: 'plugin', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [], sourceCommit: NEW } })];
    packages = { x: { version: '1.0.0', source: 'marketplace', commit: OLD } };
    expect((await readUpdateAvailable()).x).toBe(true);
  });

  it('says nothing when both the version and the commit match', async () => {
    entries = [row({ catalog: { itemType: 'plugin', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [], sourceCommit: OLD } })];
    packages = { x: { version: '1.0.0', source: 'marketplace', commit: OLD } };
    expect((await readUpdateAvailable()).x).toBeUndefined();
  });

  it('an install made before commits were recorded never grows a badge from the commit check', async () => {
    // Every package installed before Task 17 has no `commit`. Treating "missing"
    // as "different" would light an Update badge on the user's whole library at
    // once, for nothing.
    entries = [row({ catalog: { itemType: 'plugin', origin: { tier: 'community' }, scan: { status: 'unchecked' }, capabilities: [], sourceCommit: NEW } })];
    packages = { x: { version: '1.0.0', source: 'marketplace' } };
    expect((await readUpdateAvailable()).x).toBeUndefined();
  });

  it('says nothing when the catalog lists no commit for an install that has one', async () => {
    // The reverse gap: a row that lost its catalog block (Worker outage → the
    // index.json fallback) must not read as "downgraded".
    entries = [row()];
    packages = { x: { version: '1.0.0', source: 'marketplace', commit: OLD } };
    expect((await readUpdateAvailable()).x).toBeUndefined();
  });
});
