// Pins the marketplace overhaul's read path (Tasks 16 + 18).
//
// WHY this test exists: the app used to read one file — index.json on GitHub raw.
// The Worker's /catalog is now the source of truth (it carries the type / origin /
// scan / capabilities block the redesigned UI renders) and index.json is only the
// fallback for an outage or an old Worker. Getting the ORDER wrong, or dropping the
// ETag, would either blank the grid or re-download several megabytes every hour.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The provider builds its cache path from os.homedir() AT MODULE LOAD, and reads
// YOUCODED_CATALOG_URL the same way. vi.hoisted runs before the imports below, so
// this is the only place these can be set — a plain assignment here would run too
// late and the test would write into the real ~/.claude cache.
const home = vi.hoisted(() => {
  const fsMod = require('fs') as typeof import('fs');
  const osMod = require('os') as typeof import('os');
  const pathMod = require('path') as typeof import('path');
  const dir = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'yc-catalog-'));
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  process.env.YOUCODED_CATALOG_URL = 'https://catalog.test/catalog';
  return dir;
});

// skill-provider imports the installer and the logger at module load; nothing in
// the read path uses either, but both have to resolve without touching disk.
const inst = vi.hoisted(() => ({
  installPlugin: vi.fn(),
  upgradePluginFromLocal: vi.fn(),
  refreshLocalMarketplaceCache: vi.fn(),
  readPluginVersion: vi.fn(),
  isPluginInstalled: vi.fn(),
  sweepStaleUpgradeDirs: vi.fn(),
  marketplaceCacheDir: vi.fn(() => '/tmp/cache'),
  pluginInstallDir: vi.fn((id: string) => `/tmp/plugins/${id}`),
  uninstallPlugin: vi.fn(),
}));
vi.mock('../src/main/plugin-installer', () => inst);
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
// install() reconciles hooks and MCP servers afterwards; neither is under test
// here and both would write into ~/.claude.
vi.mock('../src/main/hook-reconciler', () => ({ reconcileHooks: vi.fn() }));
vi.mock('../src/main/mcp-reconciler', () => ({ reconcileMcp: vi.fn(async () => {}) }));

import { LocalSkillProvider } from '../src/main/skill-provider';

const CATALOG_ROW = {
  id: 'superpowers', type: 'plugin', displayName: 'Superpowers', description: 'x', category: 'development',
  author: 'Anthropic', tags: [], version: '1.0.1', publishedAt: '2026-01-01T00:00:00Z',
  sourceMarketplace: 'anthropic', sourceType: 'url', sourceRef: 'https://github.com/obra/superpowers.git',
  catalog: { itemType: 'plugin', origin: { tier: 'verified' }, scan: { status: 'checked' }, capabilities: [], sourceCommit: 'e91a6c0' },
} as any;
const INDEX_ROW = { ...CATALOG_ROW, catalog: undefined };

const CACHE_DIR = path.join(home, '.claude', 'youcoded-marketplace-cache');

function makeProvider() {
  const p = new LocalSkillProvider();
  // getInstalled() scans ~/.claude for plugin dirs; the read path under test does
  // not care what is installed, and a real scan would make the test machine-dependent.
  vi.spyOn(p, 'getInstalled').mockResolvedValue([]);
  return p;
}

/** Age a cache envelope past every TTL without changing its body or its ETag. */
function ageCache(file: string) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...raw, fetchedAt: 0 }));
}

// Module-scope so the second describe (Task 18) reuses it.
let fetchMock: ReturnType<typeof vi.fn>;

describe('fetchIndex — catalog first, index.json fallback', () => {
  beforeEach(() => {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  it('returns catalog rows (with the catalog block) when the Worker answers', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ generated_at: 1, entries: [CATALOG_ROW] }), { status: 200 }));
    const entries = await makeProvider().listMarketplace();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://catalog.test/catalog');
    expect(entries[0].catalog?.sourceCommit).toBe('e91a6c0');
  });

  it('falls back to raw index.json when the Worker fails', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([INDEX_ROW]), { status: 200 }));
    const entries = await makeProvider().listMarketplace();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toMatch(/raw\.githubusercontent\.com.*\/index\.json$/);
    expect(entries[0].id).toBe('superpowers');
    expect(entries[0].catalog).toBeUndefined();
  });

  it('sends If-None-Match once it has an ETag, and keeps the body on a 304', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ generated_at: 1, entries: [CATALOG_ROW] }), { status: 200, headers: { ETag: '"cat-7"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const p = makeProvider();
    await p.listMarketplace();
    ageCache(path.join(CACHE_DIR, 'catalog.json'));
    const entries = await p.listMarketplace();
    const init = fetchMock.mock.calls[1][1] as RequestInit;
    expect((init.headers as Record<string, string>)['If-None-Match']).toBe('"cat-7"');
    expect(entries[0].id).toBe('superpowers');          // 304 → cached body reused
    expect(fetchMock).toHaveBeenCalledTimes(2);         // never fell through to index.json
  });

  it('a 304 resets the TTL, so the next call is served from cache', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ generated_at: 1, entries: [CATALOG_ROW] }), { status: 200, headers: { ETag: '"cat-7"' } }))
      .mockResolvedValueOnce(new Response(null, { status: 304 }));
    const p = makeProvider();
    await p.listMarketplace();
    ageCache(path.join(CACHE_DIR, 'catalog.json'));
    await p.listMarketplace();
    await p.listMarketplace();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('serves the catalog from cache within the TTL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ generated_at: 1, entries: [CATALOG_ROW] }), { status: 200 }));
    const p = makeProvider();
    await p.listMarketplace();
    await p.listMarketplace();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves a stale catalog cache when both network paths fail', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ generated_at: 1, entries: [CATALOG_ROW] }), { status: 200 }));
    const p = makeProvider();
    await p.listMarketplace();
    ageCache(path.join(CACHE_DIR, 'catalog.json'));
    fetchMock.mockRejectedValue(new Error('offline'));
    const entries = await p.listMarketplace();
    expect(entries[0].id).toBe('superpowers');
  });
});


describe('install — the catalog commit is passed down and recorded', () => {
  const FULL_SHA = 'e91a6c0ffffffffffffffffffffffffffffffff';

  beforeEach(() => {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  /** A provider whose config store lives entirely in memory. */
  function makeInstallProvider(rows: any[]) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ generated_at: 1, entries: rows }), { status: 200 }));
    const config: any = { version: 2, favorites: [], chips: [], overrides: {}, privateSkills: [], packages: {} };
    const p = makeProvider();
    vi.spyOn(p.configStore, 'load').mockImplementation(() => config);
    vi.spyOn(p.configStore as any, 'save').mockImplementation(() => {});
    return p;
  }

  it('passes catalog.sourceCommit to the installer and stores the sha it landed on', async () => {
    inst.installPlugin.mockResolvedValue({ status: 'installed', commit: FULL_SHA });
    const p = makeInstallProvider([CATALOG_ROW]);
    await p.install('superpowers');
    expect(inst.installPlugin.mock.calls[0][0]).toMatchObject({ sourceCommit: 'e91a6c0' });
    expect(p.configStore.getPackage('superpowers')?.commit).toBe(FULL_SHA);
  });

  it('sends no commit — and records none — for a row with no catalog block', async () => {
    // The `?? sourceSha` regression guard, one level up from the installer: an
    // entry carrying only the registry's stale sourceSha must still install latest.
    inst.installPlugin.mockResolvedValue({ status: 'installed' });
    const p = makeInstallProvider([{ ...INDEX_ROW, sourceSha: 'stale123' }]);
    await p.install('superpowers');
    expect(inst.installPlugin.mock.calls[0][0].sourceCommit).toBeUndefined();
    expect(p.configStore.getPackage('superpowers')?.commit).toBeUndefined();
  });
});

describe('install — a member row installs its bundle', () => {
  const meta = (over: Record<string, unknown>) => ({
    itemType: 'skill', origin: { tier: 'verified' }, scan: { status: 'checked' }, capabilities: [], ...over,
  });

  beforeEach(() => {
    fs.rmSync(CACHE_DIR, { recursive: true, force: true });
    vi.clearAllMocks();
    inst.installPlugin.mockResolvedValue({ status: 'installed' });
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => vi.restoreAllMocks());

  function providerWith(rows: any[]) {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ generated_at: 1, entries: rows }), { status: 200 }));
    const config: any = { version: 2, favorites: [], chips: [], overrides: {}, privateSkills: [], packages: {} };
    const p = makeProvider();
    vi.spyOn(p.configStore, 'load').mockImplementation(() => config);
    vi.spyOn(p.configStore as any, 'save').mockImplementation(() => {});
    return p;
  }

  it('resolves catalog.partOf and installs the bundle id', async () => {
    const member = { ...CATALOG_ROW, id: 'superpowers/brainstorming', displayName: 'Brainstorming',
      catalog: meta({ partOf: { id: 'superpowers', displayName: 'Superpowers' } }) };
    const p = providerWith([CATALOG_ROW, member]);
    const spy = vi.spyOn(p, 'install');
    await p.install('superpowers/brainstorming').catch(() => undefined);
    // Second call is the recursion onto the bundle.
    expect(spy).toHaveBeenNthCalledWith(2, 'superpowers');
    expect(inst.installPlugin.mock.calls[0][0].id).toBe('superpowers');
  });

  it('does not recurse forever on a catalog that points a row at itself', async () => {
    const loop = { ...CATALOG_ROW, id: 'loopy', catalog: meta({ partOf: { id: 'loopy', displayName: 'Loopy' } }) };
    const p = providerWith([loop]);
    const spy = vi.spyOn(p, 'install');
    await p.install('loopy').catch(() => undefined);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses a two-row loop instead of bouncing between them', async () => {
    const a = { ...CATALOG_ROW, id: 'a', catalog: meta({ partOf: { id: 'b', displayName: 'B' } }) };
    const b = { ...CATALOG_ROW, id: 'b', catalog: meta({ partOf: { id: 'a', displayName: 'A' } }) };
    const p = providerWith([a, b]);
    const spy = vi.spyOn(p, 'install');
    const r = await p.install('a');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(r.status).toBe('failed');
    expect(inst.installPlugin).not.toHaveBeenCalled();
  });
});
